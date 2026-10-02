import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { addNodeReward, addTreasuryEntry, treasuryBalanceMicros } from '../src/ledger.js';
import { isoWeekOf, parseIsoWeek, weekStartOf } from '../src/routes/report.js';
import { ADMIN, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];

describe('ISO weeks', () => {
  it('computes Monday-based UTC weeks and round-trips through parse', () => {
    // 2026-10-03 is a Saturday → week 2026-W40 starting Monday 2026-09-28
    const sat = Date.UTC(2026, 9, 3, 15) / 1000;
    const w = isoWeekOf(sat);
    expect(w.isoWeek).toBe('2026-W40');
    expect(new Date(w.start * 1000).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(w.end - w.start).toBe(7 * 86_400);
    expect(weekStartOf(w.start)).toBe(w.start);
    expect(parseIsoWeek('2026-W40')).toEqual(w);
    // year boundaries: 2021-01-01 is in 2020-W53; 2024-12-30 is in 2025-W01
    expect(isoWeekOf(Date.UTC(2021, 0, 1) / 1000).isoWeek).toBe('2020-W53');
    expect(isoWeekOf(Date.UTC(2024, 11, 30) / 1000).isoWeek).toBe('2025-W01');
    expect(parseIsoWeek('2025-W01')?.start).toBe(Date.UTC(2024, 11, 30) / 1000);
    expect(parseIsoWeek('2026-W53')?.isoWeek).toBe('2026-W53'); // 2026-01-01 is a Thursday → 53-week year
    expect(parseIsoWeek('2025-W53')).toBeNull(); // 2025 has 52 weeks
    expect(parseIsoWeek('2026-40')).toBeNull();
    expect(parseIsoWeek('2026-W00')).toBeNull();
  });
});

describe('treasury ledger', () => {
  it('fee_share is unique per epoch; node rewards accrue as a negative entry', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    const db = app.ctx.db;
    const E = 1_700_000_000 - (1_700_000_000 % 3600);
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 40 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E } }); // replay: skipped
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: E + 3600 } }); // empty: no row
    expect(db.prepare(`SELECT kind, usd_micros, ref FROM treasury_ledger`).all()).toEqual([{ kind: 'fee_share', usd_micros: 20_000_000, ref: `epoch:${E}` }]);
    expect(addTreasuryEntry(db, { kind: 'fee_share', usdMicros: 20_000_000, ref: `epoch:${E}` })).toBeNull();

    addNodeReward(db, { wallet: 'alice', nodeId: 'n1', jobId: 'job_1', tokens: 10_000, usdMicros: 1_500 });
    expect(() => addNodeReward(db, { wallet: 'alice', nodeId: 'n1', jobId: 'job_1', tokens: 10_000, usdMicros: 1_500 })).toThrow(); // unique job
    expect(db.prepare(`SELECT kind, usd_micros, ref FROM treasury_ledger WHERE kind='node_reward_accrual'`).all()).toEqual([
      { kind: 'node_reward_accrual', usd_micros: -1_500, ref: 'job:job_1' },
    ]);
    expect(treasuryBalanceMicros(db)).toBe(20_000_000 - 1_500);
    addTreasuryEntry(db, { kind: 'ops', usdMicros: -5_000_000, ref: 'ops:hosting-2026-10' });
    expect(treasuryBalanceMicros(db)).toBe(15_000_000 - 1_500);
    expect(() => addTreasuryEntry(db, { kind: 'other', usdMicros: 1.5 })).toThrow();
    await app.close();
  });
});

