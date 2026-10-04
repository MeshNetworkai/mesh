import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { rewardMicros, testConfig, testServer, usd } from './helpers.js';

/** Guest chat on, 3 free messages, small caps; node timeouts generous so the node-served test cannot flake. */
const guestConfig: TokenomicsConfig = {
  ...testConfig,
  guest: { enabled: true, messagesPerDay: 3, maxTokens: 400, maxInputChars: 2000, model: 'mesh/mock' },
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000 },
};

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(config: TokenomicsConfig = guestConfig) {
  const { app } = await testServer({ config });
  apps.push(app);
  const chat = (payload: unknown, ip = '203.0.113.7') => app.inject({ method: 'POST', url: '/v1/guest/chat', payload, remoteAddress: ip });
  const quota = (ip = '203.0.113.7') => app.inject({ method: 'GET', url: '/v1/guest/quota', remoteAddress: ip });
  return { app, chat, quota };
}

function sse(body: string): Array<Record<string, any>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

describe('guest chat', () => {
  it('streams an OpenAI-shaped SSE reply through the mock upstream, no auth, and books the cost to the treasury', async () => {
    const { app, chat } = await boot();
    const r = await chat({ messages: [{ role: 'user', content: 'hello mesh' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.headers['x-guest-remaining']).toBe('2');
    expect(r.headers['x-mesh-route']).toBe('mock');
    expect(r.headers['x-mesh-privacy']).toBe('upstream_zdr'); // network tier, ZDR upstream fallback
    expect(r.headers['x-mesh-served-by']).toBe('upstream (ZDR)');
    const lines = r.body.split('\n\n').filter((l) => l.startsWith('data:'));
    expect(lines.at(-1)).toBe('data: [DONE]');
    const chunks = sse(r.body);
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'mesh/mock' });
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toContain('Hello from the Mesh mock upstream');
    // The final mesh chunk has the same shape /v1/chat/completions emits: usage + mesh (route, privacy, servedBy).
    const last = chunks.at(-1)!;
    expect(last.mesh).toMatchObject({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect(last.usage.cost).toBe(0.001);

    // Treasury paid: a guest_chat row for the upstream cost, visible on /report; nobody's credits moved.
    const tre = app.ctx.db.prepare(`SELECT kind, usd_micros, ref FROM treasury_ledger`).all() as Array<{ kind: string; usd_micros: number; ref: string }>;
    expect(tre).toEqual([{ kind: 'guest_chat', usd_micros: -1000, ref: expect.stringMatching(/^guest:req:\d+$/) }]);
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM credits_ledger`).get()).toEqual({ n: 0 });
    const log = app.ctx.db.prepare(`SELECT wallet, api_key_id, upstream, stream FROM requests_log`).all();
    expect(log).toEqual([{ wallet: 'guest', api_key_id: 0, upstream: 'mock', stream: 1 }]);
    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.treasury.guestChatUsd).toBe(-usd(1000)); // signed like the other treasury kinds: money out
    expect(report.totals.guestChat).toMatchObject({ requests: 1, servedByNetwork: 0, upstreamCostUsd: usd(1000), nodeRewardsUsd: 0, totalCostUsd: usd(1000) });
    expect(report.totals.treasury.balanceUsd).toBe(-usd(1000));
  });

  it('quota: /v1/guest/quota reports it, each message decrements, the limit is a 429 with the wallet nudge, other IPs are unaffected', async () => {
    const { chat, quota } = await boot();
    expect((await quota()).json()).toMatchObject({ remaining: 3, limit: 3, enabled: true });
    expect((await quota()).headers['x-guest-remaining']).toBe('3');

    for (const expected of ['2', '1', '0']) {
      const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-guest-remaining']).toBe(expected);
    }
    expect((await quota()).json()).toMatchObject({ remaining: 0, limit: 3 });

    const blocked = await chat({ messages: [{ role: 'user', content: 'one more' }] });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['x-guest-remaining']).toBe('0');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({ error: 'guest_quota_exhausted', message: 'Connect a wallet to keep chatting' });

    // A different client IP has its own counter.
    const other = await chat({ messages: [{ role: 'user', content: 'hi' }] }, '198.51.100.9');
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-guest-remaining']).toBe('2');
  });

  it('counters live in sqlite and roll over after 24h', async () => {
    const { app, chat, quota } = await boot();
    await chat({ messages: [{ role: 'user', content: 'hi' }] });
    const rows = app.ctx.db.prepare(`SELECT ip_hash, used FROM guest_quota`).all() as Array<{ ip_hash: string; used: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].used).toBe(1);
    expect(rows[0].ip_hash).not.toContain('203.0.113.7'); // hashed, never the raw address
    // Age the window past 24h: the next lookup starts a fresh one.
    app.ctx.db.prepare(`UPDATE guest_quota SET window_start = window_start - 90000`).run();
    expect((await quota()).json().remaining).toBe(3);
  });

  it('validates input: caps max_tokens at the guest limit, rejects long prompts and bad shapes, forwards only messages/model/max_tokens', async () => {
    const { app, chat } = await boot();
    let seen: Record<string, unknown> | null = null;
    const inner = app.ctx.upstream;
    app.ctx.upstream = {
      name: 'mock',
      models: () => inner.models(),
      chat: (body, opts) => {
        seen = body;
        return inner.chat(body, opts);
      },
    };
    const ok = await chat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 9999, temperature: 2, user: 'leak' });
    expect(ok.statusCode).toBe(200);
    expect(seen).toEqual({ model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }], max_tokens: 400, stream: true });

    const long = await chat({ messages: [{ role: 'user', content: 'x'.repeat(2001) }] });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('input_too_long');
    expect((await chat({ messages: [] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'tool', content: 'x' }] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'user', content: ['parts'] }] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'user', content: 'hi' }], model: 7 })).statusCode).toBe(400);
    // Rejected requests never consumed a message: 3 - 1 (the ok one) = 2 left.
    expect((await app.inject({ method: 'GET', url: '/v1/guest/quota', remoteAddress: '203.0.113.7' })).json().remaining).toBe(2);
  });

  it('an upstream failure is reported, not charged, and gives the message back', async () => {
    const { app, chat, quota } = await boot();
    app.ctx.upstream = { name: 'mock', models: async () => Response.json({ data: [] }), chat: async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 503 }) };
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.type).toBe('upstream_error');
    expect((await quota()).json().remaining).toBe(3);
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM treasury_ledger`).get()).toEqual({ n: 0 });
  });

  it('a Mesh node serves guests first (network tier): node reward accrues as normal, report attributes it to guest chat', async () => {
    const { app, chat } = await boot();
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'mac-g', wallet: 'bob', models: ['llama3.1:8b'], chip: 'M3 Max', ramGb: 64, agentVersion: '0.2.0' } });
    expect(reg.statusCode).toBe(200);
    const h = { authorization: `Bearer ${reg.json().nodeToken}` };
    await app.inject({ method: 'POST', url: '/nodes/mac-g/heartbeat', headers: h, payload: { models: ['llama3.1:8b'], busy: false } });

    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hello node' }] });
    const pulled = await app.inject({ method: 'GET', url: '/nodes/mac-g/jobs/next?wait=2000', headers: h });
    expect(pulled.statusCode).toBe(200);
    const job = pulled.json();
    expect(job).toMatchObject({ model: 'llama3.1:8b', maxTokens: 400 });
    expect(job.messages).toEqual([{ role: 'user', content: 'hello node' }]);
    await app.inject({ method: 'POST', url: `/nodes/mac-g/jobs/${job.jobId}/chunk`, headers: h, payload: { seq: 0, delta: 'Hi ' } });
    await app.inject({ method: 'POST', url: `/nodes/mac-g/jobs/${job.jobId}/chunk`, headers: h, payload: { seq: 1, delta: 'guest' } });
    await app.inject({ method: 'POST', url: `/nodes/mac-g/jobs/${job.jobId}/done`, headers: h, payload: { promptTokens: 40, completionTokens: 60, finishReason: 'stop' } });

    const r = await client;
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-mesh-route']).toBe('node:mac-g');
    expect(r.headers['x-mesh-privacy']).toBe('network');
    expect(r.headers['x-guest-remaining']).toBe('2');
    const chunks = sse(r.body);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hi guest');
    const last = chunks.at(-1)!;
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: 'mac-g', privacy: 'network', servedBy: 'network node' });
    expect(last.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 60, total_tokens: 100, cost: 0 }); // free to the guest

    // Node reward accrued to bob exactly as for a paying request; its treasury accrual is the guest's cost.
    const reward = app.ctx.db.prepare(`SELECT wallet, node_id, tokens, usd_micros, status FROM node_rewards`).all();
    expect(reward).toEqual([{ wallet: 'bob', node_id: 'mac-g', tokens: 100, usd_micros: rewardMicros(100), status: 'accrued' }]);
    const kinds = (app.ctx.db.prepare(`SELECT kind FROM treasury_ledger`).all() as Array<{ kind: string }>).map((k) => k.kind);
    expect(kinds).toEqual(['node_reward_accrual']);
    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.guestChat).toMatchObject({ requests: 1, servedByNetwork: 1, tokens: 100, upstreamCostUsd: 0, nodeRewardsUsd: usd(rewardMicros(100)) });
  });

  it('disabled flag: both endpoints are 404 and nothing is counted', async () => {
    const { app, chat, quota } = await boot({ ...guestConfig, guest: { ...guestConfig.guest, enabled: false } });
    expect((await quota()).statusCode).toBe(404);
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'not_found' });
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM guest_quota`).get()).toEqual({ n: 0 });
  });

  it('default config ships guest chat on with 5 messages a day and a 400-token cap', () => {
    expect(testConfig.guest).toMatchObject({ enabled: true, messagesPerDay: 5, maxTokens: 400, maxInputChars: 2000 });
  });

  it('per-IP rate limit applies to guest routes', async () => {
    const { app } = await testServer({ config: guestConfig, env: { V1_RATE_LIMIT: 2 } });
    apps.push(app);
    const hit = () => app.inject({ method: 'GET', url: '/v1/guest/quota', remoteAddress: '192.0.2.1' });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);
  });
});
