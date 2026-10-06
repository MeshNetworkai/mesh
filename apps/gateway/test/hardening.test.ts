import { MockAdapter } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { runEpoch } from '../src/jobs/distribute.js';
import { JobBroker, JobRelay, RELAY_MAX_PENDING, completionTokenBound } from '../src/network.js';
import { headerSafe } from '../src/relay.js';
import { decideRoute } from '../src/routing.js';
import { MockUpstream, SseUsageScanner, costMicros, normalizeUsage } from '../src/upstream.js';
import { ADMIN, memDb, networkMicros, rewardMicros, testConfig, testServer } from './helpers.js';

/**
 * Regression tests for the pre-beta hardening pass (bug hunt + docs/LOADTEST.md bottlenecks 1-5, 8, 9).
 */

const fastConfig: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 400, stallTimeoutMs: 300, jobTimeoutMs: 5000, queueWaitMs: 600 },
};

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(config = fastConfig, env: Record<string, unknown> = {}) {
  const { app } = await testServer({ holders: { alice: 10_000 }, config, env });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const balance = async () => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } })).json().balance.usdMicros as number;
  const chat = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload });
  return { app, jwt, key, balance, chat };
}

async function fakeNode(app: App, opts: { nodeId?: string; wallet?: string; models?: string[]; maxParallel?: number } = {}) {
  const reg = await app.inject({
    method: 'POST',
    url: '/nodes/register',
    payload: { nodeId: opts.nodeId, wallet: opts.wallet ?? 'bob', models: opts.models ?? ['llama3.1:8b'], chip: 'M3 Max', ramGb: 64, maxParallel: opts.maxParallel },
  });
  expect(reg.statusCode).toBe(200);
  const id = reg.json().nodeId as string;
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  return {
    id,
    headers: h,
    reg: reg.json() as Record<string, unknown>,
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
const msg = { model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] };

// ---------------------------------------------------------------- part 1: bugs

describe('money: what a node reports is bounded by what the job could produce', () => {
  it('completion tokens are clamped to what the relayed text can be, prompt tokens to the messages sent; billing and reward use the clamped usage', async () => {
    const { app, chat, balance } = await boot();
    const n = await fakeNode(app, { nodeId: 'greedy' });
    const before = await balance();
    const client = chat({ ...msg, max_tokens: 50 });
    const job = (await n.pull()).json();
    await n.chunk(job.jobId, 0, 'short answer');
    // A node that lies about its token counts could drain a wallet into deep negative and pocket the reward.
    const done = await n.done(job.jobId, { promptTokens: 9_000_000, completionTokens: 9_000_000, finishReason: 'stop' });
    expect(done.statusCode).toBe(200);
    const res = await client;
    const last = sse(res.body).pop()!;
    expect(last.usage.completion_tokens).toBe(completionTokenBound(Buffer.byteLength('short answer'))); // 12 bytes → 14, not the 50 max_tokens allows
    expect(last.usage.prompt_tokens).toBeLessThan(200);
    const tokens = last.usage.total_tokens as number;
    expect(before - (await balance())).toBe(networkMicros(tokens));
    expect(app.ctx.db.prepare(`SELECT usd_micros, tokens FROM node_rewards`).get()).toEqual({ usd_micros: rewardMicros(tokens), tokens });
    expect(app.ctx.db.prepare(`SELECT completion_tokens FROM jobs`).get()).toEqual({ completion_tokens: 14 });
    // zod refuses absurd values outright
    expect((await n.done('job_x', { promptTokens: 1e12 })).statusCode).toBe(400);
  });

  it('done without a single delivered chunk is a node failure, not a paid reply: retried / fallen back, nothing charged, node blamed', async () => {
    const { app, chat, balance } = await boot();
    const n = await fakeNode(app, { nodeId: 'lazy' });
    const before = await balance();
    const client = chat(msg);
    const job = (await n.pull()).json();
    const done = await n.done(job.jobId, { promptTokens: 40, completionTokens: 1000, finishReason: 'stop' });
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe('empty_output');
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('mock');
    expect(res.headers['x-mesh-fallback']).toContain('empty_output');
    expect(app.ctx.db.prepare(`SELECT status, node_fault FROM jobs WHERE job_id = ?`).get(job.jobId)).toEqual({ status: 'fallback', node_fault: 1 });
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM node_rewards`).get() as { n: number }).n).toBe(0);
    // charged once, for the upstream reply only
    expect(before - (await balance())).toBe(1000);
  });

  it('costMicros / normalizeUsage never throw on malformed upstream usage', () => {
    const prices = { default: { promptUsdPerM: 1, completionUsdPerM: 2 }, models: {} };
    expect(costMicros({ prompt_tokens: 'x' as unknown as number, completion_tokens: NaN }, 'm', prices)).toBe(0);
    expect(costMicros({ prompt_tokens: 1_000_000, completion_tokens: -5, cost: Infinity }, 'm', prices)).toBe(1_000_000);
    expect(costMicros({ prompt_tokens: 0, completion_tokens: 0, cost: 'free' as unknown as number }, 'm', prices)).toBe(0);
    expect(normalizeUsage({ prompt_tokens: 3.7, completion_tokens: 2 } as never)).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(normalizeUsage(null)).toBeNull();
    const scanner = new SseUsageScanner();
    scanner.push('data: {"model":{"evil":1},"usage":{"prompt_tokens":"a","completion_tokens":[1]}}\n');
    expect(scanner.model).toBeNull();
    expect(scanner.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('races: heartbeat busy flag, concurrency and the epoch lock', () => {
  it('a heartbeat with busy:false while a job is running no longer frees the node (no double booking); busy:true pins it', async () => {
    const { app, chat } = await boot({ ...fastConfig, routing: { ...fastConfig.routing, firstTokenTimeoutMs: 3000 } });
    const n = await fakeNode(app, { nodeId: 'hb' });
    const first = chat(msg);
    const job = (await n.pull()).json();
    // The agent heartbeats `busy: false` (older agents / the load-test nodes do) mid-job.
    expect((await n.heartbeat({ busy: false })).statusCode).toBe(200);
    expect((await n.stats()).json()).toMatchObject({ status: 'busy', runningJobs: 1, maxParallel: 1 });
    // A second request must not be routed to it as "idle": the only node is at capacity -> queued -> queue_timeout -> upstream.
    const second = await chat(msg);
    expect(second.headers['x-mesh-route']).toBe('mock');
    expect(second.headers['x-mesh-fallback']).toBe('queue_timeout');
    await n.chunk(job.jobId, 0, 'ok');
    await n.done(job.jobId);
    expect((await first).headers['x-mesh-route']).toBe('node:hb');
    expect((await n.stats()).json()).toMatchObject({ status: 'idle', runningJobs: 0 });
    // busy:true (paused) pins the node: nothing is routed or queued to it
    await n.heartbeat({ busy: true });
    expect((await n.stats()).json().status).toBe('busy');
    const third = await chat(msg);
    expect(third.headers['x-mesh-route']).toBe('mock');
    expect(third.headers['x-mesh-fallback']).toBeUndefined();
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(2);
    await n.heartbeat({ busy: false });
    expect((await n.stats()).json().status).toBe('idle');
  });

  it('re-registering a node mid-job keeps its running count', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'rereg' });
    const client = chat(msg);
    const job = (await n.pull()).json();
    const again = await app.inject({ method: 'POST', url: '/nodes/register', headers: n.headers, payload: { nodeId: 'rereg', wallet: 'bob', models: ['llama3.1:8b'] } });
    expect(again.statusCode).toBe(200);
    expect(app.ctx.db.prepare(`SELECT busy FROM nodes WHERE node_id = 'rereg'`).get()).toEqual({ busy: 1 });
    await n.chunk(job.jobId, 0, 'x');
    await n.done(job.jobId);
    await client;
    expect(app.ctx.db.prepare(`SELECT busy FROM nodes WHERE node_id = 'rereg'`).get()).toEqual({ busy: 0 });
  });

  it('two concurrent runEpoch calls (cron + admin) sweep fees once: one complete, one skipped, nothing lost', async () => {
    const db = memDb();
    const adapter = new MockAdapter({ chain: 'solana', holders: { alice: 10_000 } });
    adapter.pushFees(10);
    const deps = { db, adapter, config: testConfig };
    const [a, b] = await Promise.all([runEpoch(deps, 3600), runEpoch(deps, 3600)]);
    expect([a.status, b.status].sort()).toEqual(['complete', 'skipped']);
    const complete = a.status === 'complete' ? a : b;
    expect(complete.feesUsdMicros).toBe(10_000_000);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM epochs`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger`).get() as { v: number }).v).toBe(5_000_000);
    expect(adapter.pendingFees()).toBe(0);
    // a later run for the same window is still a no-op
    expect((await runEpoch(deps, 3600)).status).toBe('skipped');
  });
});

describe('relay safety: buffers, headers, long-polls', () => {
  it('JobRelay refuses chunks beyond the gap / byte caps and after done', () => {
    const relay = new JobRelay();
    expect(relay.push({ type: 'claimed', nodeId: 'n' })).toBe(true);
    for (let i = 1; i <= RELAY_MAX_PENDING; i++) expect(relay.push({ type: 'chunk', seq: i, delta: 'x' })).toBe(true);
    expect(relay.push({ type: 'chunk', seq: RELAY_MAX_PENDING + 1, delta: 'x' })).toBe(false); // gap buffer full
    expect(relay.push({ type: 'chunk', seq: 0, delta: 'x' })).toBe(true); // fills the gap, flushes everything
    expect(relay.chunks).toBe(RELAY_MAX_PENDING + 1);
    expect(relay.push({ type: 'chunk', seq: RELAY_MAX_PENDING + 1, delta: 'y'.repeat(5 * 1024 * 1024) })).toBe(false); // too many bytes
    expect(relay.push({ type: 'done', usage: { promptTokens: 1, completionTokens: 1, finishReason: 'stop' } })).toBe(true);
    expect(relay.finished).toBe(true);
    expect(relay.push({ type: 'chunk', seq: RELAY_MAX_PENDING + 1, delta: 'late' })).toBe(false);
  });

  it('broker.chunk answers from the relay without a DB read and 409s late / foreign chunks', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'hot' });
    const other = await fakeNode(app, { nodeId: 'other' });
    const client = chat(msg);
    const job = (await n.pull()).json();
    expect((await other.chunk(job.jobId, 0, 'mine!')).statusCode).toBe(409);
    expect((await n.chunk(job.jobId, 2_000_000, 'x')).statusCode).toBe(400); // seq out of range
    expect((await n.chunk(job.jobId, 0, 'a')).statusCode).toBe(200);
    expect((await n.chunk(job.jobId, 0, 'a')).statusCode).toBe(200); // duplicate: accepted and dropped
    expect(app.ctx.broker.relay(job.jobId)?.chunks).toBe(1);
    expect((app.ctx.db.prepare(`SELECT first_chunk_ms FROM jobs WHERE job_id = ?`).get(job.jobId) as { first_chunk_ms: number | null }).first_chunk_ms).not.toBeNull();
    await n.done(job.jobId);
    await client;
    expect((await n.chunk(job.jobId, 1, 'late')).statusCode).toBe(409);
  });

  it('a node error containing CR/LF cannot break the fallback response (x-mesh-fallback is header-safe)', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'crlf' });
    const client = chat(msg);
    const job = (await n.pull()).json();
    expect((await n.fail(job.jobId, 'boom\r\nX-Injected: 1\r\n\r\nbody')).statusCode).toBe(200);
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-route']).toBe('mock');
    expect(res.headers['x-injected']).toBeUndefined();
    expect(String(res.headers['x-mesh-fallback'])).toMatch(/^node_error: boom X-Injected: 1 body$/);
    expect(headerSafe('a\r\nb\u0000c')).toBe('a b c');
  });

  it('a surplus long-poll from the same node is released at once (204) instead of lingering until its timer', async () => {
    const { app } = await boot();
    const n = await fakeNode(app, { nodeId: 'poller' });
    const t0 = Date.now();
    const first = n.pull(5000);
    await sleep(20);
    const second = n.pull(200);
    const r1 = await first;
    expect(r1.statusCode).toBe(204);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await second).statusCode).toBe(204);
    expect(app.ctx.broker.waiting).toBe(0);
  });

  it('upstream SSE: a client that disconnects mid-stream does not park the handler forever; the request is still recorded', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 }, context: { upstream: new MockUpstream(40) } });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh/other', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // first bytes arrived; the upstream keeps streaming at 40 ms/word
    ac.abort();
    // Before the fix `raw.write` on the destroyed socket returned false and the handler awaited a `drain` that never came.
    const deadline = Date.now() + 4000;
    let n = 0;
    while (Date.now() < deadline) {
      n = (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log`).get() as { n: number }).n;
      if (n === 1) break;
      await sleep(25);
    }
    expect(n).toBe(1);
  });
});

