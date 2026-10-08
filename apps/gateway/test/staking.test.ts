import { MockAdapter, NotWiredError, type ChainAdapter } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRewardMicros } from '../src/ledger.js';
import { eligibleNodes } from '../src/routing.js';
import { StakeResolver, applyMultiplier, nextTierFor, tierForPosition } from '../src/staking.js';
import { ADMIN, memDb, networkMicros, rewardMicros, testConfig, testServer } from './helpers.js';

/** Filler so a fake node's reported token counts are ones its text can account for (network.ts completionTokenBound / promptTokenBound). */
const PAD = ' '.repeat(2000);

const E = testConfig.epochSeconds;
const stakedConfig: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000, jobTimeoutMs: 5000 },
};

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(adapter: MockAdapter, config = stakedConfig) {
  const { app } = await testServer({ config, context: { adapter } });
  apps.push(app);
  const login = async (wallet: string) => (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token as string;
  return { app, login };
}

async function fakeNode(app: App, opts: { nodeId?: string; wallet: string }) {
  const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: opts.nodeId, wallet: opts.wallet, models: ['llama3.1:8b'], chip: 'M3', ramGb: 32, agentVersion: '0.2.0' } });
  expect(reg.statusCode).toBe(200);
  const id = reg.json().nodeId as string;
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  return {
    id,
    pull: (wait = 1500) => app.inject({ method: 'GET', url: `/nodes/${id}/jobs/next?wait=${wait}`, headers: h }),
    chunk: (jobId: string, seq: number, delta: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/chunk`, headers: h, payload: { seq, delta } }),
    done: (jobId: string, usage: Record<string, unknown>) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/done`, headers: h, payload: usage }),
    stats: () => app.inject({ method: 'GET', url: `/nodes/${id}`, headers: h }),
  };
}

describe('tier rules (mirror MeshStaking.tierOf)', () => {
  it('minStake alone reaches unlocked tiers; locked tiers need the lock commitment', () => {
    expect(tierForPosition(testConfig, { staked: 0 }).tier.name).toBe('none');
    expect(tierForPosition(testConfig, { staked: 9_999 }).tier.name).toBe('none');
    expect(tierForPosition(testConfig, { staked: 10_000 }).tier.name).toBe('silver');
    expect(tierForPosition(testConfig, { staked: 60_000, lockDays: 0 }).tier.name).toBe('silver');
    expect(tierForPosition(testConfig, { staked: 60_000, lockDays: 30 }).tier.name).toBe('gold');
    expect(tierForPosition(testConfig, { staked: 60_000, lockDays: 90 }).tier.name).toBe('gold');
  });

  it('nextTier reports what is missing', () => {
    const silver = tierForPosition(testConfig, { staked: 12_000 });
    expect(nextTierFor(testConfig, { staked: 12_000 }, silver.index)).toMatchObject({ name: 'gold', needStake: 38_000, lockDays: 30, multiplier: 2 });
    // enough tokens, lock missing → needStake 0 but still not gold
    const rich = tierForPosition(testConfig, { staked: 80_000 });
    expect(rich.tier.name).toBe('silver');
    expect(nextTierFor(testConfig, { staked: 80_000 }, rich.index)).toMatchObject({ name: 'gold', needStake: 0 });
    const gold = tierForPosition(testConfig, { staked: 80_000, lockDays: 30 });
    expect(nextTierFor(testConfig, { staked: 80_000, lockDays: 30 }, gold.index)).toBeNull();
  });

  it('applyMultiplier rounds to whole micros', () => {
    expect(applyMultiplier(7, 1.5)).toBe(11);
    expect(applyMultiplier(nodeRewardMicros(200, 0.06), 2)).toBe(2 * rewardMicros(200));
  });
});

