import { parseModelPolicy, parseTokenomics, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { JobRelay, uptimePct24h } from '../src/network.js';
import { decideRoute, nodeReputation } from '../src/routing.js';
import { networkCostMicros } from '../src/routes/v1.js';
import { nodeRewardMicros } from '../src/ledger.js';
import { ADMIN, memDb, NETWORK_PRICE_PER_M, NODE_REWARD_PER_M, networkMicros, rewardMicros, testConfig, testServer, usd } from './helpers.js';

/** Filler so a fake node's reported token counts are ones its text can account for (network.ts completionTokenBound / promptTokenBound). */
const PAD = ' '.repeat(2000);

/** Short timeouts so failure paths run in milliseconds. */
const fastConfig: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 300, stallTimeoutMs: 250, jobTimeoutMs: 5000, reputationMinJobs: 5, minSuccessRate: 0.8 },
};

/** Generous timeouts for success paths so a slow CI box cannot trip the first-token timer. */
const calmConfig: TokenomicsConfig = { ...fastConfig, routing: { ...fastConfig.routing, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000 } };

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(config = fastConfig) {
  const { app } = await testServer({ holders: { alice: 10_000 }, config });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const balance = async () => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } })).json().balance.usdMicros as number;
  const chat = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload });
  return { app, jwt, key, balance, chat };
}

/** A fake node agent driven from the test: register, heartbeat, pull, stream, finish. */
async function fakeNode(app: App, opts: { nodeId?: string; wallet?: string; models?: string[]; chip?: string } = {}) {
  const reg = await app.inject({
    method: 'POST',
    url: '/nodes/register',
    payload: { nodeId: opts.nodeId, wallet: opts.wallet ?? 'bob', models: opts.models ?? ['llama3.1:8b'], chip: opts.chip ?? 'M3 Max', ramGb: 64, agentVersion: '0.2.0' },
  });
  expect(reg.statusCode).toBe(200);
  const id = reg.json().nodeId as string;
  const token = reg.json().nodeToken as string;
  const h = { authorization: `Bearer ${token}` };
  return {
    id,
    token,
    headers: h,
    heartbeat: (payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/nodes/${id}/heartbeat`, headers: h, payload }),
    pull: (wait = 1500) => app.inject({ method: 'GET', url: `/nodes/${id}/jobs/next?wait=${wait}`, headers: h }),
    chunk: (jobId: string, seq: number, delta: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/chunk`, headers: h, payload: { seq, delta } }),
    done: (jobId: string, usage: Record<string, unknown> = { promptTokens: 40, completionTokens: 60, finishReason: 'stop' }) =>
      app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/done`, headers: h, payload: usage }),
    fail: (jobId: string, error: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/fail`, headers: h, payload: { error } }),
    stats: () => app.inject({ method: 'GET', url: `/nodes/${id}`, headers: h }),
  };
}

