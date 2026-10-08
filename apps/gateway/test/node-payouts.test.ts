import Database from 'better-sqlite3';
import { loadTokenomics, parseTokenomics, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, type Db } from '../src/db.js';
import { expireWallet } from '../src/expiry.js';
import { addNodeReward, balanceMicros, withholdNodeReward } from '../src/ledger.js';
import { nodePayoutTotals, nodePayoutView, payNodeRewards } from '../src/node-payouts.js';
import { ADMIN, memDb, testConfig, testServer } from './helpers.js';

/**
 * Node rewards are paid as AI credits, off chain (src/node-payouts.ts, docs/NODE_PROTOCOL.md §7): hourly,
 * after a hold, one ledger row per wallet, each reward paid exactly once. The credits are ordinary ones:
 * spendable, sellable on the marketplace for the settlement stablecoin, and they expire.
 */

type App = Awaited<ReturnType<typeof testServer>>['app'];
const M = 1_000_000;
const NOW = 1_800_000_000;
const PAYOUT: TokenomicsConfig['nodeRewards']['payout'] = { enabled: true, holdSeconds: 3600, minUsd: 0.01 };
const H = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

/** One completed job's reward, accrued `ageSec` before NOW. */
function reward(db: Db, wallet: string, usd: number, ageSec: number, nodeId = `node-${wallet}`, jobId?: string) {
  const id = addNodeReward(db, { wallet, nodeId, jobId: jobId ?? `job-${wallet}-${Math.random().toString(36).slice(2)}`, tokens: 1000, usdMicros: Math.round(usd * M) });
  db.prepare(`UPDATE node_rewards SET created_at = ? WHERE id = ?`).run(NOW - ageSec, id);
  return id;
}
const payouts = (db: Db, wallet: string) => (db.prepare(`SELECT delta_usd_micros AS d, kind, ref FROM credits_ledger WHERE wallet = ? ORDER BY id`).all(wallet) as Array<{ d: number; kind: string; ref: string }>).map((r) => `${r.kind}:${r.d / M}`);

describe('shipped config', () => {
  it('node rewards are paid as credits after an hour, and the marketplace settles in USDG', () => {
    const shipped = loadTokenomics();
    expect(shipped.nodeRewards.payout).toEqual({ enabled: true, holdSeconds: 3600, minUsd: 0.01 });
    expect(shipped.marketplace.settlementSymbol).toBe('USDG');
    // a config written before these keys existed keeps the old behaviour: rewards stay a counter
    const old = parseTokenomics({ ...testConfig, nodeRewards: { usdPerMTokens: 0.06 }, marketplace: { enabled: true } });
    expect(old.nodeRewards.payout.enabled).toBe(false);
    expect(old.marketplace.settlementSymbol).toBe('USDG');
    expect(old.marketplace.minWithdrawalUsd).toBe(0);
  });
});

