import { afterEach, describe, expect, it } from 'vitest';
import { Reservations, planSpend, reservePrice, walletHold } from '../src/reserve.js';
import { SseUsageScanner, estimateUsage, type ChatOptions, type Upstream } from '../src/upstream.js';
import { ADMIN, grantCredit, testConfig, testServer } from './helpers.js';

/**
 * Balance reservation (reserve.ts) and billing of streams that end without a usage chunk (relay.ts):
 * a request is bounded by what the wallet can still afford, concurrent requests cannot spend the same
 * credit twice, and hanging up before the final chunk is not a free answer.
 */

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'anthropic/claude-sonnet-4.5'; // $3 / $15 per M in config/model-prices.json

/** Upstream that records the body it was sent and answers when the test says so. */
class GatedUpstream implements Upstream {
  readonly name = 'mock' as const;
  bodies: Array<Record<string, unknown>> = [];
  private gate: Promise<void>;
  open!: () => void;
  constructor(private costUsd = 0.001) {
    this.gate = new Promise((r) => (this.open = r));
  }
  async chat(body: Record<string, unknown>, _opts: ChatOptions = {}): Promise<Response> {
    this.bodies.push(body);
    await this.gate;
    return Response.json({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: this.costUsd } });
  }
  async models(): Promise<Response> {
    return Response.json({ object: 'list', data: [] });
  }
}