describe('node path: a client that disconnects mid-stream abandons the job (real socket)', () => {
  it('after the client aborts, the node\'s next chunk gets 409 and done records nothing', async () => {
    const calm: TokenomicsConfig = { ...fastConfig, routing: { ...fastConfig.routing, firstTokenTimeoutMs: 5000, stallTimeoutMs: 5000 } };
    const { app, key } = await boot(calm);
    const n = await fakeNode(app, { nodeId: 'mac-abort' });
    await n.heartbeat({ models: ['llama3.1:8b'], busy: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const client = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'long essay please' }] }),
      signal: ac.signal,
    });
    const job = (await n.pull(2000)).json();
    expect((await n.chunk(job.jobId, 0, 'Bread ')).statusCode).toBe(200);
    const res = await client;
    expect(res.status).toBe(200);
    await res.body!.getReader().read(); // first bytes reached the client
    ac.abort(); // the user pressed Stop
    // The gateway must notice the closed connection and abandon the job, so the node stops generating.
    let status = 200;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      status = (await n.chunk(job.jobId, 1, 'is old.')).statusCode;
      if (status === 409) break;
      await sleep(25);
    }
    expect(status).toBe(409);
    expect((await n.done(job.jobId, { promptTokens: 10, completionTokens: 700, finishReason: 'stop' })).statusCode).toBe(409);
    // nothing paid, nothing counted as served
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json()).toMatchObject({ busy: 0, tokens24h: 0 });
  });
});

