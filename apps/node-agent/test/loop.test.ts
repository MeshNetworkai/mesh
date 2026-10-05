import { afterEach, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../src/config.js';
import { GatewayClient, GatewayError, parseRetryAfter } from '../src/gateway.js';
import { backoffMs, retryDelayMs, startLoop } from '../src/loop.js';
import { OllamaClient } from '../src/ollama.js';
import { AGENT_VERSION } from '../src/paths.js';
import { fakeGateway, fakeOllama } from './fakes.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const cfgFor = (gateway: string, ollama: string, over: Partial<NodeConfig> = {}): NodeConfig => ({
  gateway,
  nodeId: 'node_test',
  nodeToken: 'tok_test',
  wallet: 'wallet_abc',
  models: ['llama3.1:8b'],
  ollama,
  chip: 'Apple M3 Max',
  ramGb: 64,
  registeredAt: 0,
  maxParallel: 1,
  ...over,
});

describe('start loop', () => {
  let ollama: ReturnType<typeof fakeOllama>;
  let gw: ReturnType<typeof fakeGateway>;
  afterEach(async () => {
    await Promise.all([ollama?.stop(), gw?.stop()]);
  });

  it('registers, heartbeats, pulls one job, streams it and reports done', async () => {
    ollama = fakeOllama({ reply: ['one', ' two'], promptTokens: 3 });
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);

    // register (what `setup` does)
    const gateway = new GatewayClient(gwUrl);
    const reg = await gateway.register({ wallet: 'wallet_abc', chip: 'Apple M3 Max', ramGb: 64, models: ['llama3.1:8b'], agentVersion: AGENT_VERSION });
    expect(reg).toMatchObject({ nodeId: 'node_test', nodeToken: 'tok_test', pollMaxWaitMs: 25000 });
    expect(gw.state.registrations[0]).toEqual({ wallet: 'wallet_abc', chip: 'Apple M3 Max', ramGb: 64, models: ['llama3.1:8b'], agentVersion: AGENT_VERSION });
    gateway.setToken(reg.nodeToken);

    gw.state.queue.push({ jobId: 'j1', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], params: {}, maxTokens: 32, deadlineMs: 5000 });

    const handle = startLoop({
      config: cfgFor(gwUrl, ollamaUrl, { nodeId: reg.nodeId, nodeToken: reg.nodeToken }),
      log: silent,
      gateway,
      ollama: new OllamaClient(ollamaUrl),
      heartbeatMs: 50,
      maxJobs: 1,
      batchMs: 1,
      isPaused: () => false,
    });
    // pollLoop exits after maxJobs; stop the heartbeat loop too.
    await new Promise((r) => setTimeout(r, 300));
    await handle.stop();

    expect(handle.stats().jobs).toBe(1);
    expect(handle.stats().failed).toBe(0);
    expect(gw.state.chunks.map((c) => c.delta).join('')).toBe('one two');
    expect(gw.state.done).toEqual([{ jobId: 'j1', body: { promptTokens: 3, completionTokens: 2, finishReason: 'stop' } }]);
    expect(gw.state.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(gw.state.heartbeats[0]).toMatchObject({ models: ['llama3.1:8b'], busy: false });
    expect(typeof gw.state.heartbeats[0].loadAvg).toBe('number');
    // The job start heartbeat and the shutdown heartbeat report busy=true.
    expect(gw.state.heartbeats.some((h) => h.busy === true)).toBe(true);
  });

  it('while paused it heartbeats busy=true and does not poll for jobs', async () => {
    ollama = fakeOllama();
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    gw.state.queue.push({ jobId: 'j1', model: 'llama3.1:8b', messages: [] });
    const handle = startLoop({
      config: cfgFor(gwUrl, ollamaUrl),
      log: silent,
      heartbeatMs: 40,
      isPaused: () => true,
    });
    await new Promise((r) => setTimeout(r, 200));
    await handle.stop();
    expect(gw.state.polls).toBe(0);
    expect(gw.state.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(gw.state.heartbeats.every((h) => h.busy === true)).toBe(true);
    expect(gw.state.queue).toHaveLength(1);
  });

  it('re-registers when the gateway answers 401 and persists the new identity', async () => {
    ollama = fakeOllama();
    gw = fakeGateway({ token: 'tok_new', nodeId: 'node_new' });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    let saved: NodeConfig | null = null;
    const handle = startLoop({
      config: cfgFor(gwUrl, ollamaUrl, { nodeId: 'node_old', nodeToken: 'tok_old' }),
      log: silent,
      heartbeatMs: 40,
      isPaused: () => true,
      onReregister: (c) => (saved = c),
    });
    await new Promise((r) => setTimeout(r, 250));
    await handle.stop();
    expect(gw.state.registrations.length).toBeGreaterThanOrEqual(1);
    expect(gw.state.registrations[0]).toMatchObject({ wallet: 'wallet_abc', chip: 'Apple M3 Max', ramGb: 64 });
    expect(saved).toMatchObject({ nodeId: 'node_new', nodeToken: 'tok_new', wallet: 'wallet_abc' });
    // Later heartbeats were accepted with the new token.
    expect(gw.state.heartbeats.length).toBeGreaterThanOrEqual(1);
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(700);
    expect(backoffMs(1)).toBeLessThanOrEqual(1300);
    expect(backoffMs(4)).toBeGreaterThanOrEqual(5600);
    expect(backoffMs(20)).toBeLessThanOrEqual(78_000);
    // jitter: not every call returns the same number
    expect(new Set(Array.from({ length: 20 }, () => backoffMs(3))).size).toBeGreaterThan(1);
    // retry-after from the gateway is a floor on the wait, never a ceiling
    expect(retryDelayMs(new GatewayError(429, 'x', 'rate_limited', 30_000), 1)).toBeGreaterThanOrEqual(30_000);
    expect(retryDelayMs(new GatewayError(503, 'x'), 1)).toBeLessThanOrEqual(1300);
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter('999999')).toBe(5 * 60_000);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeLessThanOrEqual(10_000);
  });

  it('runs up to maxParallel jobs at once, advertises maxParallel, and never pins busy while slots are free', async () => {
    ollama = fakeOllama({ reply: ['a', 'b', 'c'], delayMs: 40 });
    gw = fakeGateway({ pollHoldMs: 10 });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    for (let i = 0; i < 4; i++) gw.state.queue.push({ jobId: `j${i}`, model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 });
    const handle = startLoop({
      config: cfgFor(gwUrl, ollamaUrl, { maxParallel: 2 }),
      log: silent,
      heartbeatMs: 30,
      maxJobs: 4,
      batchMs: 1,
      isPaused: () => false,
    });
    await new Promise((r) => setTimeout(r, 600));
    await handle.stop();
    expect(handle.stats()).toMatchObject({ jobs: 4, failed: 0, active: 0, maxParallel: 2 });
    expect(gw.state.done.map((d) => d.jobId).sort()).toEqual(['j0', 'j1', 'j2', 'j3']);
    expect(ollama.concurrency.max).toBe(2);
    expect(gw.state.heartbeats.every((h) => h.maxParallel === 2)).toBe(true);
    // Heartbeats sent while exactly one job ran (one free slot) must not pin busy.
    const pinned = gw.state.heartbeats.filter((h) => h.busy === true);
    expect(pinned.length).toBeGreaterThanOrEqual(1); // at capacity and the final draining heartbeat
    expect(gw.state.heartbeats.some((h) => h.busy === false)).toBe(true);
  });

  it('with maxParallel 1 a heartbeat during the job pins busy and the end of the job unpins at once', async () => {
    ollama = fakeOllama({ reply: ['a', 'b'], delayMs: 60 });
    gw = fakeGateway({ pollHoldMs: 10 });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    gw.state.queue.push({ jobId: 'j1', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
    const handle = startLoop({ config: cfgFor(gwUrl, ollamaUrl), log: silent, heartbeatMs: 10_000, maxJobs: 1, batchMs: 1, isPaused: () => false });
    await new Promise((r) => setTimeout(r, 400));
    // Sequence without any periodic tick: initial false, job start true, job end false.
    const seq = gw.state.heartbeats.map((h) => h.busy);
    expect(seq.slice(0, 3)).toEqual([false, true, false]);
    await handle.stop();
  });

  it('backs off (and keeps going) when the gateway answers 5xx / 429 on the poll; never hot-loops', async () => {
    ollama = fakeOllama();
    gw = fakeGateway({ pollHoldMs: 10, failNext: { count: 3, status: 503 } });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const warns: string[] = [];
    const handle = startLoop({
      config: cfgFor(gwUrl, ollamaUrl),
      log: { ...silent, warn: (m) => warns.push(m) },
      heartbeatMs: 10_000,
      isPaused: () => false,
    });
    await new Promise((r) => setTimeout(r, 900));
    // 3 failures: waits of ~1s, ~2s, ~4s. In 900ms at most the first retry has fired, so <= 2 polls.
    const pollsSoFar = gw.state.polls;
    await handle.stop();
    expect(gw.state.failNext!.count).toBeLessThanOrEqual(2);
    expect(pollsSoFar).toBeLessThanOrEqual(2);
    expect(warns.some((w) => /job poll failed x1 .*retrying in \d+s/.test(w))).toBe(true);
  });

  it('stop() abandons a parked long-poll immediately instead of waiting it out', async () => {
    ollama = fakeOllama();
    gw = fakeGateway({ pollHoldMs: 5000 });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const handle = startLoop({ config: cfgFor(gwUrl, ollamaUrl), log: silent, heartbeatMs: 10_000, isPaused: () => false });
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.state.pollsInFlight).toBe(1);
    const t0 = Date.now();
    await handle.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    // The final heartbeat pins busy so nothing is routed here while we drain.
    expect(gw.state.heartbeats[gw.state.heartbeats.length - 1]).toMatchObject({ busy: true });
  });

  it('a gateway that keeps answering 401 after a successful re-register does not hot-loop', async () => {
    ollama = fakeOllama();
    gw = fakeGateway({ pollHoldMs: 10, token: 'tok_new', nodeId: 'node_new' });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    // Every authenticated call is rejected even with the fresh token: simulate by changing the token
    // the fake expects after each registration.
    gw.server.prependListener('request', (req) => {
      if (req.url === '/nodes/register') gw.state.token = `tok_${Math.random()}`;
    });
    const handle = startLoop({ config: cfgFor(gwUrl, ollamaUrl, { nodeId: 'node_old', nodeToken: 'tok_old' }), log: silent, heartbeatMs: 10_000, isPaused: () => false });
    await new Promise((r) => setTimeout(r, 700));
    await handle.stop();
    // Without the guard this would be hundreds of registrations in 700ms.
    expect(gw.state.registrations.length).toBeLessThanOrEqual(4);
  });

  it('a job that is paused mid-run finishes; only new jobs stop', async () => {
    ollama = fakeOllama({ reply: ['a', 'b', 'c'], delayMs: 50 });
    gw = fakeGateway({ pollHoldMs: 10 });
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    gw.state.queue.push({ jobId: 'j1', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
    gw.state.queue.push({ jobId: 'j2', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
    let paused = false;
    const handle = startLoop({ config: cfgFor(gwUrl, ollamaUrl), log: silent, heartbeatMs: 10_000, batchMs: 1, isPaused: () => paused });
    await new Promise((r) => setTimeout(r, 60));
    paused = true; // j1 is streaming
    await new Promise((r) => setTimeout(r, 400));
    await handle.stop();
    expect(gw.state.done.map((d) => d.jobId)).toEqual(['j1']);
    expect(gw.state.queue.map((j) => j.jobId)).toEqual(['j2']);
    expect(handle.stats().failed).toBe(0);
  });
});

describe('GatewayClient', () => {
  it('re-registers a stored nodeId with its token and gets a rotated token; a wrong token is a 409', async () => {
    const gw = fakeGateway();
    const url = await gw.start();
    try {
      const input = { wallet: 'w', chip: 'c', ramGb: 16, models: ['llama3.1:8b'], agentVersion: AGENT_VERSION };
      await expect(new GatewayClient(url, 'wrong').register({ ...input, nodeId: 'node_test' })).rejects.toMatchObject({ status: 409, code: 'node_exists' });
      const reg = await new GatewayClient(url, 'tok_test').register({ ...input, nodeId: 'node_test' });
      expect(reg).toMatchObject({ nodeId: 'node_test', nodeToken: 'tok_test_rotated' });
    } finally {
      await gw.stop();
    }
  });

  it('fetches node stats with the bearer token and returns null on 204 polls', async () => {
    const gw = fakeGateway();
    const url = await gw.start();
    try {
      const gateway = new GatewayClient(url, 'tok_test');
      const stats = await gateway.stats('node_test');
      expect(stats).toMatchObject({ status: 'online', uptimePct24h: 99.2, earnedUsdTotal: 3.14 });
      expect(await gateway.nextJob('node_test')).toBeNull();
      await expect(new GatewayClient(url, 'wrong').stats('node_test')).rejects.toMatchObject({ status: 401 });
    } finally {
      await gw.stop();
    }
  });
});
