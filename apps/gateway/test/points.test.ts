import { MockAdapter } from '@mesh/chain-adapter';
import { parseTokenomics, type TokenomicsConfig } from '@mesh/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { runEpoch } from '../src/jobs/distribute.js';
import { addLedgerEntry, addNodeReward, ensureWallet } from '../src/ledger.js';
import {
  REFERRAL_CODE_RE,
  awardPoints,
  claimReferral,
  getOrCreateReferralCode,
  leaderboardRows,
  pointsBalance,
  pointsForCreditsMicros,
  pointsForNodeTokens,
  pointsForSpendMicros,
  pointsSummary,
  referralSummary,
  syncPoints,
  truncateWallet,
  utcDayStart,
} from '../src/points.js';
import { referralLink } from '../src/routes/referrals.js';
import { ADMIN, memDb, testConfig, testServer } from './helpers.js';

// The programme is built but disabled in config/tokenomics.json (`points.enabled: false`). These
// tests exercise it switched on through a config override; the last block checks the off state.
const pointsOn: TokenomicsConfig = { ...testConfig, points: { ...testConfig.points, enabled: true } };
const cfg = pointsOn.points;
const DAY = 86_400;

describe('points: config', () => {
  it('config defaults match the programme, disabled by default, and tokenomics.json ships it off', () => {
    const { points: _omit, ...withoutPoints } = testConfig as typeof testConfig & { points?: unknown };
    const parsed = parseTokenomics(withoutPoints);
    expect(parsed.points).toEqual({ enabled: false, perUsdCredits: 100, perUsdSpent: 50, perNodeTokenK: 1, perReferralSignup: 500, referralShareBps: 1000, dailyCapPerWallet: 50_000 });
    expect(testConfig.points).toEqual(parsed.points);
    expect(testConfig.points.enabled).toBe(false);
    expect(() => parseTokenomics({ ...testConfig, points: { referralShareBps: 20_000 } })).toThrow();
  });

  it('rates: per $1 credits, per $1 spent, per 1k tokens, kept to a thousandth of a point', () => {
    expect(pointsForCreditsMicros(cfg, 1_000_000)).toBe(100);
    expect(pointsForCreditsMicros(cfg, 30_000)).toBe(3);
    expect(pointsForSpendMicros(cfg, 1_000)).toBe(0.05); // a $0.001 request still accrues
    expect(pointsForSpendMicros(cfg, -5)).toBe(0);
    expect(pointsForNodeTokens(cfg, 1_000)).toBe(1);
    expect(pointsForNodeTokens(cfg, 2_500)).toBe(2.5);
  });
});