describe('payNodeRewards', () => {
  it('pays what has been held long enough, one credit row per wallet, and never pays a reward twice', () => {
    const db = memDb();
    reward(db, 'alice', 0.5, 7200);
    reward(db, 'alice', 0.25, 4000);
    reward(db, 'alice', 0.1, 600); // inside the hold: waits
    reward(db, 'bob', 0.02, 5000);

    expect(payNodeRewards(db, PAYOUT, { now: NOW })).toEqual({ wallets: 2, rewards: 3, paidMicros: 770_000 });
    expect(balanceMicros(db, 'alice')).toBe(750_000);
    expect(balanceMicros(db, 'bob')).toBe(20_000);
    expect(payouts(db, 'alice')).toEqual(['node_payout:0.75']);
    expect(nodePayoutView(db, 'alice', PAYOUT)).toMatchObject({ enabled: true, paidAs: 'credits', paidUsd: 0.75, pendingUsd: 0.1 });
    // each paid reward points at the ledger row that paid it
    const stamped = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT paid_ledger_id) AS rows FROM node_rewards WHERE wallet = 'alice' AND paid_ledger_id IS NOT NULL`).get() as { n: number; rows: number };
    expect(stamped).toEqual({ n: 2, rows: 1 });

    // the same hour again: nothing new
    expect(payNodeRewards(db, PAYOUT, { now: NOW })).toEqual({ wallets: 0, rewards: 0, paidMicros: 0 });
    // an hour later the held reward is due
    expect(payNodeRewards(db, PAYOUT, { now: NOW + 3600 })).toEqual({ wallets: 1, rewards: 1, paidMicros: 100_000 });
    expect(payouts(db, 'alice')).toEqual(['node_payout:0.75', 'node_payout:0.1']);
    expect(nodePayoutTotals(db)).toEqual({ paidMicros: 870_000, wallets: 2, pendingMicros: 0 });
  });

  it('amounts below the minimum wait and are paid together once they add up', () => {
    const db = memDb();
    reward(db, 'carol', 0.004, 9000);
    expect(payNodeRewards(db, PAYOUT, { now: NOW }).paidMicros).toBe(0);
    expect(nodePayoutView(db, 'carol', PAYOUT)).toMatchObject({ paidUsd: 0, pendingUsd: 0.004 });
    reward(db, 'carol', 0.007, 8000);
    expect(payNodeRewards(db, PAYOUT, { now: NOW })).toEqual({ wallets: 1, rewards: 2, paidMicros: 11_000 });
  });

  it('a reward withheld by a spot check is never paid; one withheld after it was paid is clawed back', () => {
    const db = memDb();
    reward(db, 'dave', 0.3, 7200, 'node-dave', 'job-bad');
    reward(db, 'dave', 0.2, 7200, 'node-dave', 'job-good');
    withholdNodeReward(db, 'job-bad', 'verification_mismatch');
    expect(payNodeRewards(db, PAYOUT, { now: NOW })).toEqual({ wallets: 1, rewards: 1, paidMicros: 200_000 });
    expect(balanceMicros(db, 'dave')).toBe(200_000);

    // the verdict on job-good arrives late, after the payout
    withholdNodeReward(db, 'job-good', 'verification_mismatch');
    expect(balanceMicros(db, 'dave')).toBe(0);
    expect(payouts(db, 'dave')).toEqual(['node_payout:0.2', 'node_payout:-0.2']);
    expect(nodePayoutView(db, 'dave', PAYOUT)).toMatchObject({ paidUsd: 0, pendingUsd: 0 });
    expect(payNodeRewards(db, PAYOUT, { now: NOW + 86_400 }).paidMicros).toBe(0);
  });

  it('a quarantined node is not paid until an admin clears it', () => {
    const db = memDb();
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, last_seen, created_at, quarantined_at, quarantine_reason) VALUES ('node-q', 'erin', '', '[]', ?, ?, ?, 'two mismatches')`).run(NOW, NOW, NOW);
    reward(db, 'erin', 0.4, 7200, 'node-q');
    reward(db, 'erin', 0.1, 7200, 'node-ok');
    expect(payNodeRewards(db, PAYOUT, { now: NOW })).toEqual({ wallets: 1, rewards: 1, paidMicros: 100_000 });
    expect(nodePayoutView(db, 'erin', PAYOUT)).toMatchObject({ paidUsd: 0.1, pendingUsd: 0.4 });
    db.prepare(`UPDATE nodes SET quarantined_at = NULL, quarantine_reason = NULL WHERE node_id = 'node-q'`).run();
    expect(payNodeRewards(db, PAYOUT, { now: NOW }).paidMicros).toBe(400_000);
  });

  it('disabled: rewards stay a counter', () => {
    const db = memDb();
    reward(db, 'alice', 1, 99_999);
    expect(payNodeRewards(db, { ...PAYOUT, enabled: false }, { now: NOW })).toEqual({ wallets: 0, rewards: 0, paidMicros: 0 });
    expect(balanceMicros(db, 'alice')).toBe(0);
  });

  it('paid rewards are ordinary credits: they expire 90 days after they land', () => {
    const db = memDb();
    reward(db, 'alice', 2, 7200);
    payNodeRewards(db, PAYOUT, { now: NOW });
    const landed = (db.prepare(`SELECT created_at FROM credits_ledger WHERE wallet = 'alice'`).get() as { created_at: number }).created_at;
    const expiry = { enabled: true, days: 90 };
    expect(expireWallet(db, 'alice', expiry, landed + 89 * 86_400)).toBe(0);
    expect(expireWallet(db, 'alice', expiry, landed + 90 * 86_400)).toBe(2 * M);
  });
});

