import { parseModelPolicy, type ModelPrices, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { runEpoch } from '../src/jobs/distribute.js';
import { pendingPoolExtra } from '../src/market.js';
import { MOCK_COST_USD } from '../src/upstream.js';
import { recordUsageShare, splitUsageMargin, usageShareTotals } from '../src/usage-share.js';
import { ADMIN, memDb, networkMicros, rewardMicros, testConfig, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const prices: ModelPrices = {
  default: { promptUsdPerM: 1, completionUsdPerM: 3 },
  models: { 'meta-llama/llama-3.1-8b-instruct': { promptUsdPerM: 0.05, completionUsdPerM: 0.08 }, 'mesh/mock': { promptUsdPerM: 0, completionUsdPerM: 0 } },
};
const policy = parseModelPolicy({ networkModels: { 'llama-3.1-8b': 'llama3.1:8b', 'meta-llama/llama-3.1-8b-instruct': 'llama3.1:8b', 'mesh/mock': 'mesh/mock' } });

const ON: TokenomicsConfig['usageShare'] = { enabled: true, holderBps: 3000, treasuryBps: 7000, sources: { network: true, upstream: true, marketplaceFee: true } };

/** usageShare on, network price above the node reward (the suggested 0.08/M vs 0.06/M) so network requests leave a margin. */
function cfg(over: Partial<TokenomicsConfig> = {}, share: Partial<TokenomicsConfig['usageShare']> = {}): TokenomicsConfig {
  return {
    ...testConfig,
    routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000, jobTimeoutMs: 5000 },
    requestPricing: { ...testConfig.requestPricing, networkPricePerMTokens: 0.08 },
    nodeRewards: { usdPerMTokens: 0.06 },
    usageShare: { ...ON, ...share },
    ...over,
  };
}

async function boot(config: TokenomicsConfig) {
  const { app } = await testServer({ holders: { alice: 10_000, holder2: 30_000 }, config, context: { policy, prices } });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'mac-u', wallet: 'bob', models: ['llama3.1:8b'], chip: 'M3', ramGb: 32, agentVersion: '0.2.0' } });
  expect(reg.statusCode).toBe(200);
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  /** One network-served request: 1000 prompt + 500 completion tokens. */
  const serveNetwork = async () => {
    const client = app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] } });
    const job = (await app.inject({ method: 'GET', url: `/nodes/mac-u/jobs/next?wait=2000`, headers: h })).json();
    await app.inject({ method: 'POST', url: `/nodes/mac-u/jobs/${job.jobId}/chunk`, headers: h, payload: { seq: 0, delta: 'ok' } });
    await app.inject({ method: 'POST', url: `/nodes/mac-u/jobs/${job.jobId}/done`, headers: h, payload: { promptTokens: 1000, completionTokens: 500, finishReason: 'stop' } });
    const res = await client;
    expect(res.statusCode).toBe(200);
    return { res, jobId: job.jobId as string };
  };
  /** One upstream-served request (mesh/mock is not advertised by the node): the mock upstream reports usage.cost = $0.001. */
  const serveUpstream = async (stream = false) => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', stream, messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(200);
    return res;
  };
  const pool = () => pendingPoolExtra(app.ctx.db);
  const poolRows = () => app.ctx.db.prepare(`SELECT source, usd_micros, ref FROM pool_extra_micros ORDER BY id`).all() as Array<{ source: string; usd_micros: number; ref: string }>;
  const logRows = () => app.ctx.db.prepare(`SELECT * FROM usage_share_log ORDER BY id`).all() as Array<Record<string, number | string>>;
  return { app, key, serveNetwork, serveUpstream, pool, poolRows, logRows };
}

const TOKENS = 1500;
const NET_BILLED = Math.round(TOKENS * 0.08); // 120 micro-USD
const NET_REWARD = Math.round(TOKENS * 0.06); // 90
const NET_MARGIN = NET_BILLED - NET_REWARD; // 30
const NET_HOLDERS = Math.floor((NET_MARGIN * 3000) / 10_000); // 9
const UP_LIST = Math.round(MOCK_COST_USD * 1e6); // 1000