describe('points: awarding', () => {
  it('awardPoints is idempotent per (wallet, kind, ref) and keeps kinds apart', () => {
    const db = memDb();
    expect(awardPoints(db, cfg, { wallet: 'a', kind: 'credits', points: 10, ref: 'credit:1' })).toMatchObject({ points: 10, capped: false });
    expect(awardPoints(db, cfg, { wallet: 'a', kind: 'credits', points: 10, ref: 'credit:1' })).toBeNull();
    expect(awardPoints(db, cfg, { wallet: 'a', kind: 'usage', points: 1, ref: 'credit:1' })).not.toBeNull(); // different kind, same ref string
    expect(awardPoints(db, cfg, { wallet: 'b', kind: 'credits', points: 10, ref: 'credit:1' })).not.toBeNull(); // different wallet
    expect(pointsBalance(db, 'a')).toBe(11);
    expect(pointsBalance(db, 'b')).toBe(10);
  });

  it('daily cap clamps per UTC day; adjustments are exempt; a fully clamped award still spends its ref', () => {
    const db = memDb();
    const small = { ...cfg, dailyCapPerWallet: 100 };
    const day = utcDayStart(1_800_000_000);
    expect(awardPoints(db, small, { wallet: 'a', kind: 'credits', points: 80, ref: 'c1', ts: day + 10 })).toMatchObject({ points: 80, capped: false });
    expect(awardPoints(db, small, { wallet: 'a', kind: 'usage', points: 50, ref: 'u1', ts: day + 20 })).toMatchObject({ points: 20, requested: 50, capped: true });
    const zero = awardPoints(db, small, { wallet: 'a', kind: 'node', points: 5, ref: 'n1', ts: day + 30 });
    expect(zero).toMatchObject({ points: 0, capped: true });
    expect(awardPoints(db, small, { wallet: 'a', kind: 'node', points: 5, ref: 'n1', ts: day + 30 })).toBeNull(); // ref spent even though 0 was credited
    // admin adjustments ignore the cap, in both directions
    expect(awardPoints(db, small, { wallet: 'a', kind: 'adjustment', points: 1000, ref: 'admin:1', ts: day + 40 })).toMatchObject({ points: 1000, capped: false });
    expect(awardPoints(db, small, { wallet: 'a', kind: 'adjustment', points: -200, ref: 'admin:2', ts: day + 41 })).toMatchObject({ points: -200 });
    // next day the cap resets
    expect(awardPoints(db, small, { wallet: 'a', kind: 'credits', points: 80, ref: 'c2', ts: day + DAY + 1 })).toMatchObject({ points: 80, capped: false });
    expect(pointsBalance(db, 'a')).toBe(80 + 20 + 0 + 1000 - 200 + 80);
    // cap 0 = no cap
    expect(awardPoints(db, { ...cfg, dailyCapPerWallet: 0 }, { wallet: 'z', kind: 'credits', points: 1e6, ref: 'big' })).toMatchObject({ points: 1e6, capped: false });
  });

  it('syncPoints awards distributions, usage and node tokens once each, and resumes from its cursor', () => {
    const db = memDb();
    for (const w of ['alice', 'bob']) ensureWallet(db, w, 'solana');
    addLedgerEntry(db, { wallet: 'alice', deltaMicros: 2_000_000, kind: 'distribution', ref: 'epoch:1' }); // $2 -> 200
    addLedgerEntry(db, { wallet: 'alice', deltaMicros: 5_000_000, kind: 'starter', ref: 'starter:1' }); // starter credits earn nothing
    addLedgerEntry(db, { wallet: 'alice', deltaMicros: -100_000, kind: 'usage', ref: 'req:1' }); // $0.10 -> 5
    addNodeReward(db, { wallet: 'bob', nodeId: 'n1', jobId: 'j1', tokens: 3_000, usdMicros: 180 }); // 3k tokens -> 3

    const first = syncPoints(db, cfg);
    expect(first).toEqual({ entries: 3, points: 208 });
    expect(pointsBalance(db, 'alice')).toBe(205);
    expect(pointsBalance(db, 'bob')).toBe(3);

    // nothing new: no-op
    expect(syncPoints(db, cfg)).toEqual({ entries: 0, points: 0 });
    // a payout row is not a served job
    addNodeReward(db, { wallet: 'bob', nodeId: 'n1', tokens: 0, usdMicros: -180, kind: 'payout' });
    addNodeReward(db, { wallet: 'bob', nodeId: 'n1', jobId: 'j2', tokens: 500, usdMicros: 30 });
    expect(syncPoints(db, cfg)).toEqual({ entries: 1, points: 0.5 });
    expect(pointsBalance(db, 'bob')).toBe(3.5);
    // disabled programme: nothing is written
    addLedgerEntry(db, { wallet: 'alice', deltaMicros: 1_000_000, kind: 'distribution', ref: 'epoch:2' });
    expect(syncPoints(db, { ...cfg, enabled: false })).toEqual({ entries: 0, points: 0 });
    expect(pointsBalance(db, 'alice')).toBe(205);
    // ...and is picked up once re-enabled
    expect(syncPoints(db, cfg).entries).toBe(1);
    expect(pointsBalance(db, 'alice')).toBe(305);
  });

  it('runEpoch awards holder points for the credits it distributes, and a replayed epoch does not double them', async () => {
    const db = memDb();
    const adapter = new MockAdapter({ holders: { alice: 5_000, bob: 5_000 } });
    adapter.pushFees(10); // $10 fees -> $5 to holders -> $2.50 each -> 250 points each
    await runEpoch({ db, adapter, config: pointsOn }, 7200);
    expect(pointsBalance(db, 'alice')).toBe(250);
    expect(pointsBalance(db, 'bob')).toBe(250);
    adapter.pushFees(10);
    await runEpoch({ db, adapter, config: pointsOn }, 7200); // skipped
    syncPoints(db, cfg);
    expect(pointsBalance(db, 'alice')).toBe(250);
    const s = pointsSummary(db, cfg, 'alice');
    expect(s.byKind.credits).toBe(250);
    expect(s.rank).toBe(1); // tied on points, ranks count strictly-greater wallets
    expect(s.recent[0]).toMatchObject({ kind: 'credits', points: 250, ref: expect.stringMatching(/^credit:\d+$/) });
  });
});