describe('StakeResolver', () => {
  it('resolves tiers from the adapter and caches per epoch', async () => {
    let now = 10 * E + 5;
    const adapter = new MockAdapter({ now: () => now });
    const reads: string[][] = [];
    const orig = adapter.getStakes.bind(adapter);
    adapter.getStakes = async (w) => {
      reads.push(w);
      return orig(w);
    };
    const r = new StakeResolver({ adapter, config: testConfig, now: () => now });
    expect(r.available).toBe(true);
    const alice = await r.resolve('mockwallet_alice');
    expect(alice).toMatchObject({ staked: 50_000, lockDays: 30, tier: { name: 'gold' }, multiplier: 2, nextTier: null, available: true, epoch: 10 * E });
    expect(alice.lockEndsAt).toBe(now + 30 * 86_400);
    const bob = await r.resolve('mockwallet_bob');
    expect(bob).toMatchObject({ staked: 12_000, tier: { name: 'silver' }, multiplier: 1.5, nextTier: { name: 'gold', needStake: 38_000 } });
    expect(await r.resolve('mockwallet_carol')).toMatchObject({ staked: 0, tier: { name: 'none' }, multiplier: 1 });
    expect(reads).toHaveLength(3);

    // same epoch: the position changes on chain but the cache answers
    adapter.setStake('mockwallet_bob', 100_000, { lockDays: 30 });
    expect((await r.resolve('mockwallet_bob')).tier.name).toBe('silver');
    expect(r.peek('mockwallet_bob').tierIndex).toBe(1);
    expect(r.multiplierOf('mockwallet_bob')).toBe(1.5);
    expect(reads).toHaveLength(3);

    // next epoch: re-read
    now = 11 * E + 1;
    expect((await r.resolve('mockwallet_bob')).tier.name).toBe('gold');
    expect(reads).toHaveLength(4);
  });

  it('resolveMany batches the uncached wallets into one adapter call', async () => {
    const adapter = new MockAdapter();
    const reads: string[][] = [];
    const orig = adapter.getStakes.bind(adapter);
    adapter.getStakes = async (w) => {
      reads.push(w);
      return orig(w);
    };
    const r = new StakeResolver({ adapter, config: testConfig });
    await r.resolve('mockwallet_alice');
    const m = await r.resolveMany(['mockwallet_alice', 'mockwallet_bob', 'mockwallet_carol', 'mockwallet_bob']);
    expect(m.size).toBe(3);
    expect(reads).toEqual([['mockwallet_alice'], ['mockwallet_bob', 'mockwallet_carol']]);
  });

  it('peek returns the base tier before the first read and warms the cache', async () => {
    const adapter = new MockAdapter();
    const r = new StakeResolver({ adapter, config: testConfig });
    expect(r.peek('mockwallet_alice')).toMatchObject({ tierIndex: 0, multiplier: 1 });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.peek('mockwallet_alice')).toMatchObject({ tierIndex: 2, multiplier: 2 });
  });

  it('an adapter without getStakes, or one that is NotWired, puts everyone on the base tier', async () => {
    const bare = new MockAdapter();
    (bare as Partial<ChainAdapter>).getStakes = undefined;
    const r1 = new StakeResolver({ adapter: bare, config: testConfig });
    expect(r1.available).toBe(false);
    expect(await r1.resolve('mockwallet_alice')).toMatchObject({ tier: { name: 'none' }, multiplier: 1, available: false });

    const notWired = new MockAdapter();
    notWired.getStakes = async () => {
      throw new NotWiredError('MockAdapter', 'test');
    };
    const r2 = new StakeResolver({ adapter: notWired, config: testConfig });
    expect(r2.available).toBe(true);
    expect(await r2.resolve('mockwallet_alice')).toMatchObject({ tier: { name: 'none' }, available: false });
    expect(r2.available).toBe(false);
  });

  it('a failing RPC falls back to the base tier for the epoch instead of throwing', async () => {
    const flaky = new MockAdapter();
    let calls = 0;
    flaky.getStakes = async () => {
      calls++;
      throw new Error('rpc down');
    };
    const r = new StakeResolver({ adapter: flaky, config: testConfig });
    expect(await r.resolve('mockwallet_alice')).toMatchObject({ multiplier: 1, available: false });
    await r.resolve('mockwallet_alice');
    r.peek('mockwallet_alice');
    expect(calls).toBe(1);
  });
});