/** Upstream that streams `words` content chunks and never sends usage (what a cut-off stream looks like). */
class NoUsageUpstream implements Upstream {
  readonly name = 'mock' as const;
  finished = false;
  constructor(
    private words: number,
    private delayMs: number,
  ) {}
  async chat(body: Record<string, unknown>): Promise<Response> {
    const enc = new TextEncoder();
    const { words, delayMs } = this;
    const done = () => (this.finished = true);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < words; i++) {
          if (delayMs) await sleep(delayMs);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'word ' }, finish_reason: null }] })}\n\n`));
        }
        done();
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  async models(): Promise<Response> {
    return Response.json({ object: 'list', data: [] });
  }
}

async function boot(upstream: Upstream, creditUsd: number) {
  const { app } = await testServer({ holders: { alice: 10_000 }, context: { upstream } });
  apps.push(app);
  grantCredit(app.ctx.db, 'alice', creditUsd);
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const balance = async () => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } })).json().balance.usdMicros as number;
  const chat = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload });
  return { app, jwt, key, balance, chat };
}

describe('Reservations', () => {
  it('holds add up per key and release exactly once', () => {
    const r = new Reservations();
    const a = r.hold(['w:x', 'k:1'], 100);
    const b = r.hold(['w:x'], 50);
    expect(r.reserved('w:x')).toBe(150);
    expect(r.reserved('k:1')).toBe(100);
    a();
    a();
    expect(r.reserved('w:x')).toBe(50);
    expect(r.reserved('k:1')).toBe(0);
    b();
    expect(r.reserved('w:x')).toBe(0);
  });
});

describe('planSpend', () => {
  const ctx = { config: testConfig, prices: { default: { promptUsdPerM: 1, completionUsdPerM: 3 }, models: { [MODEL]: { promptUsdPerM: 3, completionUsdPerM: 15 } } }, policy: { allow: [], deny: [], networkModels: {} } } as unknown as Parameters<typeof planSpend>[0];
  const body = (extra: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...extra });

  it('lowers max_tokens to what the balance affords and reserves no more than is available', () => {
    const plan = planSpend(ctx, body({ max_tokens: 1_000_000 }), MODEL, 150_000)!; // $0.15 at $15/M ≈ 10k tokens
    expect(plan.upstreamMaxTokens).toBeGreaterThan(9_000);
    expect(plan.upstreamMaxTokens).toBeLessThanOrEqual(10_000);
    expect(plan.reserveMicros).toBeLessThanOrEqual(150_000);
    expect(plan.maxTokensField).toBe('max_tokens');
  });

  it('uses the upstream default cap when the client sets none, and keeps a smaller explicit one', () => {
    expect(planSpend(ctx, body(), MODEL, 10_000_000)!.upstreamMaxTokens).toBe(testConfig.routing.upstreamDefaultMaxTokens);
    const small = planSpend(ctx, body({ max_completion_tokens: 100 }), MODEL, 10_000_000)!;
    expect(small.upstreamMaxTokens).toBe(100);
    expect(small.maxTokensField).toBe('max_completion_tokens');
    expect(small.reserveMicros).toBeLessThan(2_000); // 100 tokens at $15/M + a tiny prompt
  });

  it('counts n choices and refuses when not even one token is affordable', () => {
    const one = planSpend(ctx, body({ max_tokens: 1000 }), MODEL, 10_000_000)!;
    const four = planSpend(ctx, body({ max_tokens: 1000, n: 4 }), MODEL, 10_000_000)!;
    expect(four.reserveMicros).toBeGreaterThan(one.reserveMicros * 3);
    expect(planSpend(ctx, body(), MODEL, 10)).toBeNull();
  });

  it('prices a model missing from the table like the dearest listed one', () => {
    expect(reservePrice(ctx, 'vendor/unlisted').completionUsdPerM).toBe(15);
  });
});

describe('/v1/chat/completions reserves before it serves', () => {
  it('concurrent requests cannot spend the same credit twice', async () => {
    const upstream = new GatedUpstream();
    const { app, chat } = await boot(upstream, 0.1); // $0.10: 4096 tokens of this model reserve ≈ $0.06
    const payload = { model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] };
    const first = chat(payload);
    await sleep(50);
    expect(app.ctx.reservations.reserved(walletHold('alice'))).toBeGreaterThan(60_000);
    const second = chat(payload); // only ≈ $0.04 is left: served, with a lower cap
    await sleep(50);
    const third = await chat(payload); // nothing left to hold
    expect(third.statusCode).toBe(402);
    expect(third.json().error.code).toBe('insufficient_quota');
    upstream.open();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(upstream.bodies[0].max_tokens).toBe(4096);
    expect(upstream.bodies[1].max_tokens as number).toBeLessThan(4096);
    expect(app.ctx.reservations.reserved(walletHold('alice'))).toBe(0);
  });

  it('a request with no max_tokens is sent upstream with one', async () => {
    const upstream = new GatedUpstream();
    upstream.open();
    const { chat } = await boot(upstream, 50);
    expect((await chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })).statusCode).toBe(200);
    expect(upstream.bodies[0].max_tokens).toBe(testConfig.routing.upstreamDefaultMaxTokens);
  });

  it('a key spend limit bounds the request the same way', async () => {
    const upstream = new GatedUpstream();
    upstream.open();
    const { app, jwt, chat } = await boot(upstream, 50);
    const id = (await app.inject({ method: 'GET', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().keys[0].id as number;
    await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { authorization: `Bearer ${jwt}` }, payload: { spendLimitUsd: 0.015 } });
    expect((await chat({ model: MODEL, max_tokens: 100_000, messages: [{ role: 'user', content: 'hi' }] })).statusCode).toBe(200);
    expect(upstream.bodies[0].max_tokens as number).toBeLessThanOrEqual(1000); // $0.015 at $15/M
  });

  it('credit held by a request in flight cannot be listed on the market', async () => {
    const upstream = new GatedUpstream();
    const { app, jwt, chat } = await boot(upstream, 2);
    const inflight = chat({ model: MODEL, max_tokens: 100_000, messages: [{ role: 'user', content: 'hi' }] }); // reserves ≈ $1.50
    await sleep(50);
    const list = (amountUsd: number) => app.inject({ method: 'POST', url: '/market/listings', headers: { authorization: `Bearer ${jwt}` }, payload: { amountUsd, discountBps: 1000 } });
    expect((await list(2)).statusCode).toBe(402);
    upstream.open();
    await inflight;
    expect((await list(1)).statusCode).toBe(201);
  });
});

describe('streams that end without a usage chunk are billed', () => {
  it('estimateUsage and the scanner count what was relayed', () => {
    const s = new SseUsageScanner();
    s.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'abcd' } }] })}\n\n`);
    s.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'efgh', content: 'ij' } }] })}\n\n`);
    expect(s.completionChars).toBe(10);
    const u = estimateUsage({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }, 4000);
    expect(u.completion_tokens).toBe(1000);
    expect(u.prompt_tokens).toBeGreaterThan(100);
  });

  it('a client that hangs up mid-stream is charged for the whole generation', async () => {
    const upstream = new NoUsageUpstream(40, 20); // 40 × "word " = 200 chars ≈ 50 tokens, 0.8 s
    const { app, key, balance } = await boot(upstream, 1);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const before = await balance();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 500, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    await res.body!.getReader().read();
    ac.abort();
    const deadline = Date.now() + 4000;
    let row: { completion_tokens: number; cost_usd_micros: number } | undefined;
    while (Date.now() < deadline && !row) {
      row = app.ctx.db.prepare(`SELECT completion_tokens, cost_usd_micros FROM requests_log`).get() as typeof row;
      if (!row) await sleep(25);
    }
    expect(upstream.finished).toBe(true); // drained to the end, not cancelled
    expect(row!.completion_tokens).toBe(50);
    expect(row!.cost_usd_micros).toBeGreaterThanOrEqual(750); // 50 tokens at $15/M
    expect(await balance()).toBe(before - row!.cost_usd_micros);
    expect(app.ctx.reservations.reserved(walletHold('alice'))).toBe(0);
  });
});

describe('node usage is measured against the text the gateway saw; own requests earn nothing', () => {
  async function node(app: App, nodeId: string, wallet: string) {
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId, wallet, models: ['llama3.1:8b'], chip: 'M3', ramGb: 32, agentVersion: '0.2.0' } });
    const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
    return {
      /** Pull one job, answer it with `text`, and claim `claimed` tokens each way. */
      serve: async (text: string, claimed: number) => {
        const job = (await app.inject({ method: 'GET', url: `/nodes/${nodeId}/jobs/next?wait=2000`, headers: h })).json();
        await app.inject({ method: 'POST', url: `/nodes/${nodeId}/jobs/${job.jobId}/chunk`, headers: h, payload: { seq: 0, delta: text } });
        await app.inject({ method: 'POST', url: `/nodes/${nodeId}/jobs/${job.jobId}/done`, headers: h, payload: { promptTokens: claimed, completionTokens: claimed, finishReason: 'stop' } });
        return job as { maxTokens: number };
      },
    };
  }
  const rewards = (app: App) => app.ctx.db.prepare(`SELECT wallet, tokens, usd_micros FROM node_rewards ORDER BY id`).all() as Array<{ wallet: string; tokens: number; usd_micros: number }>;

  it('one character cannot be billed as millions of tokens, and max_tokens is capped for a node job', async () => {
    const { app, chat, balance } = await boot(new GatedUpstream(), 5);
    const n = await node(app, 'mac-liar', 'bob');
    const before = await balance();
    const client = chat({ model: 'llama-3.1-8b', max_tokens: 10_000_000, messages: [{ role: 'user', content: 'hi' }] });
    const job = await n.serve('x', 10_000_000);
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(job.maxTokens).toBe(testConfig.routing.nodeMaxTokens);
    const usage = res.json().usage as { prompt_tokens: number; completion_tokens: number };
    expect(usage.completion_tokens).toBe(9); // 1 byte → ceil(1/2) + 8
    expect(usage.prompt_tokens).toBe(81); // 2 bytes, 1 message → 1 + 16 + 64
    expect(before - (await balance())).toBeLessThan(10); // micro-dollars, not the $0.80 the claim asked for
  });

  it('a node serving its own wallet is billed like anyone else and earns no reward; another wallet earns as before', async () => {
    const { app, chat, balance } = await boot(new GatedUpstream(), 5);
    const text = 'a reasonably long answer '.repeat(40); // 1000 bytes
    const mine = await node(app, 'mac-own', 'alice');
    const before = await balance();
    let client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    await mine.serve(text, 80);
    expect((await client).statusCode).toBe(200);
    expect(await balance()).toBeLessThan(before);
    expect(rewards(app)).toEqual([{ wallet: 'alice', tokens: 160, usd_micros: 0 }]);
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM treasury_ledger WHERE kind = 'node_reward_accrual'`).get()).toEqual({ n: 0 });

    app.ctx.db.prepare(`UPDATE nodes SET busy = 1 WHERE node_id = 'mac-own'`).run();
    const other = await node(app, 'mac-other', 'bob');
    client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    await other.serve(text, 80);
    expect((await client).statusCode).toBe(200);
    expect(rewards(app)[1]).toMatchObject({ wallet: 'bob', tokens: 160 });
    expect(rewards(app)[1].usd_micros).toBeGreaterThan(0);
  });
});