describe('usage-revenue share: pure split', () => {
  it('holderBps of a positive margin to holders, the rest to the treasury; nothing on zero or negative', () => {
    expect(splitUsageMargin({ holderBps: 3000 }, 120, 90)).toEqual({ marginMicros: 30, holderMicros: 9, treasuryMicros: 21 });
    expect(splitUsageMargin({ holderBps: 3000 }, 1000, 1000)).toEqual({ marginMicros: 0, holderMicros: 0, treasuryMicros: 0 });
    expect(splitUsageMargin({ holderBps: 3000 }, 750, 1000)).toEqual({ marginMicros: -250, holderMicros: 0, treasuryMicros: 0 });
    expect(splitUsageMargin({ holderBps: 10_000 }, 100, 40)).toEqual({ marginMicros: 60, holderMicros: 60, treasuryMicros: 0 });
  });

  it('recordUsageShare: off → null and no rows; on → log + pool_extra row keyed by ref, idempotent; disabled source → nothing', () => {
    const db = memDb();
    const input = { source: 'network' as const, ref: 'usage:job:j1', wallet: 'alice', model: 'llama-3.1-8b', billedMicros: 120, costMicros: 90 };
    expect(recordUsageShare(db, { ...ON, enabled: false }, input)).toBeNull();
    expect(pendingPoolExtra(db).usdMicros).toBe(0);
    expect(recordUsageShare(db, ON, input)).toEqual({ marginMicros: 30, holderMicros: 9, treasuryMicros: 21 });
    expect(recordUsageShare(db, ON, input)).toBeNull(); // same ref: booked once
    expect(pendingPoolExtra(db).usdMicros).toBe(9);
    expect(recordUsageShare(db, ON, { ...input, ref: 'usage:job:j2', billedMicros: 50 })).toBeNull(); // negative margin
    expect(recordUsageShare(db, { ...ON, sources: { ...ON.sources, network: false } }, { ...input, ref: 'usage:job:j3' })).toBeNull();
    expect(usageShareTotals(db)).toEqual({ marginUsd: 0.00003, toHoldersUsd: 0.000009, toTreasuryUsd: 0.000021, requests: 1 });
    expect(usageShareTotals(db, { source: 'upstream' })).toEqual({ marginUsd: 0, toHoldersUsd: 0, toTreasuryUsd: 0, requests: 0 });
  });
});