describe('HTTP: /stake/tiers and /me/stake', () => {
  it('GET /stake/tiers is public and mirrors config', async () => {
    const { app } = await boot(new MockAdapter());
    const res = await app.inject({ method: 'GET', url: '/stake/tiers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chain: testConfig.chain,
      ticker: 'MESH',
      available: true,
      contract: null,
      epochSeconds: E,
      tiers: [
        { name: 'none', minStake: 0, lockDays: 0, multiplier: 1 },
        { name: 'silver', minStake: 10_000, lockDays: 0, multiplier: 1.5 },
        { name: 'gold', minStake: 50_000, lockDays: 30, multiplier: 2 },
      ],
    });
  });

  it('GET /me/stake needs a session and returns the wallet position + next tier', async () => {
    const { app, login } = await boot(new MockAdapter());
    expect((await app.inject({ method: 'GET', url: '/me/stake' })).statusCode).toBe(401);
    const bob = await app.inject({ method: 'GET', url: '/me/stake', headers: { authorization: `Bearer ${await login('mockwallet_bob')}` } });
    expect(bob.statusCode).toBe(200);
    expect(bob.json()).toMatchObject({
      wallet: 'mockwallet_bob',
      staked: 12_000,
      tier: { name: 'silver', multiplier: 1.5 },
      tierIndex: 1,
      multiplier: 1.5,
      lockDays: 0,
      lockEndsAt: 0,
      nextTier: { name: 'gold', minStake: 50_000, lockDays: 30, multiplier: 2, needStake: 38_000 },
      available: true,
    });
    const nobody = await app.inject({ method: 'GET', url: '/me/stake', headers: { authorization: `Bearer ${await login('stranger')}` } });
    expect(nobody.json()).toMatchObject({ staked: 0, tier: { name: 'none' }, multiplier: 1, nextTier: { name: 'silver', needStake: 10_000 } });
  });
});