// ---------------------------------------------------------------- part 2: load-test bottlenecks

describe('queueing when every node is busy (bottleneck 1)', () => {
  it('a burst on one node is served sequentially from the queue instead of falling to the upstream; mesh.routeReason says so', async () => {
    const { app, chat } = await boot({ ...fastConfig, routing: { ...fastConfig.routing, queueWaitMs: 3000 } });
    const n = await fakeNode(app, { nodeId: 'solo' });
    const c1 = chat(msg);
    const j1 = (await n.pull()).json();
    const c2 = chat(msg); // node busy -> queued
    await sleep(30);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`).get() as { n: number }).n).toBe(1);
    await n.chunk(j1.jobId, 0, 'one');
    await n.done(j1.jobId);
    const r1 = await c1;
    expect(sse(r1.body).pop()!.mesh).toMatchObject({ routeReason: 'node', nodeId: 'solo' });
    // the node frees up and takes the queued job
    const j2 = (await n.pull()).json();
    expect(j2.jobId).not.toBe(j1.jobId);
    await n.chunk(j2.jobId, 0, 'two');
    await n.done(j2.jobId);
    const r2 = await c2;
    expect(r2.headers['x-mesh-route']).toBe('node:solo');
    const last = sse(r2.body).pop()!;
    expect(last.mesh).toMatchObject({ routeReason: 'queued_then_node', nodeId: 'solo' });
    expect(last.mesh.queuedMs).toBeGreaterThanOrEqual(0);
  });

  it('queue_timeout: nobody frees up within routing.queueWaitMs -> upstream, x-mesh-fallback=queue_timeout, job marked fallback without blaming a node', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'stuck' });
    const c1 = chat(msg);
    const j1 = (await n.pull()).json();
    const t0 = Date.now();
    const r2 = await chat(msg);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(r2.headers['x-mesh-route']).toBe('mock');
    expect(r2.headers['x-mesh-fallback']).toBe('queue_timeout');
    expect(sse(r2.body).pop()!.mesh).toMatchObject({ route: 'mock', routeReason: 'queue_timeout' });
    const rows = app.ctx.db.prepare(`SELECT status, error, node_fault, node_id FROM jobs WHERE job_id != ? `).all(j1.jobId);
    expect(rows).toEqual([{ status: 'fallback', error: 'queue_timeout', node_fault: 0, node_id: null }]);
    await n.chunk(j1.jobId, 0, 'x');
    await n.done(j1.jobId);
    await c1;
  });

  it('queue depth cap (maxQueueDepthPerNode): beyond nodes × depth the request goes upstream at once with x-mesh-fallback=queue_full', async () => {
    const { app, chat } = await boot({ ...fastConfig, routing: { ...fastConfig.routing, queueWaitMs: 2000, maxQueueDepthPerNode: 1 } });
    const n = await fakeNode(app, { nodeId: 'capped' });
    const c1 = chat(msg);
    const j1 = (await n.pull()).json();
    const c2 = chat(msg); // queued (depth 1 of 1)
    await sleep(30);
    const t0 = Date.now();
    const r3 = await chat(msg); // depth cap reached -> straight upstream
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r3.headers['x-mesh-route']).toBe('mock');
    expect(r3.headers['x-mesh-fallback']).toBe('queue_full');
    expect(sse(r3.body).pop()!.mesh.routeReason).toBe('queue_full');
    await n.chunk(j1.jobId, 0, 'x');
    await n.done(j1.jobId);
    await c1;
    const j2 = (await n.pull()).json();
    await n.chunk(j2.jobId, 0, 'y');
    await n.done(j2.jobId);
    expect((await c2).headers['x-mesh-route']).toBe('node:capped');
  });

  it('queueWaitMs: 0 restores the old behaviour (busy node -> upstream, no job created)', async () => {
    const { app, chat } = await boot({ ...fastConfig, routing: { ...fastConfig.routing, queueWaitMs: 0 } });
    const n = await fakeNode(app, { nodeId: 'legacy' });
    const c1 = chat(msg);
    const j1 = (await n.pull()).json();
    const r2 = await chat(msg);
    expect(r2.headers['x-mesh-route']).toBe('mock');
    expect(r2.headers['x-mesh-fallback']).toBeUndefined();
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(1);
    await n.chunk(j1.jobId, 0, 'x');
    await n.done(j1.jobId);
    await c1;
  });
});

describe('per-node concurrency (bottleneck 2)', () => {
  it('maxParallel on register/heartbeat is capped by routing.maxParallelPerNode; a node with slots left stays routable and can park several long-polls', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'wide', maxParallel: 10 });
    expect(n.reg.maxParallel).toBe(4);
    expect((await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'bob', models: ['t'], maxParallel: 99 } })).statusCode).toBe(400);
    expect((await n.heartbeat({ maxParallel: 2 })).json().maxParallel).toBe(2);
    expect((await n.stats()).json()).toMatchObject({ maxParallel: 2, runningJobs: 0, status: 'idle' });
    // two parked long-polls, two concurrent requests -> both routed to the node as idle (reason 'node'), both claimed
    const p1 = n.pull(2000);
    const p2 = n.pull(2000);
    const c1 = chat(msg);
    const c2 = chat(msg);
    const [j1, j2] = [(await p1).json(), (await p2).json()];
    expect(j1.jobId).not.toBe(j2.jobId);
    expect((await n.stats()).json()).toMatchObject({ runningJobs: 2, status: 'busy', busy: true });
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json()).toMatchObject({ online: 1, busy: 1, idle: 0, slots: 2, runningJobs: 2 });
    // a third request has to queue (both slots taken)
    const c3 = chat(msg);
    await sleep(30);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`).get() as { n: number }).n).toBe(1);
    for (const j of [j1, j2]) {
      await n.chunk(j.jobId, 0, 'x');
      await n.done(j.jobId);
    }
    const j3 = (await n.pull()).json();
    await n.chunk(j3.jobId, 0, 'z');
    await n.done(j3.jobId);
    for (const c of [c1, c2]) expect(sse((await c).body).pop()!.mesh.routeReason).toBe('node');
    expect(sse((await c3).body).pop()!.mesh.routeReason).toBe('queued_then_node');
    expect((await n.stats()).json()).toMatchObject({ runningJobs: 0, status: 'idle', jobsDone24h: 3 });
  });
});