describe('points: referrals', () => {
  it('codes are 6 chars from the unambiguous alphabet, one per wallet, stable across calls', () => {
    const db = memDb();
    const a = getOrCreateReferralCode(db, 'alice');
    expect(a).toMatch(REFERRAL_CODE_RE);
    expect(a).toHaveLength(6);
    expect(getOrCreateReferralCode(db, 'alice')).toBe(a);
    expect(getOrCreateReferralCode(db, 'bob')).not.toBe(a);
    expect(referralLink({ CORS_ORIGINS: 'https://mesh.app, https://other', AUTH_URI: 'https://x', AUTH_DOMAIN: 'x' } as never, a)).toBe(`https://mesh.app/?ref=${a}`);
    expect(referralLink({ CORS_ORIGINS: '*', AUTH_URI: undefined, AUTH_DOMAIN: 'gw.mesh' } as never, a)).toBe(`https://gw.mesh/?ref=${a}`);
  });

  it('claim: once per wallet, not self, not circular, unknown and malformed codes rejected; referrer gets the signup bonus', () => {
    const db = memDb();
    const code = getOrCreateReferralCode(db, 'alice');
    expect(claimReferral(db, cfg, { wallet: 'alice', code })).toEqual({ ok: false, error: 'self_referral' });
    expect(claimReferral(db, cfg, { wallet: 'bob', code: 'nope' })).toEqual({ ok: false, error: 'invalid_code' });
    expect(claimReferral(db, cfg, { wallet: 'bob', code: 'ZZZZZZ' })).toEqual({ ok: false, error: 'unknown_code' });
    expect(claimReferral(db, cfg, { wallet: 'bob', code: ` ${code.toLowerCase()} ` })).toEqual({ ok: true, referrer: 'alice', pointsAwarded: 500 });
    expect(claimReferral(db, cfg, { wallet: 'bob', code: getOrCreateReferralCode(db, 'carol') })).toEqual({ ok: false, error: 'already_referred' });
    // alice may not now claim bob's code
    expect(claimReferral(db, cfg, { wallet: 'alice', code: getOrCreateReferralCode(db, 'bob') })).toEqual({ ok: false, error: 'circular_referral' });
    expect(claimReferral(db, { ...cfg, enabled: false }, { wallet: 'dave', code })).toEqual({ ok: false, error: 'disabled' });
    expect(pointsBalance(db, 'alice')).toBe(500);
    expect(referralSummary(db, cfg, 'alice')).toMatchObject({ code, referred: 1, pointsEarned: 500, pointsFromSignups: 500, pointsFromShare: 0, referredBy: null });
    expect(referralSummary(db, cfg, 'bob')).toMatchObject({ referred: 0, pointsEarned: 0, referredBy: 'alice' });
  });

  it('referrer earns referralShareBps of the referee\'s earned points (post-cap), never of bonuses or adjustments', () => {
    const db = memDb();
    const code = getOrCreateReferralCode(db, 'alice');
    claimReferral(db, cfg, { wallet: 'bob', code, ts: 1_800_000_000 });
    const ts = 1_800_000_100;
    awardPoints(db, cfg, { wallet: 'bob', kind: 'credits', points: 1000, ref: 'c1', ts }); // alice +100
    awardPoints(db, cfg, { wallet: 'bob', kind: 'usage', points: 0.05, ref: 'u1', ts }); // alice +0.005
    awardPoints(db, cfg, { wallet: 'bob', kind: 'adjustment', points: 1000, ref: 'adm', ts }); // no share
    expect(pointsBalance(db, 'bob')).toBe(2000.05);
    expect(pointsBalance(db, 'alice')).toBe(500 + 100 + 0.005);
    const s = referralSummary(db, cfg, 'alice');
    expect(s.pointsFromShare).toBe(100.005);
    // bob refers carol: carol's earnings share to bob only (no chain to alice)
    claimReferral(db, cfg, { wallet: 'carol', code: getOrCreateReferralCode(db, 'bob'), ts });
    awardPoints(db, cfg, { wallet: 'carol', kind: 'node', points: 10, ref: 'n1', ts });
    expect(pointsBalance(db, 'bob')).toBe(2000.05 + 500 + 1);
    expect(pointsBalance(db, 'alice')).toBe(600.005);
    // the share is capped by the referrer's own daily cap
    const tiny = { ...cfg, dailyCapPerWallet: 10 };
    awardPoints(db, tiny, { wallet: 'carol', kind: 'credits', points: 10, ref: 'c2', ts: ts + DAY }); // carol gets 10, bob gets min(1, 10 - earned today)
    awardPoints(db, tiny, { wallet: 'carol', kind: 'credits', points: 10, ref: 'c3', ts: ts + DAY }); // carol capped to 0 -> no share row with points
    expect(pointsBalance(db, 'carol')).toBe(20);
    expect(pointsBalance(db, 'bob')).toBe(2000.05 + 500 + 1 + 1);
  });
});