describe('rewards and routing use the tier', () => {
  it('node reward is multiplied by the reward wallet tier', async () => {
    const adapter = new MockAdapter(); // alice gold (2×), carol unstaked (1×)
    const { app, login } = await boot(adapter);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'user', amountUsd: 1 } });
    const jwt = await login('user');
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
    const chat = () => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'llama-3.1-8b', messages: [{ role: 'user', content: `hi${PAD}` }] } });

    const gold = await fakeNode(app, { nodeId: 'gold-mac', wallet: 'mockwallet_alice' });
    let client = chat();
    let job = (await gold.pull()).json();
    await gold.chunk(job.jobId, 0, `A${PAD}`);
    await gold.done(job.jobId, { promptTokens: 100, completionTokens: 100, finishReason: 'stop' });
    expect((await client).statusCode).toBe(200);
    const base = rewardMicros(200);
    expect(base).toBeGreaterThan(0);
    // 2× the base reward, but never more than nodeRewards.maxShareOfPriceBps of what the job was billed (relay.ts):
    // at the shipped prices gold is held at 90% of the network price, so the job still leaves a margin.
    const ceiling = Math.floor((networkMicros(200) * testConfig.nodeRewards.maxShareOfPriceBps) / 10_000);
    const goldReward = Math.min(2 * base, ceiling);
    expect(testConfig.nodeRewards.maxShareOfPriceBps).toBe(9000);
    expect(goldReward).toBeGreaterThan(base);
    expect(goldReward).toBeLessThan(networkMicros(200));
    expect((await gold.stats()).json().earnedUsdTotal).toBe(goldReward / 1_000_000);

    // The gold node is busy=0 again but a plain node must still get the job when it is the only one polling:
    // close the gold node's eligibility by marking it busy, then serve from carol.
    app.ctx.db.prepare(`UPDATE nodes SET busy = 1 WHERE node_id = 'gold-mac'`).run();
    const plain = await fakeNode(app, { nodeId: 'plain-mac', wallet: 'mockwallet_carol' });
    client = chat();
    job = (await plain.pull()).json();
    await plain.chunk(job.jobId, 0, `B${PAD}`);
    await plain.done(job.jobId, { promptTokens: 100, completionTokens: 100, finishReason: 'stop' });
    expect((await client).statusCode).toBe(200);
    expect((await plain.stats()).json().earnedUsdTotal).toBe(base / 1_000_000);

    const rows = app.ctx.db.prepare(`SELECT wallet, usd_micros FROM node_rewards WHERE kind = 'node_reward' ORDER BY id`).all() as Array<{ wallet: string; usd_micros: number }>;
    expect(rows).toEqual([
      { wallet: 'mockwallet_alice', usd_micros: goldReward },
      { wallet: 'mockwallet_carol', usd_micros: base },
    ]);
  });

  it('eligibleNodes orders by tier desc, then reputation, then last_seen', async () => {
    const adapter = new MockAdapter();
    const { app } = await boot(adapter);
    const ctx = app.ctx;
    // carol (none), bob (silver), alice (gold); registered in that order so last_seen favours alice anyway → shuffle
    await fakeNode(app, { nodeId: 'n-gold', wallet: 'mockwallet_alice' });
    await fakeNode(app, { nodeId: 'n-none', wallet: 'mockwallet_carol' });
    await fakeNode(app, { nodeId: 'n-silver', wallet: 'mockwallet_bob' });
    const t = Math.floor(Date.now() / 1000);
    ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'n-none'`).run(t + 10); // most recent → would win without tiers
    ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'n-silver'`).run(t + 5);
    ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'n-gold'`).run(t);

    // before the cache is warm everyone is base tier → recency order
    expect(eligibleNodes({ db: ctx.db, config: ctx.config }, 'llama3.1:8b').map((n) => n.node_id)).toEqual(['n-none', 'n-silver', 'n-gold']);
    await ctx.stakes!.resolveMany(['mockwallet_alice', 'mockwallet_bob', 'mockwallet_carol']);
    expect(eligibleNodes(ctx, 'llama3.1:8b').map((n) => n.node_id)).toEqual(['n-gold', 'n-silver', 'n-none']);

    // same tier: reputation decides. Give n-none a perfect record and add a second base-tier node with a failure.
    await fakeNode(app, { nodeId: 'n-none-2', wallet: 'nobody' });
    await ctx.stakes!.resolve('nobody');
    const ms = Date.now();
    const ins = ctx.db.prepare(
      `INSERT INTO jobs (job_id, model, tag, wallet, api_key_id, payload, max_tokens, deadline_ms, status, node_id, node_fault, created_at, created_ms, claimed_ms, first_chunk_ms)
       VALUES (?, 'm', 'llama3.1:8b', 'w', 0, '{}', 10, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) ins.run(`j-ok-${i}`, ms + 1000, 'done', 'n-none', 0, t, ms, ms, ms + 100);
    for (let i = 0; i < 4; i++) ins.run(`j-ok2-${i}`, ms + 1000, 'done', 'n-none-2', 0, t, ms, ms, ms + 50);
    ins.run('j-bad', ms + 1000, 'failed', 'n-none-2', 1, t, ms, ms, null);
    ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'n-none-2'`).run(t + 20);
    const order = eligibleNodes(ctx, 'llama3.1:8b').map((n) => n.node_id);
    expect(order).toEqual(['n-gold', 'n-silver', 'n-none', 'n-none-2']);
  });

  it('decideRoute candidates come back tier-sorted', async () => {
    const { app } = await boot(new MockAdapter());
    await fakeNode(app, { nodeId: 'a', wallet: 'mockwallet_carol' });
    await fakeNode(app, { nodeId: 'b', wallet: 'mockwallet_alice' });
    await app.ctx.stakes!.resolveMany(['mockwallet_alice', 'mockwallet_carol']);
    const { decideRoute } = await import('../src/routing.js');
    const d = decideRoute(app.ctx, 'llama-3.1-8b');
    expect(d.target).toBe('node');
    expect(d.candidates).toEqual(['b', 'a']);
  });
});

describe('createContext wires a resolver', () => {
  it('ctx.stakes exists and shares the adapter', async () => {
    const { app } = await testServer({ holders: { x: 1 }, context: { db: memDb() } });
    apps.push(app);
    expect(app.ctx.stakes).toBeInstanceOf(StakeResolver);
    expect(app.ctx.stakes!.available).toBe(true);
  });
});