describe('node payouts over HTTP', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('the hourly chores pay the operator in credits; the credits can be listed and sold on the marketplace', async () => {
    const { app } = await testServer({});
    apps.push(app);
    const db = app.ctx.db;
    const now = Math.floor(Date.now() / 1000);
    const old = addNodeReward(db, { wallet: 'operator', nodeId: 'mac-1', jobId: 'job-1', tokens: 50_000_000, usdMicros: 3 * M });
    db.prepare(`UPDATE node_rewards SET created_at = ? WHERE id = ?`).run(now - 7200, old);
    addNodeReward(db, { wallet: 'operator', nodeId: 'mac-1', jobId: 'job-2', tokens: 1_000_000, usdMicros: 60_000 }); // just earned: inside the hold

    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'operator' } })).json().token as string;
    const before = (await app.inject({ method: 'GET', url: '/me/nodes', headers: H(jwt) })).json();
    expect(before).toMatchObject({ earnedUsdTotal: 3.06, payout: { enabled: true, paidAs: 'credits', holdSeconds: 3600, paidUsd: 0, pendingUsd: 3.06 } });

    const epoch = (await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: {} })).json();
    expect(epoch.housekeeping).toMatchObject({ nodePayoutWallets: 1, nodePayoutUsd: 3 });

    const me = (await app.inject({ method: 'GET', url: '/me', headers: H(jwt) })).json();
    expect(me.balance.usd).toBe(3);
    expect(me.ledger[0]).toMatchObject({ kind: 'node_payout', deltaUsd: 3 });
    expect(me.nonTransferableUsd).toBe(0); // earned credit is sellable
    expect((await app.inject({ method: 'GET', url: '/me/nodes', headers: H(jwt) })).json().payout).toMatchObject({ paidUsd: 3, pendingUsd: 0.06 });

    // cash in: list the credits, a buyer pays from a prepaid balance, the operator's proceeds can be withdrawn
    const listing = await app.inject({ method: 'POST', url: '/market/listings', headers: H(jwt), payload: { amountUsd: 2, discountBps: 2000 } });
    expect(listing.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: '/admin/prepaid', headers: ADMIN, payload: { wallet: 'buyer', amountUsd: 10, note: 'test' } });
    const buyer = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'buyer' } })).json().token as string;
    const fill = await app.inject({ method: 'POST', url: '/market/fills', headers: H(buyer), payload: { listingId: listing.json().id, amountUsd: 2 } });
    expect(fill.statusCode).toBe(201);
    const market = (await app.inject({ method: 'GET', url: '/me/market', headers: H(jwt) })).json();
    expect(market.prepaid.usd).toBe(1.56); // $2 at 20% off = $1.60, less the 2.5% fee
    expect(market.config.settlementSymbol).toBe('USDG');
    expect((await app.inject({ method: 'POST', url: '/me/market/withdraw', headers: H(jwt), payload: { amountUsd: 1.56 } })).statusCode).toBe(201);

    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.nodePayouts).toMatchObject({ enabled: true, paidAs: 'credits', paidUsd: 3, wallets: 1, pendingUsd: 0.06 });
    expect(report.method.nodePayouts).toMatch(/paid as AI credits, off chain/);
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats).toMatchObject({ nodeRewardsPaidAs: 'credits', marketSettlementSymbol: 'USDG' });
  });
});

describe('migration 21 on a populated database', () => {
  it('keeps the ledger, accepts node_payout, and leaves existing rewards unpaid', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE id = 21;
      DROP INDEX node_rewards_unpaid;
      ALTER TABLE node_rewards DROP COLUMN paid_ledger_id;
      CREATE TABLE credits_ledger_old (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, delta_usd_micros INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter','market_escrow','market_refund','market_buy','purchase','expiry')), ref TEXT, created_at INTEGER NOT NULL);
      DROP TABLE credits_ledger; ALTER TABLE credits_ledger_old RENAME TO credits_ledger;
      INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', 5000000, 'distribution', 'epoch:1', 100), ('a', -40, 'expiry', 'expiry:1', 200);
      INSERT INTO node_rewards (wallet, node_id, job_id, kind, tokens, usd_micros, created_at) VALUES ('op', 'n1', 'j1', 'node_reward', 10, 600, 100);
    `);
    expect(() => db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('op', 1, 'node_payout', 1)`).run()).toThrow(/CHECK/);
    migrate(db); // applies 21 only
    expect(db.prepare(`SELECT id, wallet, delta_usd_micros AS d, kind FROM credits_ledger ORDER BY id`).all()).toEqual([
      { id: 1, wallet: 'a', d: 5000000, kind: 'distribution' },
      { id: 2, wallet: 'a', d: -40, kind: 'expiry' },
    ]);
    expect(db.prepare(`SELECT wallet, usd_micros, paid_ledger_id FROM node_rewards`).all()).toEqual([{ wallet: 'op', usd_micros: 600, paid_ledger_id: null }]);
    expect(Number(db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('op', 600, 'node_payout', 1)`).run().lastInsertRowid)).toBe(3);
    expect(() => db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', 1, 'distribution', 'epoch:1', 1)`).run()).toThrow(/UNIQUE/);
  });
});