describe('points: leaderboards (pure)', () => {
  it('orders holders by credits earned, nodes by tokens, points by balance, referrers by count; truncates wallets', () => {
    const db = memDb();
    addLedgerEntry(db, { wallet: 'alice', deltaMicros: 3_000_000, kind: 'distribution', ref: 'e1' });
    addLedgerEntry(db, { wallet: 'bob', deltaMicros: 5_000_000, kind: 'distribution', ref: 'e1' });
    addLedgerEntry(db, { wallet: 'bob', deltaMicros: -4_000_000, kind: 'usage', ref: 'r1' }); // spend does not reduce "earned"
    addLedgerEntry(db, { wallet: 'carol', deltaMicros: 9_000_000, kind: 'starter', ref: 's1' }); // starter is not earned
    addNodeReward(db, { wallet: 'dave', nodeId: 'n1', jobId: 'j1', tokens: 100, usdMicros: 6 });
    addNodeReward(db, { wallet: 'dave', nodeId: 'n1', jobId: 'j2', tokens: 100, usdMicros: 6 });
    addNodeReward(db, { wallet: 'erin', nodeId: 'n2', jobId: 'j3', tokens: 150, usdMicros: 9 });
    syncPoints(db, cfg);
    const code = getOrCreateReferralCode(db, 'alice');
    claimReferral(db, cfg, { wallet: 'bob', code });
    claimReferral(db, cfg, { wallet: 'carol', code });
    claimReferral(db, cfg, { wallet: 'dave', code: getOrCreateReferralCode(db, 'erin') });

    expect(leaderboardRows(db, 'holders')).toEqual([
      { wallet: 'bob', value: 5, secondary: null },
      { wallet: 'alice', value: 3, secondary: null },
    ]);
    expect(leaderboardRows(db, 'nodes')).toEqual([
      { wallet: 'dave', value: 200, secondary: 2 },
      { wallet: 'erin', value: 150, secondary: 1 },
    ]);
    // alice: 300 credits + 2 signups; bob's points pre-date the claim so no share flows (only future points do)
    const pts = leaderboardRows(db, 'points');
    expect(pts[0]).toEqual({ wallet: 'alice', value: 1300, secondary: null });
    expect(pts.map((r) => r.wallet)).toEqual(['alice', 'bob', 'erin', 'dave']); // bob 500+200, erin 500+0.15, dave 0.2
    expect(leaderboardRows(db, 'referrers')).toEqual([
      { wallet: 'alice', value: 2, secondary: 1000 },
      { wallet: 'erin', value: 1, secondary: 500 },
    ]);
    expect(truncateWallet('9xQeKf2sVbT7mRw3Lp8nHJq4cYzA6dEuGk1oXiSNHn4k')).toBe('9xQe…Hn4k');
    expect(truncateWallet('alice')).toBe('al…');
  });
});

