import { MockAdapter, type ReserveReading } from '@mesh/chain-adapter';
import { loadTokenomics, parseTokenomics, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertMonitor } from '../src/alerts.js';
import type { Db } from '../src/db.js';
import { buyCredits, directSalesTotals } from '../src/direct-sales.js';
import { expireAll, expireWallet, expiryOutlook, lapsedMicros, nonTransferableMicros } from '../src/expiry.js';
import { logSweepWarnings } from '../src/jobs/housekeeping.js';
import { balanceMicros, ensureWallet } from '../src/ledger.js';
import { MarketError, prepaidBalanceMicros, topUpPrepaid } from '../src/market.js';
import { reserveView, snapshotReserve } from '../src/reserve-report.js';
import { ADMIN, SHIPPED_PRICING, grantCredit, memDb, testConfig, testServer } from './helpers.js';

/**
 * The rules that keep a credit from costing more than it is worth (docs/PRICING.md §5–7): credit expiry,
 * starter credit that cannot be sold, direct sales at face value and the published reserve. The reward
 * ceiling and the upstream fee are in usage-share.test.ts / staking.test.ts; the sweep and the price feed
 * in packages/chain-adapter/test/pons.test.ts.
 */

type App = Awaited<ReturnType<typeof testServer>>['app'];

const M = 1_000_000;
const DAY = 86_400;
const NOW = 1_800_000_000;
const EXPIRY: TokenomicsConfig['creditExpiry'] = { enabled: true, days: 90 };
const H = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

