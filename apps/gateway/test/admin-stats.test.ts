import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { hourlySeries } from '../src/routes/stats.js';
import { ADMIN, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];

describe('admin: batch starter credits, audit, overview', () => {
  let app: App;
  const EPOCH = 1_700_000_000 - (1_700_000_000 % 3600);
  beforeAll(async () => {
    ({ app } = await testServer({ holders: { alice: 75_000, bob: 25_000 } }));
  });
  afterAll(async () => app.close());

  it('starter-credits batch is atomic and audited', async () => {
    const bad = await app.inject({ method: 'POST', url: '/admin/starter-credits', headers: ADMIN, payload: { items: [{ wallet: 'x', amountUsd: 1 }, { wallet: 'y', amountUsd: -1 }] } });
    expect(bad.statusCode).toBe(400);

    const r = await app.inject({
      method: 'POST',
      url: '/admin/starter-credits',
      headers: ADMIN,
      payload: { items: [{ wallet: 'friend1', amountUsd: 2 }, { wallet: 'friend2', amountUsd: 3 }, { wallet: 'friend1', amountUsd: 0.5 }], note: 'launch day' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ count: 3, totalUsd: 5.5 });
    expect(r.json().granted[2].balanceUsd).toBe(2.5);
    const batchId = r.json().batchId;

    const over = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    const actions = over.json().recentAdminActions;
    expect(actions[0]).toMatchObject({ id: batchId, action: 'starter-credits', payload: { count: 3, note: 'launch day' } });
    expect(over.json().totals.starterCreditsUsd).toBe(5.5);

    // the single variant is audited too
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'friend3', amountUsd: 1 } });
    const over2 = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    expect(over2.json().recentAdminActions[0]).toMatchObject({ action: 'starter-credit', payload: { wallet: 'friend3', amountUsd: 1 } });
    expect(over2.statusCode).toBe(200);
    const anon = await app.inject({ method: 'GET', url: '/admin/overview' });
    expect(anon.statusCode).toBe(401);
  });

  it('overview lists epochs, totals, top holders, nodes', async () => {
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 40 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: EPOCH } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: EPOCH + 3600 } }); // empty
    await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'n1', wallet: 'alice', url: 'http://h:1', models: ['a'], chip: 'M3 Max' } });

    const over = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json();
    expect(over.epochs).toHaveLength(2);
    expect(over.epochs[0]).toMatchObject({ epochStart: EPOCH + 3600, status: 'empty' });
    expect(over.epochs[1]).toMatchObject({ epochStart: EPOCH, status: 'complete', feesUsd: 40, holderPoolUsd: 20, treasuryUsd: 20 });
    expect(over.totals).toMatchObject({ feesUsd: 40, treasuryUsd: 20, creditsDistributedUsd: 20, starterCreditsUsd: 6.5, creditsOutstandingUsd: 26.5 });
    expect(over.topHolders[0]).toMatchObject({ wallet: 'alice', balanceUsd: 15, earnedUsd: 15 });
    expect(over.topHolders.length).toBeLessThanOrEqual(20);
    expect(over.nodes[0]).toMatchObject({ nodeId: 'n1', chip: 'M3 Max', online: true, wallet: 'alice' });
    expect(JSON.stringify(over.nodes[0])).not.toMatch(/token_hash|mesh_nt_/);
    expect(Array.isArray(over.recentErrors)).toBe(true);
  });
});