describe('points: HTTP', () => {
  type App = Awaited<ReturnType<typeof testServer>>['app'];
  let app: App;
  let alice: string;
  let bob: string;
  const auth = (jwt: string) => ({ authorization: `Bearer ${jwt}` });
  const login = async (wallet: string) => (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token as string;

  beforeAll(async () => {
    ({ app } = await testServer({ holders: { alice: 75_000, bob: 25_000 }, config: pointsOn }));
    alice = await login('alice');
    bob = await login('bob');
  });
  afterAll(async () => app.close());

  it('GET /stats reports pointsEnabled: true when switched on', async () => {
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().pointsEnabled).toBe(true);
  });

  it('GET /points/rules is public; /me/points and /me/referral need a session', async () => {
    const rules = await app.inject({ method: 'GET', url: '/points/rules' });
    expect(rules.statusCode).toBe(200);
    expect(rules.json()).toMatchObject({ enabled: true, perUsdCredits: 100, referralSharePercent: 10, dailyCapPerWallet: 50_000 });
    expect(rules.json().conversion).toContain('not a promise');
    expect((await app.inject({ method: 'GET', url: '/me/points' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/me/referral' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/referrals/claim', payload: { code: 'ABCDEF' } })).statusCode).toBe(401);
  });

  it('a chat completion earns spend points for the key\'s wallet (visible on /me/points with a 24h delta)', async () => {
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: auth(alice), payload: { label: 't' } })).json().key as string;
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(200); // mock upstream charges $0.001 -> 0.05 points
    const me = await app.inject({ method: 'GET', url: '/me/points', headers: auth(alice) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ wallet: 'alice', points: 0.05, delta24h: 0.05, today: 0.05, dailyCap: 50_000, rank: 1 });
    expect(me.json().byKind.usage).toBe(0.05);
    expect(me.json().recent[0]).toMatchObject({ kind: 'usage', points: 0.05 });
  });

  it('referral flow over HTTP: code + link on /me/referral, claim once, errors are typed', async () => {
    const mine = await app.inject({ method: 'GET', url: '/me/referral', headers: auth(alice) });
    expect(mine.statusCode).toBe(200);
    const code = mine.json().code as string;
    expect(code).toMatch(REFERRAL_CODE_RE);
    expect(mine.json().link).toContain(`/?ref=${code}`);
    expect(mine.json()).toMatchObject({ referred: 0, pointsEarned: 0, referredBy: null, perReferralSignup: 500, referralSharePercent: 10 });

    const self = await app.inject({ method: 'POST', url: '/referrals/claim', headers: auth(alice), payload: { code } });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('self_referral');

    const ok = await app.inject({ method: 'POST', url: '/referrals/claim', headers: auth(bob), payload: { code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ wallet: 'bob', referrer: 'al…', referrerPointsAwarded: 500, sharePercent: 10 });

    const again = await app.inject({ method: 'POST', url: '/referrals/claim', headers: auth(bob), payload: { code } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_referred');
    expect((await app.inject({ method: 'POST', url: '/referrals/claim', headers: auth(bob), payload: { code: 'ZZZZZZ' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/referrals/claim', headers: auth(bob), payload: {} })).statusCode).toBe(400);

    const after = await app.inject({ method: 'GET', url: '/me/referral', headers: auth(alice) });
    expect(after.json()).toMatchObject({ referred: 1, pointsEarned: 500, pointsFromSignups: 500 });
    expect((await app.inject({ method: 'GET', url: '/me/referral', headers: auth(bob) })).json().referredBy).toBe('al…');
  });

  it('distribution over HTTP credits holder points and the referrer\'s share', async () => {
    app.ctx.adapter instanceof MockAdapter && (app.ctx.adapter as MockAdapter).pushFees(100); // $50 to holders: alice $37.50, bob $12.50
    const run = await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } });
    expect(run.statusCode).toBe(200);
    const a = (await app.inject({ method: 'GET', url: '/me/points', headers: auth(alice) })).json();
    const b = (await app.inject({ method: 'GET', url: '/me/points', headers: auth(bob) })).json();
    expect(b.byKind.credits).toBe(1250);
    expect(a.byKind.credits).toBe(3750);
    expect(a.byKind.referral_share).toBe(125); // 10% of bob's 1250
    expect(a.byKind.referral_signup).toBe(500);
    expect(a.points).toBeCloseTo(3750 + 125 + 500 + 0.05, 3);
  });

  it('GET /leaderboard/:board: public, truncated wallets, limit, caller rank with a session, 404 on unknown board', async () => {
    const pub = await app.inject({ method: 'GET', url: '/leaderboard/points?limit=1' });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['cache-control']).toBe('public, max-age=30');
    expect(pub.json()).toMatchObject({ board: 'points', unit: 'points', limit: 1, total: 2, me: null });
    expect(pub.json().rows).toEqual([{ rank: 1, wallet: 'al…', value: expect.any(Number), secondary: null }]);

    const asBob = await app.inject({ method: 'GET', url: '/leaderboard/points', headers: auth(bob) });
    expect(asBob.json().me).toEqual({ rank: 2, wallet: 'bob', value: 1250, secondary: null });
    expect(asBob.json().rows).toHaveLength(2);

    const holders = await app.inject({ method: 'GET', url: '/leaderboard/holders', headers: auth(alice) });
    expect(holders.json().rows.map((r: { wallet: string; value: number }) => [r.wallet, r.value])).toEqual([
      ['al…', 37.5],
      ['bo…', 12.5],
    ]);
    expect(holders.json().me).toMatchObject({ rank: 1, wallet: 'alice', value: 37.5 });

    const refs = await app.inject({ method: 'GET', url: '/leaderboard/referrers' });
    expect(refs.json().rows).toEqual([{ rank: 1, wallet: 'al…', value: 1, secondary: 625 }]);
    expect(refs.json().secondaryLabel).toBe('points');

    const nodes = await app.inject({ method: 'GET', url: '/leaderboard/nodes', headers: auth(bob) });
    expect(nodes.json().rows).toEqual([]);
    expect(nodes.json().me).toEqual({ rank: null, wallet: 'bob', value: 0, secondary: null });

    expect((await app.inject({ method: 'GET', url: '/leaderboard/whales' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/leaderboard/points?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/leaderboard/points?limit=101' })).statusCode).toBe(400);
  });

  it('leaderboard responses are cached for 30 s per board', async () => {
    const before = (await app.inject({ method: 'GET', url: '/leaderboard/points' })).json();
    awardPoints(app.ctx.db, cfg, { wallet: 'carol', kind: 'credits', points: 1e6, ref: 'late' });
    const cached = await app.inject({ method: 'GET', url: '/leaderboard/points' });
    expect(cached.json().total).toBe(before.total); // carol is not visible yet
    expect(Number(cached.headers['x-cache-age-ms'])).toBeGreaterThanOrEqual(0);
    // another board is computed fresh and sees her
    expect((await app.inject({ method: 'GET', url: '/leaderboard/holders' })).json().total).toBe(2);
  });

  it('POST /admin/points/adjust needs the admin token, is audited, invalidates the cache and is idempotent per ref', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/points/adjust', payload: { wallet: 'bob', points: 10, note: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/points/adjust', headers: ADMIN, payload: { wallet: 'bob', points: 0, note: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/points/adjust', headers: ADMIN, payload: { wallet: 'bob', points: 5 } })).statusCode).toBe(400); // note required

    const r = await app.inject({ method: 'POST', url: '/admin/points/adjust', headers: ADMIN, payload: { wallet: 'bob', points: -250, note: 'sybil cluster', ref: 'case-7' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ wallet: 'bob', points: -250, applied: true, balance: 1000, note: 'sybil cluster' });
    const dup = await app.inject({ method: 'POST', url: '/admin/points/adjust', headers: ADMIN, payload: { wallet: 'bob', points: -250, note: 'sybil cluster', ref: 'case-7' } });
    expect(dup.json()).toMatchObject({ applied: false, points: 0, balance: 1000 });

    const over = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    const actions = over.json().recentAdminActions.filter((a: { action: string }) => a.action === 'points-adjust');
    expect(actions).toHaveLength(2); // the no-op replay is audited too
    const action = actions.find((a: { id: number }) => a.id === r.json().actionId);
    expect(action).toMatchObject({ payload: { wallet: 'bob', points: -250, note: 'sybil cluster', ref: 'case-7' } });

    // the adjust is exempt from the cap and visible immediately on the (invalidated) leaderboard
    const lb = await app.inject({ method: 'GET', url: '/leaderboard/points', headers: auth(bob) });
    expect(lb.json().me.value).toBe(1000);
    expect(lb.json().total).toBe(3); // carol from the previous test is visible now
  });

  it('wallet summary reports today vs the cap and the cap clamps live awards', async () => {
    const now = nowSec();
    const s = (await app.inject({ method: 'GET', url: '/me/points', headers: auth(bob) })).json();
    expect(s.today).toBe(1250); // adjustments do not count toward the cap
    expect(s.dailyCap).toBe(50_000);
    const big = awardPoints(app.ctx.db, cfg, { wallet: 'bob', kind: 'credits', points: 60_000, ref: 'whale', ts: now });
    expect(big).toMatchObject({ points: 48_750, capped: true });
  });
});

describe('points: disabled (the shipped default)', () => {
  type App = Awaited<ReturnType<typeof testServer>>['app'];
  let app: App;
  const auth = (jwt: string) => ({ authorization: `Bearer ${jwt}` });
  beforeAll(async () => {
    ({ app } = await testServer({ holders: { alice: 75_000, bob: 25_000 } })); // testConfig: points.enabled false
  });
  afterAll(async () => app.close());

  it('/stats says pointsEnabled: false', async () => {
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().pointsEnabled).toBe(false);
  });

  it('every points, leaderboard and referral route is 404, before auth, with the generic not-found body', async () => {
    const alice = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
    const routes: Array<{ method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; payload?: unknown }> = [
      { method: 'GET', url: '/points/rules' },
      { method: 'GET', url: '/leaderboard/points' },
      { method: 'GET', url: '/leaderboard/holders?limit=5', headers: auth(alice) },
      { method: 'GET', url: '/me/points' },
      { method: 'GET', url: '/me/points', headers: auth(alice) },
      { method: 'GET', url: '/me/referral', headers: auth(alice) },
      { method: 'POST', url: '/referrals/claim', headers: auth(alice), payload: { code: 'ABCDEF' } },
    ];
    for (const r of routes) {
      const res = await app.inject(r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found', statusCode: 404 });
      expect(res.json().message).toContain('Unknown route');
    }
  });

  it('awards nothing: a chat completion and an epoch write no points rows', async () => {
    const alice = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: auth(alice), payload: { label: 't' } })).json().key as string;
    expect((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } })).statusCode).toBe(200);
    (app.ctx.adapter as MockAdapter).pushFees(100);
    expect((await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } })).statusCode).toBe(200);
    expect((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get() as { n: number }).n).toBe(0);
    expect(pointsBalance(app.ctx.db, 'alice')).toBe(0);
    // the ledger itself still works and is picked up once re-enabled
    expect(syncPoints(app.ctx.db, cfg).entries).toBeGreaterThan(0);
    expect(pointsBalance(app.ctx.db, 'alice')).toBeGreaterThan(0);
  });

  it('admin adjustments remain available (audited) so a ledger can be fixed before a re-enable', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/points/adjust', headers: ADMIN, payload: { wallet: 'bob', points: 10, note: 'pre-enable fix' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ wallet: 'bob', points: 10, applied: true });
  });
});