describe('fleet caches (bottlenecks 4, 5, 9)', () => {
  it('reputation is cached per node and invalidated on done / node-fault failure', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'cached' });
    const broker = app.ctx.broker;
    const rep0 = broker.reputation('cached');
    expect(rep0.jobs).toBe(0);
    expect(broker.reputation('cached')).toBe(rep0); // same object: cache hit
    const c = chat(msg);
    const job = (await n.pull()).json();
    await n.chunk(job.jobId, 0, 'x');
    await n.done(job.jobId);
    await c;
    expect(broker.reputation('cached')).not.toBe(rep0);
    expect(broker.reputation('cached').jobs).toBe(1);
    // and on a node-fault failure
    const c2 = chat(msg);
    const job2 = (await n.pull()).json();
    await n.fail(job2.jobId, 'oom');
    await c2;
    expect(broker.reputation('cached')).toMatchObject({ jobs: 2, done: 1, failed: 1 });
  });

  it('the online-node snapshot is invalidated by register / heartbeat(models) / quarantine so routing sees them at once', async () => {
    const { app } = await boot();
    const broker = app.ctx.broker;
    const deps = { db: app.ctx.db, config: app.ctx.config, policy: app.ctx.policy, broker };
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('no_online_node');
    const n = await fakeNode(app, { nodeId: 'fresh', models: ['qwen2.5:7b'] });
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('no_online_node');
    expect(decideRoute(deps, 'qwen-2.5-7b', { tier: 'network', source: 'default' }).reason).toBe('node');
    await n.heartbeat({ models: ['llama3.1:8b'] });
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' })).toMatchObject({ reason: 'node', candidates: ['fresh'] });
    expect(decideRoute(deps, 'qwen-2.5-7b', { tier: 'network', source: 'default' }).reason).toBe('no_online_node');
    await app.inject({ method: 'POST', url: '/admin/nodes/fresh/quarantine', headers: ADMIN, payload: { reason: 'test' } });
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('no_online_node');
    await app.inject({ method: 'POST', url: '/admin/nodes/fresh/quarantine/clear', headers: ADMIN });
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('node');
    // the snapshot itself is reused within NODE_SNAPSHOT_MS: a raw DB edit is not seen until it expires
    app.ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'fresh'`).run(nowSec() - 1000);
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('node');
    broker.invalidateNodes();
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'network', source: 'default' }).reason).toBe('no_online_node');
  });

  it('heartbeat queuedJobs is cached ~2 s; maintenance reaps expired jobs; GET /nodes is cached with STATS_CACHE_MS', async () => {
    const { app, chat } = await boot(fastConfig, { STATS_CACHE_MS: 60_000 });
    const n = await fakeNode(app, { nodeId: 'm' });
    const before = await app.inject({ method: 'GET', url: '/nodes' });
    expect(before.json()).toMatchObject({ online: 1, total: 1 });
    expect(before.headers['cache-control']).toBe('public, max-age=60');
    await fakeNode(app, { nodeId: 'm2', models: ['qwen2.5:7b'] });
    const cached = await app.inject({ method: 'GET', url: '/nodes' });
    expect(cached.json().total).toBe(1); // still the cached body
    expect(Number(cached.headers['x-cache-age-ms'])).toBeGreaterThanOrEqual(0);

    const c = chat(msg);
    const job = (await n.pull()).json();
    const hb1 = (await n.heartbeat()).json();
    expect(hb1.queuedJobs).toBe(0);
    const c2 = chat(msg); // queued behind m (m2 serves another tag)
    await sleep(20);
    expect((await n.heartbeat()).json().queuedJobs).toBe(1); // create/claim/fail invalidate the cached count
    app.ctx.db.prepare(`INSERT INTO jobs (job_id, model, tag, wallet, status, payload, max_tokens, deadline_ms, created_at, created_ms) VALUES ('job_ghost','m','zzz','w','queued','{}',10,?,?,?)`).run(Date.now() + 60_000, nowSec(), Date.now());
    expect((await n.heartbeat()).json().queuedJobs).toBe(1); // a raw DB change is not seen within QUEUE_DEPTH_CACHE_MS …
    app.ctx.broker.now = () => Date.now() + 5000;
    expect((await n.heartbeat()).json().queuedJobs).toBe(2); // … but is once the cache expires
    app.ctx.broker.now = () => Date.now();
    app.ctx.db.prepare(`DELETE FROM jobs WHERE job_id = 'job_ghost'`).run();
    // force an expired deadline on the queued job and reap it from the maintenance pass
    app.ctx.db.prepare(`UPDATE jobs SET deadline_ms = 1 WHERE status = 'queued'`).run();
    const reaped = app.ctx.broker.maintain();
    expect(reaped.jobsReaped).toBe(1);
    const r2 = await c2;
    expect(r2.headers['x-mesh-route']).toBe('mock');
    expect(r2.headers['x-mesh-fallback']).toBe('queue_timeout');
    expect(app.ctx.db.prepare(`SELECT status, error FROM jobs WHERE job_id != ?`).get(job.jobId)).toEqual({ status: 'fallback', error: 'deadline_exceeded' });
    await n.chunk(job.jobId, 0, 'x');
    await n.done(job.jobId);
    await c;
  });
});

describe('config overrides', () => {
  it('VERIFICATION_ENABLED overrides config.verification.enabled (kill switch; the load test needs it)', async () => {
    const on = await testServer({ config: { ...testConfig, verification: { ...testConfig.verification, enabled: true } }, env: { VERIFICATION_ENABLED: false } });
    apps.push(on.app);
    expect(on.app.ctx.config.verification.enabled).toBe(false);
    expect((await on.app.inject({ method: 'GET', url: '/stats' })).json().verificationEnabled).toBe(false);
    const off = await testServer({ env: { VERIFICATION_ENABLED: true } });
    apps.push(off.app);
    expect(off.app.ctx.config.verification.enabled).toBe(true);
    const plain = await testServer();
    apps.push(plain.app);
    expect(plain.app.ctx.config.verification.enabled).toBe(testConfig.verification.enabled);
  });
});

describe('registration limits (bottleneck 8)', () => {
  it('unsigned registrations share the strict per-IP bucket; the IP backstop default is max(60, 6 × strict)', async () => {
    const { app } = await testServer({ env: { NODE_REGISTER_RATE_LIMIT: 2 } });
    apps.push(app);
    const reg = (i: number) => app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: `w${i}`, models: ['t'] } });
    expect((await reg(1)).statusCode).toBe(200);
    const second = await reg(2);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-ratelimit-limit']).toBe('2');
    const third = await reg(3);
    expect(third.statusCode).toBe(429);
    expect(third.json().message).toContain('from this address');
  });
});