function sse(body: string): Array<Record<string, any>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('node protocol: registration and auth', () => {
  it('register issues a nodeId + bearer token; /nodes/* requires it; ids are generated when omitted', async () => {
    const { app } = await boot();
    const n = await fakeNode(app, {});
    expect(n.id).toMatch(/^node_[0-9a-f]{12}$/);
    expect(n.token).toMatch(/^mesh_nt_/);
    expect((await app.inject({ method: 'GET', url: `/nodes/${n.id}/jobs/next?wait=0` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/nodes/${n.id}/jobs/next?wait=0`, headers: { authorization: 'Bearer mesh_nt_nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/nodes/nope/jobs/next?wait=0`, headers: n.headers })).statusCode).toBe(404);
    expect((await n.pull(0)).statusCode).toBe(204);
    // token hash only in the DB, never the token
    const row = app.ctx.db.prepare(`SELECT token_hash FROM nodes WHERE node_id = ?`).get(n.id) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(n.token);
  });

  it('GET /nodes/:id accepts the node token or the owning wallet session only; GET /me/nodes lists the wallet nodes', async () => {
    const { app, jwt } = await boot();
    const n = await fakeNode(app, { wallet: 'alice', chip: 'M2 Ultra' });
    await fakeNode(app, { wallet: 'alice' });
    const byToken = await n.stats();
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json()).toMatchObject({ nodeId: n.id, wallet: 'alice', status: 'idle', online: true, chip: 'M2 Ultra', jobs24h: 0, earnedUsdTotal: 0, agentVersion: '0.2.0' });
    expect(byToken.json().uptimePct24h).toBeGreaterThan(0);
    const bySession = await app.inject({ method: 'GET', url: `/nodes/${n.id}`, headers: { authorization: `Bearer ${jwt}` } });
    expect(bySession.statusCode).toBe(200);
    const bobJwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'bob' } })).json().token;
    expect((await app.inject({ method: 'GET', url: `/nodes/${n.id}`, headers: { authorization: `Bearer ${bobJwt}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/nodes/${n.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/nodes/ghost`, headers: n.headers })).statusCode).toBe(404);

    const mine = await app.inject({ method: 'GET', url: '/me/nodes', headers: { authorization: `Bearer ${jwt}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().nodes).toHaveLength(2);
    expect(mine.json()).toMatchObject({ wallet: 'alice', earnedUsdTotal: 0, rewardUsdPerMTokens: NODE_REWARD_PER_M });
    expect((await app.inject({ method: 'GET', url: '/me/nodes', headers: { authorization: `Bearer ${bobJwt}` } })).json().nodes).toHaveLength(0);
  });

  it('heartbeats are stored for uptime and pruned to 48h by the maintenance timer, not per heartbeat', async () => {
    const { app } = await boot();
    const n = await fakeNode(app, {});
    const now = nowSec();
    app.ctx.db.prepare(`INSERT INTO heartbeats (node_id, ts, busy) VALUES (?, ?, 0)`).run(n.id, now - 49 * 3600);
    expect((await n.heartbeat({ busy: false, loadAvg: 1.2 })).json()).toMatchObject({ ok: true, heartbeatEverySec: 20, queuedJobs: 0, maxParallel: 1 });
    // the heartbeat itself no longer prunes (one DELETE per heartbeat was write amplification) …
    let rows = app.ctx.db.prepare(`SELECT ts FROM heartbeats WHERE node_id = ? ORDER BY ts`).all(n.id) as Array<{ ts: number }>;
    expect(rows.some((r) => r.ts < now - 48 * 3600)).toBe(true);
    // … the broker's maintenance pass does
    expect(app.ctx.broker.maintain()).toMatchObject({ heartbeatsPruned: 1, jobsReaped: 0 });
    rows = app.ctx.db.prepare(`SELECT ts FROM heartbeats WHERE node_id = ? ORDER BY ts`).all(n.id) as Array<{ ts: number }>;
    expect(rows.every((r) => r.ts >= now - 48 * 3600)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect((app.ctx.db.prepare(`SELECT load_avg FROM nodes WHERE node_id = ?`).get(n.id) as { load_avg: number }).load_avg).toBe(1.2);
  });

  it('uptimePct24h: minute buckets with a heartbeat over the node age (capped at 24h)', () => {
    const db = memDb();
    const now = 1_800_000_000;
    const created = now - 600; // 10 minutes old
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES ('u1','w','','[]',?,?)`).run(created, now);
    // heartbeats every 20s for the first 5 minutes only
    for (let t = created; t < created + 300; t += 20) db.prepare(`INSERT INTO heartbeats (node_id, ts, busy) VALUES ('u1', ?, 0)`).run(t);
    const pct = uptimePct24h(db, { node_id: 'u1', created_at: created }, now);
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThan(60);
    // a node with no heartbeats
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES ('u2','w','','[]',?,?)`).run(now - 86_400 * 3, now);
    expect(uptimePct24h(db, { node_id: 'u2', created_at: now - 86_400 * 3 }, now)).toBe(0);
  });
});

describe('node protocol: end to end', () => {
  it('stream: register -> heartbeat -> client request -> node pulls -> chunks (out of order) -> done -> SSE with mesh usage -> reward + stats', async () => {
    const { app, key, jwt, balance, chat } = await boot(calmConfig);
    const n = await fakeNode(app, { nodeId: 'mac-1', wallet: 'bob', chip: 'M3 Max' });
    await n.heartbeat({ models: ['llama3.1:8b'], busy: false });
    const before = await balance();

    const client = chat({ model: 'llama-3.1-8b', stream: true, max_tokens: 77, temperature: 0.2, messages: [{ role: 'user', content: 'hello node' }] });
    const pulled = await n.pull(2000);
    expect(pulled.statusCode).toBe(200);
    const job = pulled.json();
    // The node sees the Ollama tag, never the client-facing model name or anything about the caller (privacy.test.ts).
    expect(job).toMatchObject({ model: 'llama3.1:8b', maxTokens: 77, params: { temperature: 0.2 }, attempt: 1 });
    expect(job).not.toHaveProperty('requestedModel');
    expect(job.messages).toEqual([{ role: 'user', content: 'hello node' }]);
    expect(job.deadlineMs).toBeGreaterThan(Date.now());
    expect(job.jobId).toMatch(/^job_/);
    // node is busy while the job runs
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json()).toMatchObject({ busy: 1, idle: 0 });

    expect((await n.chunk(job.jobId, 0, 'Hello')).statusCode).toBe(200);
    expect((await n.chunk(job.jobId, 2, '!')).statusCode).toBe(200); // arrives early
    expect((await n.chunk(job.jobId, 1, ' world')).statusCode).toBe(200);
    expect((await n.chunk(job.jobId, 1, ' world')).statusCode).toBe(200); // duplicate ignored
    expect((await n.chunk(job.jobId, 3, PAD)).statusCode).toBe(200);
    expect((await n.done(job.jobId, { promptTokens: 40, completionTokens: 60, finishReason: 'stop' })).statusCode).toBe(200);

    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-mesh-route']).toBe('node:mac-1');
    const events = sse(res.body);
    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe(`Hello world!${PAD}`);
    expect(events[0].choices[0].delta.role).toBe('assistant');
    const last = events[events.length - 1];
    expect(last.choices[0].finish_reason).toBe('stop');
    // 100 total tokens at the flat network price (requestPricing.networkPricePerMTokens) -> whole micro-USD, so the test stays exact
    const cost = networkMicros(100);
    const reward = rewardMicros(100);
    expect(cost).toBe(100 * NETWORK_PRICE_PER_M);
    expect(reward).toBe(100 * NODE_REWARD_PER_M);
    expect(cost).toBeGreaterThan(reward); // the user price covers the node reward; the difference is the engine-2 margin
    expect(last.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 60, total_tokens: 100, cost: usd(cost) });
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: 'mac-1', chip: 'M3 Max', jobId: job.jobId });
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);

    // pricing: 100 tokens * networkPricePerMTokens charged to alice
    expect(before - (await balance())).toBe(cost);
    const req = app.ctx.db.prepare(`SELECT upstream, model, prompt_tokens, completion_tokens, cost_usd_micros, stream FROM requests_log`).get() as Record<string, unknown>;
    expect(req).toEqual({ upstream: 'node:mac-1', model: 'llama-3.1-8b', prompt_tokens: 40, completion_tokens: 60, cost_usd_micros: cost, stream: 1 });
    // node reward: 100 tokens * nodeRewards.usdPerMTokens to bob
    const rewardRow = app.ctx.db.prepare(`SELECT wallet, node_id, job_id, kind, tokens, usd_micros FROM node_rewards`).get();
    expect(rewardRow).toEqual({ wallet: 'bob', node_id: 'mac-1', job_id: job.jobId, kind: 'node_reward', tokens: 100, usd_micros: reward });
    const jobRow = app.ctx.db.prepare(`SELECT status, node_id, prompt_tokens, completion_tokens, finish_reason, first_chunk_ms, claimed_ms FROM jobs`).get() as Record<string, number | string>;
    expect(jobRow).toMatchObject({ status: 'done', node_id: 'mac-1', prompt_tokens: 40, completion_tokens: 60, finish_reason: 'stop' });
    expect(jobRow.first_chunk_ms as number).toBeGreaterThanOrEqual(jobRow.claimed_ms as number);

    // late chunks for a finished job are refused
    expect((await n.chunk(job.jobId, 3, 'late')).statusCode).toBe(409);

    // stats
    const stats = (await n.stats()).json();
    expect(stats).toMatchObject({ status: 'idle', jobs24h: 1, jobsDone24h: 1, tokens24h: 100, earnedUsd24h: usd(reward), earnedUsdTotal: usd(reward) });
    expect(stats.reputation).toMatchObject({ jobs: 1, successRate: 1, eligible: true });
    expect(stats.reputation.avgFirstTokenMs).toBeGreaterThanOrEqual(0);
    const bobJwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'bob' } })).json().token;
    const mine = (await app.inject({ method: 'GET', url: '/me/nodes', headers: { authorization: `Bearer ${bobJwt}` } })).json();
    expect(mine.earnedUsdTotal).toBe(usd(reward));
    expect(mine.nodes[0].nodeId).toBe('mac-1');
    const summary = (await app.inject({ method: 'GET', url: '/nodes' })).json();
    expect(summary).toMatchObject({ online: 1, busy: 0, idle: 1, jobs24h: 1, servedByNetwork24h: 1, tokens24h: 100, servedByNetworkPercent: 100 });
    const pub = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(pub).toMatchObject({ servedByNetworkPercent: 100, servedByNetwork24h: 1, jobs24h: 1, networkTokens24h: 100, networkPricePerMTokens: NETWORK_PRICE_PER_M });
    expect(pub.requestsLast24h).toBe(1);
    // a key usage view also sees the request
    const keys = (await app.inject({ method: 'GET', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json();
    expect(keys.keys?.[0]?.spentUsd ?? keys[0]?.spentUsd).toBe(usd(cost));
    void key;
  });

  it('non-stream: JSON completion assembled from chunks with mesh + usage and route headers', async () => {
    const { app, chat, balance } = await boot(calmConfig);
    const n = await fakeNode(app, { nodeId: 'mac-2' });
    const before = await balance();
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: `hi${PAD}` }] });
    const job = (await n.pull()).json();
    await n.chunk(job.jobId, 0, 'A');
    await n.chunk(job.jobId, 1, 'B');
    await n.chunk(job.jobId, 2, PAD);
    await n.done(job.jobId, { promptTokens: 100, completionTokens: 100, finishReason: 'length' });
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('node:mac-2');
    const cost = networkMicros(200); // 200 total tokens at the flat network price (4 micro-USD at $0.02/M)
    expect(cost).toBeGreaterThan(0);
    expect(res.headers['x-mesh-cost-usd']).toBe(String(usd(cost)));
    const j = res.json();
    expect(j.object).toBe('chat.completion');
    expect(j.model).toBe('llama-3.1-8b');
    expect(j.choices[0]).toMatchObject({ message: { role: 'assistant', content: `AB${PAD}` }, finish_reason: 'length' });
    expect(j.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, cost: usd(cost) });
    expect(j.mesh).toMatchObject({ route: 'node', nodeId: 'mac-2', chip: 'M3 Max' });
    expect(before - (await balance())).toBe(cost);
  });

  it('long-poll: 204 after `wait` with nothing queued; a job created mid-wait is delivered immediately', async () => {
    const { app, chat } = await boot(calmConfig);
    const n = await fakeNode(app, { nodeId: 'mac-3' });
    const t0 = Date.now();
    expect((await n.pull(150)).statusCode).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect((await app.inject({ method: 'GET', url: `/nodes/${n.id}/jobs/next?wait=99999`, headers: n.headers })).statusCode).toBe(400);

    const poll = n.pull(3000);
    await sleep(50);
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const pulled = await poll;
    expect(pulled.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2500);
    await n.chunk(pulled.json().jobId, 0, 'ok');
    await n.done(pulled.json().jobId);
    expect((await client).statusCode).toBe(200);
  });

  it('atomic claim: two nodes polling, one job -> exactly one node gets it; the other gets the next', async () => {
    const { app, chat } = await boot(calmConfig);
    const a = await fakeNode(app, { nodeId: 'mac-a' });
    const b = await fakeNode(app, { nodeId: 'mac-b' });
    const pa = a.pull(600);
    const pb = b.pull(600);
    await sleep(30);
    const c1 = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'one' }] });
    const [ra, rb] = await Promise.all([pa, pb]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 204]);
    const winner = ra.statusCode === 200 ? a : b;
    const loser = winner === a ? b : a;
    const job1 = (ra.statusCode === 200 ? ra : rb).json();
    expect((app.ctx.db.prepare(`SELECT node_id FROM jobs WHERE job_id = ?`).get(job1.jobId) as { node_id: string }).node_id).toBe(winner.id);
    // the loser cannot act on the winner's job
    expect((await loser.chunk(job1.jobId, 0, 'x')).statusCode).toBe(409);
    expect((await loser.done(job1.jobId)).statusCode).toBe(409);
    // winner is busy, so a second request must go to the loser
    const c2 = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'two' }] });
    const r2 = await loser.pull(1000);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().jobId).not.toBe(job1.jobId);
    await winner.chunk(job1.jobId, 0, 'one');
    await winner.done(job1.jobId);
    await loser.chunk(r2.json().jobId, 0, 'two');
    await loser.done(r2.json().jobId);
    const [x1, x2] = await Promise.all([c1, c2]);
    expect(x1.json().choices[0].message.content).toBe('one');
    expect(x1.headers['x-mesh-route']).toBe(`node:${winner.id}`);
    expect(x2.json().choices[0].message.content).toBe('two');
    expect(x2.headers['x-mesh-route']).toBe(`node:${loser.id}`);
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json()).toMatchObject({ busy: 0, idle: 2, jobs24h: 2, servedByNetwork24h: 2 });
  });
});

describe('node protocol: failure handling', () => {
  it('first-token timeout with no other node -> transparent fallback to the upstream, node blamed, late chunk refused, charged once', async () => {
    const { app, chat, balance } = await boot();
    const n = await fakeNode(app, { nodeId: 'slow' });
    const before = await balance();
    const client = chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const job = (await n.pull()).json();
    // node claimed but never streams
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('mock');
    expect(res.headers['x-mesh-fallback']).toBe('first_token_timeout');
    const events = sse(res.body);
    expect(events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('')).toContain('Mesh mock upstream');
    // Upstream-served: the final chunk says so (no node fields).
    expect(events[events.length - 1].mesh).toMatchObject({ route: 'mock', privacy: 'network', servedBy: 'upstream' });
    expect(events[events.length - 1].mesh.nodeId).toBeUndefined();
    expect(app.ctx.db.prepare(`SELECT status, error, node_fault FROM jobs WHERE job_id = ?`).get(job.jobId)).toEqual({ status: 'fallback', error: 'first_token_timeout', node_fault: 1 });
    expect((await n.chunk(job.jobId, 0, 'too late')).statusCode).toBe(409);
    expect((await n.done(job.jobId)).statusCode).toBe(409);
    // charged exactly once, by the mock upstream price, no node reward
    expect(before - (await balance())).toBe(1000);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n, MIN(upstream) AS u FROM requests_log`).get() as { n: number; u: string })).toEqual({ n: 1, u: 'mock' });
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM node_rewards`).get() as { n: number }).n).toBe(0);
    // node is free again
    expect((await n.stats()).json()).toMatchObject({ status: 'idle', jobs24h: 1, jobsDone24h: 1 - 1, jobsFailed24h: 0 });
    expect((await n.stats()).json().reputation).toMatchObject({ jobs: 1, successRate: 0 });
  });

  it('non-stream fallback also works (nothing was sent) and the error is not surfaced', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'slow2' });
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    await n.pull();
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('mock');
    expect(res.json().choices[0].message.content).toContain('Mesh mock upstream');
    expect(res.json().mesh).toMatchObject({ route: 'mock', privacy: 'network', servedBy: 'upstream' });
    expect((app.ctx.db.prepare(`SELECT status FROM jobs`).get() as { status: string }).status).toBe('fallback');
  });

  it('node reports /fail before any output -> fallback with the node error as reason', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'broken' });
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const job = (await n.pull()).json();
    expect((await n.fail(job.jobId, 'ollama: model not loaded')).statusCode).toBe(200);
    expect((await n.fail(job.jobId, 'again')).statusCode).toBe(409);
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('mock');
    expect(res.headers['x-mesh-fallback']).toContain('node_error');
    expect(app.ctx.db.prepare(`SELECT status, node_fault FROM jobs`).get()).toEqual({ status: 'fallback', node_fault: 1 });
  });

  it('re-queues once to another node when the first one times out; second node serves the client', async () => {
    const { app, chat, balance } = await boot();
    const a = await fakeNode(app, { nodeId: 'flaky' });
    const b = await fakeNode(app, { nodeId: 'solid', chip: 'M2 Ultra' });
    const before = await balance();
    const client = chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const first = (await a.pull()).json();
    // b must not be able to claim a's job; it waits for the re-queued one
    const pb = b.pull(2000);
    const second = await pb;
    expect(second.statusCode).toBe(200);
    expect(second.json().jobId).not.toBe(first.jobId);
    expect(second.json().attempt).toBe(2);
    expect((app.ctx.db.prepare(`SELECT parent_job_id, exclude_node_id FROM jobs WHERE job_id = ?`).get(second.json().jobId))).toEqual({ parent_job_id: first.jobId, exclude_node_id: 'flaky' });
    await b.chunk(second.json().jobId, 0, 'served by b');
    await b.chunk(second.json().jobId, 1, PAD);
    await b.done(second.json().jobId, { promptTokens: 50, completionTokens: 50, finishReason: 'stop' });
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('node:solid');
    const events = sse(res.body);
    expect(events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('')).toBe(`served by b${PAD}`);
    expect(events[events.length - 1].mesh).toMatchObject({ route: 'node', nodeId: 'solid', chip: 'M2 Ultra', attempt: 2 });
    const rows = app.ctx.db.prepare(`SELECT node_id, status, node_fault FROM jobs ORDER BY created_ms`).all();
    expect(rows).toEqual([
      { node_id: 'flaky', status: 'failed', node_fault: 1 },
      { node_id: 'solid', status: 'done', node_fault: 0 },
    ]);
    // only the successful attempt is billed and rewarded: 100 tokens at the network price / node reward
    expect(networkMicros(100)).toBeGreaterThan(0);
    expect(before - (await balance())).toBe(networkMicros(100));
    expect((app.ctx.db.prepare(`SELECT wallet, usd_micros FROM node_rewards`).all())).toEqual([{ wallet: 'bob', usd_micros: rewardMicros(100) }]);
    // a's late chunk is refused and a is idle again
    expect((await a.chunk(first.jobId, 0, 'late')).statusCode).toBe(409);
    expect((await a.stats()).json().status).toBe('idle');
  });

  it('no fallback after partial output: the stall is surfaced in-stream and nothing is charged', async () => {
    const { app, chat, balance } = await boot();
    const n = await fakeNode(app, { nodeId: 'stall' });
    await fakeNode(app, { nodeId: 'backup' }); // another node exists, but a retry would duplicate output
    const before = await balance();
    const client = chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const job = (await n.pull()).json();
    await n.chunk(job.jobId, 0, 'partial ');
    // ... then nothing: stallTimeoutMs elapses
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('node:stall');
    expect(res.headers['x-mesh-fallback']).toBeUndefined();
    const events = sse(res.body);
    expect(events[0].choices[0].delta.content).toBe('partial ');
    const last = events[events.length - 1];
    expect(last.error).toMatchObject({ code: 'node_stream_failed', type: 'upstream_error' });
    expect(last.error.message).toContain('stall_timeout');
    expect(last.choices[0].finish_reason).toBe('error');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(app.ctx.db.prepare(`SELECT status, error, node_fault FROM jobs`).all()).toEqual([{ status: 'failed', error: 'stall_timeout', node_fault: 1 }]);
    expect(await balance()).toBe(before);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log`).get() as { n: number }).n).toBe(0);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM node_rewards`).get() as { n: number }).n).toBe(0);
    const err = app.ctx.db.prepare(`SELECT code FROM errors_log`).get() as { code: string };
    expect(err.code).toBe('node_stream_failed');
    expect((await n.done(job.jobId)).statusCode).toBe(409);
  });

  it('node /fail after partial output is surfaced too (no retry even with a backup node)', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'crash' });
    await fakeNode(app, { nodeId: 'backup2' });
    const client = chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const job = (await n.pull()).json();
    await n.chunk(job.jobId, 0, 'x');
    await n.fail(job.jobId, 'OOM');
    const res = await client;
    const last = sse(res.body).pop()!;
    expect(last.error.message).toContain('OOM');
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(1);
  });

  it('jobs left queued/running by a previous process are failed on boot', async () => {
    const db = memDb();
    const t = Date.now();
    db.prepare(
      `INSERT INTO jobs (job_id, model, tag, wallet, status, payload, max_tokens, deadline_ms, created_at, created_ms) VALUES ('job_old','m','t','alice','running','{}',10,?,?,?)`,
    ).run(t + 60_000, Math.floor(t / 1000), t);
    const { app } = await testServer({ context: { db } });
    apps.push(app);
    expect(db.prepare(`SELECT status, error FROM jobs WHERE job_id = 'job_old'`).get()).toEqual({ status: 'failed', error: 'deadline_exceeded' });
  });
});

describe('reputation', () => {
  function seedJobs(app: App, nodeId: string, outcomes: Array<'done' | 'failed'>, firstTokenMs = 100) {
    const base = Date.now() - 60_000;
    outcomes.forEach((o, i) => {
      const created = base + i * 10;
      app.ctx.db
        .prepare(
          `INSERT INTO jobs (job_id, model, tag, wallet, status, payload, max_tokens, deadline_ms, node_id, node_fault, prompt_tokens, completion_tokens, created_at, created_ms, claimed_ms, first_chunk_ms, finished_ms)
           VALUES (?, 'llama-3.1-8b', 'llama3.1:8b', 'alice', ?, '{}', 10, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
        )
        .run(`job_seed_${nodeId}_${i}`, o, created + 60_000, nodeId, o === 'failed' ? 1 : 0, Math.floor(created / 1000), created, created + 5, o === 'done' ? created + 5 + firstTokenMs : null, created + 500);
    });
  }

  it('score = success rate + avg first-token latency over the last 100 scored jobs; client-fault failures do not count', async () => {
    const { app } = await boot();
    const n = await fakeNode(app, { nodeId: 'rep' });
    seedJobs(app, 'rep', ['done', 'done', 'done', 'failed'], 120);
    // a client-side failure (node_fault = 0) is ignored
    app.ctx.db.prepare(`UPDATE jobs SET node_fault = 0 WHERE job_id = 'job_seed_rep_3'`).run();
    let rep = nodeReputation(app.ctx.db, 'rep', fastConfig.routing);
    expect(rep).toMatchObject({ jobs: 3, done: 3, failed: 0, successRate: 1, avgFirstTokenMs: 120, eligible: true });
    app.ctx.db.prepare(`UPDATE jobs SET node_fault = 1 WHERE job_id = 'job_seed_rep_3'`).run();
    rep = nodeReputation(app.ctx.db, 'rep', fastConfig.routing);
    expect(rep).toMatchObject({ jobs: 4, done: 3, failed: 1, successRate: 0.75, eligible: true }); // below 80% but under reputationMinJobs
    const view = (await n.stats()).json();
    expect(view.reputation).toMatchObject({ jobs: 4, successRate: 0.75, avgFirstTokenMs: 120, eligible: true, window: 100, minSuccessRate: 0.8 });
    // only the last 100 jobs count
    seedJobs(app, 'rep100', Array.from({ length: 120 }, (_, i) => (i < 20 ? 'failed' : 'done')));
    expect(nodeReputation(app.ctx.db, 'rep100', fastConfig.routing)).toMatchObject({ jobs: 100, successRate: 1 });
  });

  it('nodes under 80% success (with enough history) are excluded from routing and from pulling; a good node still gets the job', async () => {
    const { app, chat } = await boot(calmConfig);
    const bad = await fakeNode(app, { nodeId: 'bad' });
    seedJobs(app, 'bad', ['done', 'failed', 'failed', 'failed', 'done']); // 40%
    expect((await bad.stats()).json().reputation).toMatchObject({ jobs: 5, successRate: 0.4, eligible: false });
    expect(decideRoute(app.ctx, 'llama-3.1-8b').reason).toBe('no_online_node');
    // with only the bad node online the request goes straight to the upstream, no job created
    const r = await chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.headers['x-mesh-route']).toBe('mock');
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE job_id NOT LIKE 'job_seed_%'`).get() as { n: number }).n).toBe(0);
    // a reputable node joins: it gets the job, the bad node's poll stays empty
    const good = await fakeNode(app, { nodeId: 'good' });
    expect(decideRoute(app.ctx, 'llama-3.1-8b')).toMatchObject({ target: 'node', candidates: ['good'] });
    const badPoll = bad.pull(400);
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const pulled = await good.pull();
    expect(pulled.statusCode).toBe(200);
    expect((await badPoll).statusCode).toBe(204);
    await good.chunk(pulled.json().jobId, 0, 'ok');
    await good.done(pulled.json().jobId);
    expect((await client).headers['x-mesh-route']).toBe('node:good');
  });
});

describe('config + helpers', () => {
  it('tokenomics schema: network price, node rewards and routing timeouts default', () => {
    const raw = JSON.parse(JSON.stringify(testConfig)) as Record<string, any>;
    delete raw.requestPricing.networkPricePerMTokens;
    delete raw.nodeRewards;
    raw.routing = { preferNetwork: true };
    const c = parseTokenomics(raw);
    // schema defaults match the shipped config, so a missing key cannot silently reprice the network
    expect(c.requestPricing.networkPricePerMTokens).toBe(testConfig.requestPricing.networkPricePerMTokens);
    expect(c.nodeRewards.usdPerMTokens).toBe(testConfig.nodeRewards.usdPerMTokens);
    expect(c.requestPricing.networkPricePerMTokens).toBe(0.08);
    expect(c.nodeRewards.usdPerMTokens).toBe(0.06);
    expect(c.routing).toEqual({ preferNetwork: true, firstTokenTimeoutMs: 8000, stallTimeoutMs: 6000, jobTimeoutMs: 120_000, defaultMaxTokens: 1024, nodeMaxTokens: 8192, upstreamDefaultMaxTokens: 8192, minSuccessRate: 0.8, reputationMinJobs: 5, queueWaitMs: 6000, maxQueueDepthPerNode: 3, maxParallelPerNode: 4 });
    expect(() => parseTokenomics({ ...raw, nodeRewards: { usdPerMTokens: -1 } })).toThrow();
    expect(networkCostMicros(1_000_000, 0.02)).toBe(20_000);
    expect(nodeRewardMicros(1_000_000, 0.06)).toBe(60_000);
    expect(networkCostMicros(1_000_000, NETWORK_PRICE_PER_M)).toBe(NETWORK_PRICE_PER_M * 1_000_000);
    expect(networkCostMicros(30, 0.02)).toBe(1); // rounds up to whole micro-USD
    expect(networkCostMicros(3, 0.02)).toBe(1); // never free: at least one micro-USD for any output
    expect(networkCostMicros(0, 0.02)).toBe(0);
  });

  it('model policy: networkModels map (or legacy array) resolves tags; /v1/models lists network names', async () => {
    const map = parseModelPolicy({ networkModels: { 'llama-3.1-8b': 'llama3.1:8b', 'qwen-*': 'qwen2.5:7b' } });
    expect(map.networkModels).toEqual({ 'llama-3.1-8b': 'llama3.1:8b', 'qwen-*': 'qwen2.5:7b' });
    const legacy = parseModelPolicy({ networkModels: ['mesh/mock'] });
    expect(legacy.networkModels).toEqual({ 'mesh/mock': 'mesh/mock' });
    const { app, key } = await boot(calmConfig);
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } });
    const ids = r.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain('mesh/mock');
    expect(ids).toContain('llama-3.1-8b');
    const net = r.json().data.find((m: { id: string }) => m.id === 'llama-3.1-8b');
    expect(net).toMatchObject({ mesh_network: true, owned_by: 'mesh' });
  });

  it('JobRelay orders chunks by seq, drops duplicates, times out, and ignores pushes after close', async () => {
    const relay = new JobRelay();
    relay.push({ type: 'chunk', seq: 1, delta: 'b' });
    expect(await relay.next(50)).toEqual({ type: 'timeout' });
    relay.push({ type: 'chunk', seq: 0, delta: 'a' });
    expect(await relay.next(50)).toEqual({ type: 'chunk', seq: 0, delta: 'a' });
    expect(await relay.next(50)).toEqual({ type: 'chunk', seq: 1, delta: 'b' });
    relay.push({ type: 'chunk', seq: 0, delta: 'dup' });
    expect(await relay.next(20)).toEqual({ type: 'timeout' });
    const pending = relay.next(1000);
    relay.push({ type: 'done', usage: { promptTokens: 1, completionTokens: 1, finishReason: 'stop' } });
    expect((await pending).type).toBe('done');
    relay.close();
    relay.push({ type: 'chunk', seq: 2, delta: 'late' });
    expect(await relay.next(20)).toEqual({ type: 'timeout' });
    expect(relay.chunks).toBe(2);
  });
});
