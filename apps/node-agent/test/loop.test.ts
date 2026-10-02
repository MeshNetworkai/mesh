import { afterEach, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../src/config.js';
import { GatewayClient } from '../src/gateway.js';
import { backoffMs, startLoop } from '../src/loop.js';
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