describe('GET /report and /report/weekly/:isoWeek', () => {
  let app: App;
  const now = nowSec();
  const thisWeek = weekStartOf(now);
  const lastWeekEpoch = thisWeek - 7 * 86_400 + 3600; // an epoch window inside last week
  const thisWeekEpoch = thisWeek; // first hour of this week (always in the past or now)
  beforeAll(async () => {
    ({ app } = await testServer({ holders: { alice: 75_000, bob: 25_000 } }));
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 100 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: lastWeekEpoch } });
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 40 } });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: thisWeekEpoch } });
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'friend', amountUsd: 3 } });
    // one request via the mock upstream, one logged as node-served, one node reward
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key;
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'x' }] } });
    app.ctx.db.prepare(`INSERT INTO requests_log (api_key_id, wallet, model, cost_usd_micros, upstream, latency_ms, created_at) VALUES (1,'alice','m',2000,'node:n1',1,?)`).run(now - 60);
    addNodeReward(app.ctx.db, { wallet: 'bob', nodeId: 'n1', jobId: 'job_r', tokens: 10_000, usdMicros: 1_500 });
  });
  afterAll(async () => app.close());

  it('/report has totals, windows, weekly series, treasury balance and method notes', async () => {
    const res = await app.inject({ method: 'GET', url: '/report' });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.feesIn).toBe(140);
    expect(r.creditsOut).toBe(70);
    expect(r.nodeRewards).toBe(0.0015);
    expect(r.treasuryBalanceUsd).toBe(70 - 0.0015);
    expect(r.epochsRun).toBe(2);
    expect(r.servedByNetworkPercent).toBe(50); // 1 of 2 requests
    expect(r.totals).toMatchObject({ feesInUsd: 140, creditsOutUsd: 70, starterCreditsUsd: 3, treasuryInUsd: 70, requests: 2, servedByNetwork: 1, servedByOpenRouter: 1, epochs: 2, completeEpochs: 2 });
    expect(r.totals.creditsUsedUsd).toBeCloseTo(0.001, 9); // the hand-inserted node request has no ledger row
    expect(r.totals.creditsOutstandingUsd).toBeCloseTo(73 - 0.001, 9);
    expect(r.totals.treasury).toMatchObject({ feeShareUsd: 70, nodeRewardAccrualUsd: -0.0015, buybackUsd: 0, opsUsd: 0, balanceUsd: 70 - 0.0015 });
    // windows: both epochs are within 30d; last7d includes this week's epoch and maybe last week's depending on the day
    expect(r.last30d.feesInUsd).toBe(140);
    expect(r.last7d.feesInUsd).toBeGreaterThanOrEqual(40);
    expect(r.last7d.nodeRewardsUsd).toBe(0.0015);
    expect(r.byWeek).toHaveLength(12);
    const cur = r.byWeek.at(-1);
    expect(cur).toMatchObject({ isoWeek: isoWeekOf(now).isoWeek, start: thisWeek, current: true, feesInUsd: 40, creditsOutUsd: 20, treasuryInUsd: 20, epochs: 1 });
    const prev = r.byWeek.at(-2);
    expect(prev).toMatchObject({ start: thisWeek - 7 * 86_400, current: false, feesInUsd: 100, creditsOutUsd: 50, epochs: 1, requests: 0 });
    expect(r.byWeek[0].feesInUsd).toBe(0);
    expect(r.method.credits).toMatch(/share of trading fees/);
    expect(r.lastUpdated).toBeGreaterThan(0);
    expect(r.holdingAge).toMatchObject({ enabled: false });
    expect(res.headers['cache-control']).toMatch(/max-age/);
  });

  it('/report/weekly/:isoWeek has days + epochs, and validates its parameter', async () => {
    const w = isoWeekOf(lastWeekEpoch);
    const res = await app.inject({ method: 'GET', url: `/report/weekly/${w.isoWeek}` });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ isoWeek: w.isoWeek, start: w.start, feesInUsd: 100, creditsOutUsd: 50, treasuryInUsd: 50, epochs: 1, current: false, next: isoWeekOf(now).isoWeek });
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toMatchObject({ day: new Date(w.start * 1000).toISOString().slice(0, 10), feesInUsd: 100 }); // epoch in the first hour of Monday
    expect(r.days.reduce((a: number, d: { feesInUsd: number }) => a + d.feesInUsd, 0)).toBe(100);
    expect(r.epochDetails).toHaveLength(1);
    expect(r.epochDetails[0]).toMatchObject({ epochStart: lastWeekEpoch, feesUsd: 100, holderPoolUsd: 50 });
    expect(r.epochDetails[0]).not.toHaveProperty('feeTxId');

    expect((await app.inject({ method: 'GET', url: '/report/weekly/2026-40' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/report/weekly/2025-W53' })).statusCode).toBe(400);
    const empty = (await app.inject({ method: 'GET', url: '/report/weekly/2020-W10' })).json();
    expect(empty).toMatchObject({ feesInUsd: 0, epochs: 0, requests: 0 });
    expect(empty.epochDetails).toEqual([]);
  });
});

describe('admin: key revocation by id, overview extras', () => {
  it('DELETE /admin/keys/:id revokes any wallet key and is audited', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    const created = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` }, payload: { name: 'leaked' } })).json();
    const ok = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${created.key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'x' }] } });
    expect(ok.statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/admin/keys/${created.id}` })).statusCode).toBe(401);
    const r = await app.inject({ method: 'DELETE', url: `/admin/keys/${created.id}`, headers: ADMIN });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: created.id, wallet: 'alice', revoked: true, alreadyRevoked: false });
    const again = await app.inject({ method: 'DELETE', url: `/admin/keys/${created.id}`, headers: ADMIN });
    expect(again.json().alreadyRevoked).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: '/admin/keys/9999', headers: ADMIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/admin/keys/abc', headers: ADMIN })).statusCode).toBe(400);

    const denied = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${created.key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'x' }] } });
    expect(denied.statusCode).toBe(401);

    const over = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json();
    expect(over.recentAdminActions.find((a: { action: string }) => a.action === 'revoke-key')).toMatchObject({ action: 'revoke-key', payload: { id: created.id, wallet: 'alice' } });
    // failed admin calls (404 / 400 above) are audited too
    expect(over.recentAdminActions.filter((a: { action: string }) => a.action === 'admin-denied').length).toBeGreaterThanOrEqual(2);
    expect(over.totals).toMatchObject({ activeApiKeys: 0, nodeRewardsUsd: 0, treasuryBalanceUsd: 0 });
    expect(over.holdingAge).toMatchObject({ enabled: false, maxDays: 30 });
    await app.close();
  });

  it('run-epoch response carries each holder multiplier', async () => {
    const { app } = await testServer({ holders: { alice: 10_000 } });
    await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 10 } });
    const r = (await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } })).json();
    expect(r.distributed).toEqual([{ wallet: 'alice', usd: 5, multiplier: 1 }]);
    expect(r.holdingAgeApplied).toBe(false);
    await app.close();
  });
});