describe('usage-revenue share: gateway', () => {
  it('enabled: a network request books holderBps of (price − node reward) into pool_extra; an upstream request with a markup books holderBps of the markup', async () => {
    const { serveNetwork, serveUpstream, pool, poolRows, logRows, app } = await boot(cfg({ requestPricing: { ...testConfig.requestPricing, networkPricePerMTokens: 0.08, upstreamMarkupBps: 2000 } }));
    const { res, jobId } = await serveNetwork();
    expect(res.json().usage.cost).toBe(NET_BILLED / 1e6);
    expect(networkMicros(TOKENS)).not.toBe(NET_BILLED); // this test runs its own price, not the shipped 0.02
    expect(rewardMicros(TOKENS)).toBe(NET_REWARD);
    expect(poolRows()).toEqual([{ source: 'usage', usd_micros: NET_HOLDERS, ref: `usage:job:${jobId}` }]);
    expect(logRows()[0]).toMatchObject({ source: 'network', wallet: 'alice', model: 'llama-3.1-8b', billed_micros: NET_BILLED, cost_micros: NET_REWARD, margin_micros: NET_MARGIN, holder_micros: NET_HOLDERS, treasury_micros: NET_MARGIN - NET_HOLDERS });

    // upstream with 20% markup: billed 1200, cost 1000, margin 200, holders 60
    await serveUpstream(false);
    const up = logRows()[1];
    expect(up).toMatchObject({ source: 'upstream', model: 'mesh/mock', billed_micros: 1200, cost_micros: UP_LIST, margin_micros: 200, holder_micros: 60, treasury_micros: 140 });
    expect(pool().usdMicros).toBe(NET_HOLDERS + 60);
    // streaming upstream path books too
    await serveUpstream(true);
    expect(logRows().length).toBe(3);
    expect(pool().usdMicros).toBe(NET_HOLDERS + 120);

    // /report and /stats expose it
    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.usageShare).toMatchObject({
      enabled: true,
      holderBps: 3000,
      marginUsd: (NET_MARGIN + 400) / 1e6,
      toHoldersUsd: (NET_HOLDERS + 120) / 1e6,
      toTreasuryUsd: (NET_MARGIN - NET_HOLDERS + 280) / 1e6,
      requests: 3,
      bySource: {
        network: { marginUsd: NET_MARGIN / 1e6, toHoldersUsd: NET_HOLDERS / 1e6, requests: 1 },
        upstream: { marginUsd: 0.0004, toHoldersUsd: 0.00012, requests: 2 },
        marketplaceFee: { toHoldersUsd: 0, counted: true },
      },
    });
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats.usageShareToHolders24hUsd).toBe((NET_HOLDERS + 120) / 1e6);
    expect(stats.usageShareEnabled).toBe(true);
  });

  it('disabled (the shipped default): paid requests write nothing', async () => {
    const { serveNetwork, serveUpstream, pool, logRows, app } = await boot(cfg({}, { enabled: false }));
    await serveNetwork();
    await serveUpstream();
    expect(pool().usdMicros).toBe(0);
    expect(logRows()).toEqual([]);
    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.usageShare).toMatchObject({ enabled: false, marginUsd: 0, toHoldersUsd: 0, toTreasuryUsd: 0 });
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().usageShareToHolders24hUsd).toBe(0);
    expect(testConfig.usageShare.enabled).toBe(false);
  });

  it('negative margin contributes nothing: an upstream discount (billed < list) and a network price below the node reward', async () => {
    const discounted = await boot(cfg({ requestPricing: { ...testConfig.requestPricing, networkPricePerMTokens: 0.02, upstreamDiscountBps: 2500 } }));
    await discounted.serveUpstream(); // billed 750 vs cost 1000 → −250
    await discounted.serveNetwork(); // billed 30 vs reward 90 → −60
    expect(discounted.pool().usdMicros).toBe(0);
    expect(discounted.logRows()).toEqual([]);
    // list == billed (no markup, no discount) is a zero margin: nothing either
    const flat = await boot(cfg({ requestPricing: { ...testConfig.requestPricing, networkPricePerMTokens: 0.08 } }));
    await flat.serveUpstream();
    expect(flat.logRows()).toEqual([]);
  });

  it('guest messages never contribute even when enabled', async () => {
    const { app, pool, logRows } = await boot(cfg({ guest: { ...testConfig.guest, enabled: true } }, {}));
    const r = await app.inject({ method: 'POST', url: '/v1/guest/chat', payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(200);
    expect(pool().usdMicros).toBe(0);
    expect(logRows()).toEqual([]);
  });

  it('the epoch drains the usage share into the holder pool exactly once, alongside the marketplace share mechanism', async () => {
    const { app, serveNetwork, pool } = await boot(cfg());
    await serveNetwork();
    await serveNetwork();
    expect(pool().usdMicros).toBe(2 * NET_HOLDERS);
    const epochStart = 3_600;
    const r = await runEpoch({ db: app.ctx.db, adapter: app.ctx.adapter, config: cfg() }, epochStart);
    expect(r.status).toBe('complete');
    expect(r.holderPoolUsdMicros).toBe(2 * NET_HOLDERS); // no trading fees in this epoch: the pool is the usage share alone
    expect(r.distributed.reduce((a, d) => a + d.usdMicros, 0)).toBe(2 * NET_HOLDERS);
    expect(pool().usdMicros).toBe(0);
    const claimed = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM pool_extra_micros WHERE epoch_start = ? AND source = 'usage'`).get(epochStart) as { n: number };
    expect(claimed.n).toBe(2);
    const next = await runEpoch({ db: app.ctx.db, adapter: app.ctx.adapter, config: cfg() }, epochStart + 3600);
    expect(next.holderPoolUsdMicros).toBe(0);
  });
});