/** A ledger row at a chosen time (addLedgerEntry always stamps now). */
function row(db: Db, wallet: string, usd: number, kind: string, at: number, ref: string | null = null) {
  ensureWallet(db, wallet, 'solana');
  db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)`).run(wallet, Math.round(usd * M), kind, ref, at);
}
const kinds = (db: Db, wallet: string) => (db.prepare(`SELECT kind, delta_usd_micros AS d FROM credits_ledger WHERE wallet = ? ORDER BY id`).all(wallet) as Array<{ kind: string; d: number }>).map((r) => `${r.kind}:${r.d / M}`);

async function login(app: App, wallet: string): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token;
}

describe('shipped config', () => {
  const shipped = loadTokenomics();
  it('credits expire after 90 days, direct sales are on, the reserve must cover every credit, nodes are held at 90% of the price', () => {
    expect(shipped.creditExpiry).toEqual({ enabled: true, days: 90 });
    expect(shipped.directSales).toEqual({ enabled: true, minUsd: 1, maxUsd: 10_000 });
    expect(shipped.reserve).toEqual({ minCoverageBps: 10_000 });
    expect(shipped.nodeRewards).toMatchObject({ usdPerMTokens: 0.06, maxShareOfPriceBps: 9000 });
    expect(shipped.starterCredits).toMatchObject({ requireMinHold: true, transferable: false });
    // one credit-USD per fee-USD: the reserve is the holder share itself, never less
    expect(shipped.creditUsdPerFeeUsd).toBe(1);
  });
  it('a config written before these blocks existed still parses, with the old behaviour', () => {
    const { creditExpiry: _e, directSales: _d, reserve: _r, ...old } = testConfig;
    const c = parseTokenomics({ ...old, nodeRewards: { usdPerMTokens: 0.06 }, requestPricing: { mode: 'passthrough' }, starterCredits: { enabled: true } });
    expect(c.creditExpiry.enabled).toBe(false);
    expect(c.directSales.enabled).toBe(false);
    expect(c.nodeRewards.maxShareOfPriceBps).toBe(10_000);
    expect(c.requestPricing.upstreamFeeBps).toBe(0);
    expect(c.starterCredits.transferable).toBe(true);
    expect(() => parseTokenomics({ ...testConfig, directSales: { enabled: true, minUsd: 10, maxUsd: 5 } })).toThrow(/maxUsd/);
  });
});

describe('credit expiry (expiry.ts)', () => {
  it('a credit lapses 90 days after it landed, not a day sooner', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1');
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 89 * DAY)).toBe(0);
    expect(balanceMicros(db, 'alice')).toBe(10 * M);
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 90 * DAY)).toBe(10 * M);
    expect(balanceMicros(db, 'alice')).toBe(0);
    expect(kinds(db, 'alice')).toEqual(['distribution:10', 'expiry:-10']);
    // nothing left to lapse: running it again writes nothing
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 200 * DAY)).toBe(0);
    expect(kinds(db, 'alice')).toHaveLength(2);
  });

  it('the oldest credit is spent first, so only what is left of an old grant lapses', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1');
    row(db, 'alice', -4, 'usage', NOW + 10 * DAY);
    row(db, 'alice', 5, 'market_buy', NOW + 50 * DAY);
    expect(lapsedMicros(db, 'alice', EXPIRY, NOW + 89 * DAY)).toBe(0);
    // day 91: the first grant is past its window; 4 of it were spent, 6 lapse; the bought 5 are still good
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 91 * DAY)).toBe(6 * M);
    expect(balanceMicros(db, 'alice')).toBe(5 * M);
    // a spend after that comes off the bought credit, and the rest of it lapses on its own date
    row(db, 'alice', -2, 'usage', NOW + 100 * DAY);
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 139 * DAY)).toBe(0);
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 140 * DAY)).toBe(3 * M);
    expect(balanceMicros(db, 'alice')).toBe(0);
  });

  it('every source expires the same way: starter, bought on the market, bought directly, an admin adjustment', () => {
    const db = memDb();
    for (const [i, kind] of ['starter', 'market_buy', 'purchase', 'adjustment'].entries()) row(db, `w${i}`, 3, kind, NOW);
    const r = expireAll(db, EXPIRY, { now: NOW + 90 * DAY });
    expect(r).toEqual({ wallets: 4, expiredMicros: 12 * M });
    expect(expireAll(db, EXPIRY, { now: NOW + 90 * DAY })).toEqual({ wallets: 0, expiredMicros: 0 });
  });

  it('a listing does not stop the clock: credit refunded from a cancelled listing keeps its original date', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1');
    row(db, 'alice', -6, 'market_escrow', NOW + 80 * DAY, 'listing:l1');
    // day 91: 6 are in escrow (not in the balance), the 4 still in the wallet lapse
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 91 * DAY)).toBe(4 * M);
    expect(balanceMicros(db, 'alice')).toBe(0);
    // the listing is cancelled on day 95: the 6 come back already past their date and lapse at once
    row(db, 'alice', 6, 'market_refund', NOW + 95 * DAY, 'listing:l1:cancelled');
    expect(balanceMicros(db, 'alice')).toBe(6 * M);
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 95 * DAY)).toBe(6 * M);
    expect(balanceMicros(db, 'alice')).toBe(0);
  });

  it('credit held by a request in flight is left for that request', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1');
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 91 * DAY, 3 * M)).toBe(7 * M);
    expect(balanceMicros(db, 'alice')).toBe(3 * M);
    // the request posts its charge against the oldest credit; what it did not use lapses on the next pass
    row(db, 'alice', -1, 'usage', NOW + 91 * DAY);
    expect(expireWallet(db, 'alice', EXPIRY, NOW + 91 * DAY)).toBe(2 * M);
    expect(balanceMicros(db, 'alice')).toBe(0);
  });

  it('disabled: nothing ever lapses', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1');
    const off = { enabled: false, days: 90 };
    expect(expireWallet(db, 'alice', off, NOW + 1000 * DAY)).toBe(0);
    expect(expireAll(db, off, { now: NOW + 1000 * DAY })).toEqual({ wallets: 0, expiredMicros: 0 });
    expect(expiryOutlook(db, 'alice', off, NOW)).toMatchObject({ enabled: false, next: null, within30dUsd: 0 });
  });

  it('outlook: what lapses next, and how much of the balance is inside its last 7 and 30 days', () => {
    const db = memDb();
    row(db, 'alice', 10, 'distribution', NOW, 'epoch:1'); // lapses day 90
    row(db, 'alice', 5, 'distribution', NOW + 70 * DAY, 'epoch:2'); // lapses day 160
    row(db, 'alice', 2, 'purchase', NOW + 84 * DAY); // lapses day 174
    row(db, 'alice', -4, 'usage', NOW + 84 * DAY); // comes off the first grant: 6 of it left
    const o = expiryOutlook(db, 'alice', EXPIRY, NOW + 85 * DAY);
    expect(o).toEqual({ enabled: true, days: 90, next: { usd: 6, at: NOW + 90 * DAY }, within7dUsd: 6, within30dUsd: 6 });
    // after the first grant has lapsed the next one is the second
    expireWallet(db, 'alice', EXPIRY, NOW + 90 * DAY);
    expect(expiryOutlook(db, 'alice', EXPIRY, NOW + 135 * DAY)).toMatchObject({ next: { usd: 5, at: NOW + 160 * DAY }, within7dUsd: 0, within30dUsd: 5 });
    expect(expiryOutlook(db, 'nobody', EXPIRY, NOW)).toMatchObject({ next: null, within7dUsd: 0 });
  });
});

describe('credit expiry over HTTP', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('lapsed credit cannot be spent; /me shows what is about to lapse; the epoch chores sweep it and /report counts it', async () => {
    const { app } = await testServer({ holders: { holder: 10_000 } });
    apps.push(app);
    const now = Math.floor(Date.now() / 1000);
    row(app.ctx.db, 'old', 4, 'distribution', now - 100 * DAY, 'epoch:1'); // already past its window
    row(app.ctx.db, 'soon', 3, 'distribution', now - 85 * DAY, 'epoch:1'); // 5 days left
    row(app.ctx.db, 'idle', 7, 'distribution', now - 200 * DAY, 'epoch:1'); // never signs in: only the sweep reaches it

    const oldJwt = await login(app, 'old');
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: H(oldJwt) })).json().key as string;
    const chat = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(chat.statusCode).toBe(402);
    expect(chat.json().error.code).toBe('insufficient_quota');
    const meOld = (await app.inject({ method: 'GET', url: '/me', headers: H(oldJwt) })).json();
    expect(meOld.balance.usd).toBe(0);
    expect(meOld.ledger[0]).toMatchObject({ kind: 'expiry', deltaUsd: -4 });

    const meSoon = (await app.inject({ method: 'GET', url: '/me', headers: H(await login(app, 'soon')) })).json();
    expect(meSoon.balance.usd).toBe(3);
    expect(meSoon.expiry).toMatchObject({ enabled: true, days: 90, within7dUsd: 3, within30dUsd: 3 });
    expect(meSoon.expiry.next.usd).toBe(3);
    expect(meSoon.expiry.next.at).toBe(now - 85 * DAY + 90 * DAY);

    expect(balanceMicros(app.ctx.db, 'idle')).toBe(7 * M);
    const epoch = await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: {} });
    expect(epoch.statusCode).toBe(200);
    expect(epoch.json().housekeeping).toMatchObject({ expiredWallets: 1, expiredUsd: 7, reserve: 'mock', reserveHeldUsd: null });
    expect(balanceMicros(app.ctx.db, 'idle')).toBe(0);

    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.creditExpiry).toEqual({ enabled: true, days: 90, expiredUsd: 11, wallets: 2, last30dUsd: 11 });
    expect(report.method.creditExpiry).toMatch(/lapses/);
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().creditExpiryDays).toBe(90);
  });
});

describe('starter credit cannot be sold', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('nonTransferableMicros: what is left of the grant after requests; earned credit is never held back', () => {
    const db = memDb();
    row(db, 'alice', 2, 'starter', NOW, 'starter:auto');
    expect(nonTransferableMicros(db, 'alice')).toBe(2 * M);
    row(db, 'alice', 5, 'distribution', NOW + 1, 'epoch:1');
    expect(nonTransferableMicros(db, 'alice')).toBe(2 * M);
    row(db, 'alice', -0.5, 'usage', NOW + 2); // requests spend the starter grant first
    expect(nonTransferableMicros(db, 'alice')).toBe(1.5 * M);
    row(db, 'alice', -3, 'usage', NOW + 3); // grant used up
    expect(nonTransferableMicros(db, 'alice')).toBe(0);
    row(db, 'bob', 9, 'distribution', NOW, 'epoch:1');
    expect(nonTransferableMicros(db, 'bob')).toBe(0);
  });

  it('a wallet can spend its starter credit but list only what it earned or bought', async () => {
    const { app } = await testServer({});
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 2 } });
    const jwt = await login(app, 'alice');
    const list = (amountUsd: number) => app.inject({ method: 'POST', url: '/market/listings', headers: H(jwt), payload: { amountUsd, discountBps: 1000 } });

    const none = await list(1);
    expect(none.statusCode).toBe(402);
    expect(none.json()).toMatchObject({ error: 'non_transferable' });
    expect((await app.inject({ method: 'GET', url: '/me', headers: H(jwt) })).json().nonTransferableUsd).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/market/config' })).json()).toMatchObject({ starterTransferable: false, creditExpiryDays: 90 });

    grantCredit(app.ctx.db, 'alice', 5);
    const market = (await app.inject({ method: 'GET', url: '/me/market', headers: H(jwt) })).json();
    expect(market).toMatchObject({ creditBalanceUsd: 7, nonTransferableUsd: 2, listableUsd: 5 });
    expect((await list(6)).json()).toMatchObject({ error: 'non_transferable' });
    expect((await list(8)).json()).toMatchObject({ error: 'insufficient_credits' });
    expect((await list(5)).statusCode).toBe(201);
    // the starter credit is still there to spend
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: H(jwt) })).json().key as string;
    const chat = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(chat.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/me', headers: H(jwt) })).json()).toMatchObject({ balance: { usd: 1.999 }, nonTransferableUsd: 1.999 });
  });

  it('with transferable: true the old behaviour is back', async () => {
    const { app } = await testServer({ config: { ...testConfig, starterCredits: { ...testConfig.starterCredits, transferable: true } } });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 2 } });
    const jwt = await login(app, 'alice');
    expect((await app.inject({ method: 'POST', url: '/market/listings', headers: H(jwt), payload: { amountUsd: 2, discountBps: 0 } })).statusCode).toBe(201);
  });
});

describe('direct credit sales', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });
  const cfg = testConfig.directSales;

  it('buyCredits: $1 paid is $1 of credit, in one transaction, within the limits', () => {
    const db = memDb();
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof MarketError ? e.code : String(e);
      }
      return 'no error';
    };
    expect(err(() => buyCredits(db, cfg, { wallet: 'bob', chain: 'solana', amountMicros: 5 * M }))).toBe('insufficient_prepaid');
    topUpPrepaid(db, { wallet: 'bob', chain: 'solana', amountMicros: 20 * M, ref: 'pay-1' });
    expect(err(() => buyCredits(db, cfg, { wallet: 'bob', chain: 'solana', amountMicros: 0.5 * M }))).toBe('below_minimum');
    expect(err(() => buyCredits(db, cfg, { wallet: 'bob', chain: 'solana', amountMicros: 10_001 * M }))).toBe('above_maximum');
    expect(err(() => buyCredits(db, { ...cfg, enabled: false }, { wallet: 'bob', chain: 'solana', amountMicros: 5 * M }))).toBe('not_found');
    expect(balanceMicros(db, 'bob')).toBe(0);

    const p = buyCredits(db, cfg, { wallet: 'bob', chain: 'solana', amountMicros: 5 * M });
    expect(p).toMatchObject({ wallet: 'bob', creditsMicros: 5 * M, paidMicros: 5 * M });
    expect(balanceMicros(db, 'bob')).toBe(5 * M);
    expect(prepaidBalanceMicros(db, 'bob')).toBe(15 * M);
    expect(kinds(db, 'bob')).toEqual(['purchase:5']);
    const paid = db.prepare(`SELECT kind, delta_micros AS d, ref FROM prepaid_ledger WHERE wallet = 'bob' ORDER BY id DESC LIMIT 1`).get() as { kind: string; d: number; ref: string };
    expect(paid).toEqual({ kind: 'credit_purchase', d: -5 * M, ref: `purchase:${p.id}` });
    expect(directSalesTotals(db)).toEqual({ soldMicros: 5 * M, purchases: 1, wallets: 1 });
    // bought credit is the wallet's own: it can be listed
    expect(nonTransferableMicros(db, 'bob')).toBe(0);
  });

  it('HTTP: config is public, buying needs a session and a prepaid balance, the report counts what was sold', async () => {
    const { app } = await testServer({});
    apps.push(app);
    const conf = (await app.inject({ method: 'GET', url: '/credits/config' })).json();
    expect(conf).toMatchObject({ enabled: true, pricePerUsd: 1, minUsd: 1, maxUsd: 10_000, settlement: 'prepaid', creditExpiryDays: 90, soldUsd: 0, purchases: 0 });
    expect((await app.inject({ method: 'POST', url: '/me/credits/buy', payload: { amountUsd: 5 } })).statusCode).toBe(401);

    const jwt = await login(app, 'bob');
    const buy = (amountUsd: unknown) => app.inject({ method: 'POST', url: '/me/credits/buy', headers: H(jwt), payload: { amountUsd } });
    expect((await buy(5)).json()).toMatchObject({ error: 'insufficient_prepaid', statusCode: 402 });
    await app.inject({ method: 'POST', url: '/admin/prepaid', headers: ADMIN, payload: { wallet: 'bob', amountUsd: 20, note: 'test top-up' } });
    expect((await buy('five')).statusCode).toBe(400);
    expect((await buy(0.5)).json()).toMatchObject({ error: 'below_minimum' });

    const ok = await buy(5);
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body).toMatchObject({ creditsUsd: 5, paidUsd: 5, creditBalanceUsd: 5, prepaidBalanceUsd: 15 });
    expect(body.expires_at).toBe(body.created_at + 90 * DAY);

    const me = (await app.inject({ method: 'GET', url: '/me', headers: H(jwt) })).json();
    expect(me.balance.usd).toBe(5);
    expect(me.ledger[0]).toMatchObject({ kind: 'purchase', deltaUsd: 5 });
    expect(me.expiry.next).toMatchObject({ usd: 5, at: body.expires_at });

    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.directSales).toEqual({ enabled: true, soldUsd: 5, purchases: 1, wallets: 1, last30dUsd: 5 });
    expect(report.totals.creditsOutstandingUsd).toBe(5);
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().directSalesEnabled).toBe(true);
  });

  it('disabled: the routes do not exist', async () => {
    const { app } = await testServer({ config: { ...testConfig, directSales: { ...cfg, enabled: false } } });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/credits/config' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/me/credits/buy', headers: H(await login(app, 'bob')), payload: { amountUsd: 5 } })).statusCode).toBe(404);
  });
});

describe('the published reserve', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  /** A mock adapter that also has a credit-pool wallet to read. */
  function withReserve(read: () => Promise<ReserveReading>) {
    return Object.assign(new MockAdapter({ chain: 'evm' }), { reserve: read });
  }
  const reading = (stableUsd: number, otherUnits = 0, otherUsd: number | null = 0): ReserveReading => ({ wallet: '0xpool', stable: '0xusdg', stableUsd, otherUnits, otherUsd });

  it('before the token launch there is nothing to read: source mock, no coverage claimed, one row only', async () => {
    const db = memDb();
    grantCredit(db, 'alice', 80);
    const adapter = new MockAdapter({ chain: 'evm' });
    const a = await snapshotReserve({ db, adapter }, NOW);
    const b = await snapshotReserve({ db, adapter }, NOW + 3600);
    expect(b.id).toBe(a.id);
    expect(reserveView({ db, config: testConfig })).toMatchObject({ source: 'mock', heldUsd: null, requiredUsd: 80, coverage: null, surplusUsd: null, short: null, minCoverageBps: 10_000 });
  });

  it('coverage = stablecoin held ÷ (spendable credit + credit escrowed in listings); ETH next to it is not counted', async () => {
    const { app } = await testServer({});
    apps.push(app);
    const db = app.ctx.db;
    grantCredit(db, 'alice', 80);
    const jwt = await login(app, 'alice');
    expect((await app.inject({ method: 'POST', url: '/market/listings', headers: H(jwt), payload: { amountUsd: 30, discountBps: 1000 } })).statusCode).toBe(201);

    await snapshotReserve({ db, adapter: withReserve(async () => reading(100, 0.5, 1500)) }, NOW);
    const full = reserveView(app.ctx);
    expect(full).toMatchObject({ source: 'chain', asset: '0xusdg', heldUsd: 100, otherUsd: 1500, creditsSpendableUsd: 50, creditsInEscrowUsd: 30, requiredUsd: 80, coverage: 1.25, surplusUsd: 20, short: false, asOf: NOW });
    expect(full.note).toMatch(/ETH also in the pool wallet, not counted/);

    await snapshotReserve({ db, adapter: withReserve(async () => reading(50)) }, NOW + 3600);
    expect(reserveView(app.ctx)).toMatchObject({ heldUsd: 50, coverage: 0.625, surplusUsd: -30, short: true, asOf: NOW + 3600 });

    // the public endpoints carry the same block
    const report = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(report.totals.reserve).toMatchObject({ source: 'chain', heldUsd: 50, requiredUsd: 80, coverage: 0.625, short: true });
    expect(report.method.reserve).toMatch(/credit-pool wallet/);
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().reserve).toMatchObject({ heldUsd: 50, short: true });
  });

  it('credit that lapses lowers what is required, so its backing shows up as surplus', async () => {
    const db = memDb();
    const now = Math.floor(Date.now() / 1000);
    row(db, 'alice', 60, 'distribution', now - 100 * DAY, 'epoch:1');
    row(db, 'bob', 40, 'distribution', now - 10 * DAY, 'epoch:2');
    await snapshotReserve({ db, adapter: withReserve(async () => reading(100)) });
    expect(reserveView({ db, config: testConfig })).toMatchObject({ requiredUsd: 100, coverage: 1, surplusUsd: 0, short: false });
    expireAll(db, EXPIRY);
    expect(reserveView({ db, config: testConfig })).toMatchObject({ requiredUsd: 40, coverage: 2.5, surplusUsd: 60 });
  });

  it('a failed read is stored as unavailable and logged, never thrown', async () => {
    const db = memDb();
    grantCredit(db, 'alice', 10);
    const snap = await snapshotReserve({ db, adapter: withReserve(async () => Promise.reject(new Error('rpc down'))) }, NOW);
    expect(snap).toMatchObject({ source: 'unavailable', held_usd_micros: null, note: 'rpc down' });
    expect(reserveView({ db, config: testConfig })).toMatchObject({ source: 'unavailable', heldUsd: null, coverage: null, short: null });
    expect((db.prepare(`SELECT code FROM errors_log ORDER BY id DESC LIMIT 1`).get() as { code: string }).code).toBe('reserve_read_failed');
  });
});

describe('reserve_short alert', () => {
  it('fires when the pool holds less than the credits owed, stays silent without a reading, resolves when topped up', async () => {
    const db = memDb();
    grantCredit(db, 'alice', 100);
    const messages: string[] = [];
    let now = NOW * 1000;
    const mon = new AlertMonitor({
      db,
      config: { epochSeconds: 3600, reserve: { minCoverageBps: 10_000 } },
      env: { EPOCH_CRON: 'off', MESH_DB_PATH: ':memory:' },
      sender: { name: 'fake', send: async (t) => void messages.push(t) },
      now: () => now,
      dbSize: () => null,
      disk: () => null,
    });
    const pool = (usd: number) => Object.assign(new MockAdapter({ chain: 'evm' }), { reserve: async (): Promise<ReserveReading> => ({ wallet: '0xpool', stable: '0xusdg', stableUsd: usd, otherUnits: 0, otherUsd: 0 }) });

    await snapshotReserve({ db, adapter: new MockAdapter({ chain: 'evm' }) }, NOW); // mock: nothing to compare
    await mon.check();
    expect(messages).toEqual([]);

    await snapshotReserve({ db, adapter: pool(60) }, NOW + 1);
    now += 60_000;
    await mon.check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/ALERT reserve_short: credit pool holds \$60\.00 against \$100\.00 of credits owed \(60\.0 %, min 100 %\)/);

    await snapshotReserve({ db, adapter: pool(100) }, NOW + 2);
    now += 60_000;
    await mon.check();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatch(/reserve_short/);
    expect(messages[1]).not.toMatch(/ALERT/);
  });
});

describe('a sweep that leaves fees behind is not silent', () => {
  it('logs sweep_skipped once per sweep and raises the failed_sweep alert', async () => {
    const db = memDb();
    const messages: string[] = [];
    let now = NOW * 1000;
    const mon = new AlertMonitor({ db, config: { epochSeconds: 3600 }, env: { EPOCH_CRON: 'off', MESH_DB_PATH: ':memory:' }, sender: { name: 'fake', send: async (t) => void messages.push(t) }, now: () => now, dbSize: () => null, disk: () => null });
    const sweep = { warnings: ['chainlink answer is 7200s old (max 3600): ETH fees stay unswept until the feed is fresh', 'no fresh price for 0x0000000000000000000000000000000000000000: 1.5 left unswept, no credits minted for it this epoch'] };
    const adapter = Object.assign(new MockAdapter({ chain: 'evm' }), { lastSweep: sweep });

    expect(logSweepWarnings({ db, adapter })).toEqual([sweep.warnings[1]]);
    expect(logSweepWarnings({ db, adapter })).toEqual([]); // the same sweep again (a replayed epoch): nothing new
    const rows = db.prepare(`SELECT code, message FROM errors_log`).all() as Array<{ code: string; message: string }>;
    expect(rows).toEqual([{ code: 'sweep_skipped', message: sweep.warnings[1] }]);

    now += 60_000;
    await mon.check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/ALERT failed_sweep: 1 failed sweep\(s\).*left unswept/);

    // a clean sweep, or the mock adapter (no lastSweep), logs nothing
    expect(logSweepWarnings({ db, adapter: Object.assign(new MockAdapter({ chain: 'evm' }), { lastSweep: { warnings: [] } }) })).toEqual([]);
    expect(logSweepWarnings({ db, adapter: new MockAdapter({ chain: 'evm' }) })).toEqual([]);
  });
});

describe('guest chat is paid at what the upstream really costs', () => {
  it('the treasury is debited list plus the upstream fee', async () => {
    const { app } = await testServer({ config: { ...testConfig, guest: { ...testConfig.guest, enabled: true }, requestPricing: { ...SHIPPED_PRICING } } });
    const r = await app.inject({ method: 'POST', url: '/v1/guest/chat', payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(200);
    const paid = (app.ctx.db.prepare(`SELECT COALESCE(SUM(usd_micros), 0) AS v FROM treasury_ledger WHERE kind = 'guest_chat'`).get() as { v: number }).v;
    expect(paid).toBe(-1055); // $0.001 at list + 5.5%
    await app.close();
  });
});