describe('public /stats', () => {
  it('has hourly series, token meta, nodesOnline and servedByNetworkPercent', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    const now = nowSec();
    const thisHour = Math.floor(now / 3600) * 3600;
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 10 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: thisHour - 3600 } });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key;
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'x' }] } });
    // a request from 3 hours ago, and one from 30 hours ago (outside the window)
    app.ctx.db.prepare(`INSERT INTO requests_log (api_key_id, wallet, model, cost_usd_micros, upstream, latency_ms, created_at) VALUES (1,'alice','m',500,'mock',1,?)`).run(now - 3 * 3600);
    app.ctx.db.prepare(`INSERT INTO requests_log (api_key_id, wallet, model, cost_usd_micros, upstream, latency_ms, created_at) VALUES (1,'alice','m',500,'mock',1,?)`).run(now - 30 * 3600);
    await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'n1', wallet: 'alice', url: 'http://h:1', models: [] } });

    const s = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(s.token).toMatchObject({ name: 'Mesh', ticker: 'MESH', tradeFeeBps: 150, holderShareBps: 5000, minHoldTokens: 1000 });
    expect(s.token.description).toBeTruthy();
    expect(s.holdersEligibleLastEpoch).toBe(1);
    expect(s.nodesOnline).toBe(1);
    expect(s.servedByNetworkPercent).toBe(0);
    expect(s.requestsLast24h).toBe(2);
    expect(s.series24h).toHaveLength(24);
    expect(s.series24h.at(-1).hour).toBe(thisHour);
    expect(s.series24h[0].hour).toBe(thisHour - 23 * 3600);
    expect(s.series24h.at(-1)).toMatchObject({ feesUsd: 10, creditsDistributedUsd: 5, requests: 1, spendUsd: 0.001 });
    const threeAgo = s.series24h.find((p: { hour: number }) => p.hour === Math.floor((now - 3 * 3600) / 3600) * 3600);
    expect(threeAgo).toMatchObject({ requests: 1, spendUsd: 0.0005 });
    expect(s.series24h.reduce((a: number, p: { requests: number }) => a + p.requests, 0)).toBe(2);
    expect(hourlySeries(app.ctx, now)).toEqual(s.series24h);
    await app.close();
  });

  it('is cached for STATS_CACHE_MS', async () => {
    const { app } = await testServer({ env: { STATS_CACHE_MS: 10_000 } });
    const a = await app.inject({ method: 'GET', url: '/stats' });
    expect(a.json().totalFeesUsd).toBe(0);
    expect(a.headers['cache-control']).toBe('public, max-age=10');
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 10 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } });
    const b = await app.inject({ method: 'GET', url: '/stats' });
    expect(b.json().totalFeesUsd).toBe(0); // still cached
    expect(b.json().generatedAt).toBe(a.json().generatedAt);
    const over = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    expect(over.json().totals.feesUsd).toBe(10); // admin view is live
    await app.close();
  });
});

describe('public /epochs and feesThisEpochUsd', () => {
  it('lists epochs newest first, honours limit, hides fee tx ids', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    const E = 1_700_000_000 - (1_700_000_000 % 3600);
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 40 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E + 3600 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E + 7200 } });

    const all = (await app.inject({ method: 'GET', url: '/epochs' })).json();
    expect(all.total).toBe(3);
    expect(all.limit).toBe(48);
    expect(all.epochs).toHaveLength(3);
    expect(all.epochs[0]).toMatchObject({ epochStart: E + 7200, status: 'empty', feesUsd: 0 });
    expect(all.epochs[2]).toMatchObject({ epochStart: E, epochEnd: E + 3600, status: 'complete', feesUsd: 40, holderPoolUsd: 20, treasuryUsd: 20, eligibleHolders: 1 });
    expect(all.epochs[2]).not.toHaveProperty('feeTxId');
    expect(all.epochs[2]).not.toHaveProperty('fee_tx_id');

    const two = (await app.inject({ method: 'GET', url: '/epochs?limit=2' })).json();
    expect(two.epochs.map((e: { epochStart: number }) => e.epochStart)).toEqual([E + 7200, E + 3600]);
    expect(two.total).toBe(3);

    expect((await app.inject({ method: 'GET', url: '/epochs?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/epochs?limit=abc' })).statusCode).toBe(400);
    await app.close();
  });

  it('/stats.feesThisEpochUsd tracks pending mock fees and resets after an epoch', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().feesThisEpochUsd).toBe(0);
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 12.5 } });
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().feesThisEpochUsd).toBe(12.5);
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } });
    const s = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(s.feesThisEpochUsd).toBe(0);
    expect(s.totalFeesUsd).toBe(12.5);
    await app.close();
  });
});
