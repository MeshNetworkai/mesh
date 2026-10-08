import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEpoch } from '../src/jobs/distribute.js';
import { pendingPoolExtra, quote, reapMarket } from '../src/market.js';
import { ADMIN, grantCredit, testConfig, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];

const cfg = testConfig.marketplace;
const M = 1_000_000;
const H = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function login(app: App, wallet: string): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token;
}
/** Sellable credit for the seller. (Starter credit cannot be listed: see the last describe block.) */
async function starter(app: App, wallet: string, amountUsd: number) {
  grantCredit(app.ctx.db, wallet, amountUsd);
}
async function prepaid(app: App, wallet: string, amountUsd: number, note = 'test top-up', ref?: string) {
  return app.inject({ method: 'POST', url: '/admin/prepaid', headers: ADMIN, payload: { wallet, amountUsd, note, ref } });
}
async function credits(app: App, jwt: string): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/me', headers: H(jwt) })).json().balance.usdMicros;
}
async function me(app: App, jwt: string) {
  return (await app.inject({ method: 'GET', url: '/me/market', headers: H(jwt) })).json();
}
function treasury(app: App, kind: string): number {
  return (app.ctx.db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM treasury_ledger WHERE kind = ?`).get(kind) as { v: number }).v;
}
function ledgerKinds(app: App, wallet: string): Array<{ kind: string; delta: number }> {
  return app.ctx.db.prepare(`SELECT kind, delta_usd_micros AS delta FROM credits_ledger WHERE wallet = ? ORDER BY id`).all(wallet) as Array<{ kind: string; delta: number }>;
}

describe('fee math (integer micro-USD)', () => {
  it('$100 at 30% off: buyer pays $70, fee $1.75 (2.5%), seller gets $68.25, fee split 50/50', () => {
    const q = quote(cfg, 100 * M, 3000);
    expect(q.priceMicrosPerUsd).toBe(700_000);
    expect(q.paidMicros).toBe(70 * M);
    expect(q.feeMicros).toBe(1_750_000);
    expect(q.sellerReceivesMicros).toBe(68_250_000);
    expect(q.feeToHoldersMicros).toBe(875_000);
    expect(q.feeToTreasuryMicros).toBe(875_000);
    expect(q.feeToHoldersMicros + q.feeToTreasuryMicros).toBe(q.feeMicros);
    expect(q.sellerReceivesMicros + q.feeMicros).toBe(q.paidMicros);
  });
  it('odd amounts floor every step and still add up exactly', () => {
    const q = quote(cfg, 7_777_777, 1234);
    expect([q.paidMicros, q.feeMicros, q.sellerReceivesMicros, q.feeToHoldersMicros].every(Number.isInteger)).toBe(true);
    expect(q.paidMicros).toBe(7_777_777 - Math.floor((7_777_777 * 1234) / 10_000));
    expect(q.feeMicros).toBe(Math.floor((q.paidMicros * 250) / 10_000));
    expect(q.sellerReceivesMicros + q.feeMicros).toBe(q.paidMicros);
    expect(q.feeToHoldersMicros + q.feeToTreasuryMicros).toBe(q.feeMicros);
  });
});

describe('credit marketplace', () => {
  let app: App;
  let alice: string; // seller
  let bob: string; // buyer
  let carol: string; // second buyer
  let listingId: string;

  beforeAll(async () => {
    ({ app } = await testServer({ holders: { holder1: 60_000, holder2: 40_000 } }));
    await starter(app, 'alice', 100);
    alice = await login(app, 'alice');
    bob = await login(app, 'bob');
    carol = await login(app, 'carol');
  });
  afterAll(async () => app.close());

  it('GET /market/config exposes the fee schedule', async () => {
    const r = await app.inject({ method: 'GET', url: '/market/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: true, feeBps: 250, feePercent: 2.5, feeToHoldersBps: 5000, minListingUsd: 1, maxDiscountBps: 7000, listingTtlHours: 168, settlement: 'prepaid' });
  });

  it('listing escrows credits: balance drops, escrowed credits cannot be spent, book shows depth', async () => {
    expect(await credits(app, alice)).toBe(100 * M);
    const r = await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 100, discountBps: 3000 } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ amountUsd: 100, remainingUsd: 100, discountBps: 3000, pricePerUsd: 0.7, status: 'open' });
    expect(r.json().ifFullySold).toEqual({ buyerPaysUsd: 70, feeUsd: 1.75, youReceiveUsd: 68.25 });
    expect(r.json().expires_at - r.json().created_at).toBe(cfg.listingTtlHours * 3600);
    listingId = r.json().id;
    expect(await credits(app, alice)).toBe(0);
    expect(ledgerKinds(app, 'alice').at(-1)).toEqual({ kind: 'market_escrow', delta: -100 * M });

    // escrowed credits are not spendable on /v1
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: H(alice), payload: { name: 'k' } })).json().key;
    const chat = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(chat.statusCode).toBe(402);

    const book = (await app.inject({ method: 'GET', url: '/market/book' })).json();
    expect(book.bestDiscountBps).toBe(3000);
    expect(book.totalAvailableUsd).toBe(100);
    expect(book.tiers).toEqual([{ discountBps: 3000, pricePerUsd: 0.7, availableUsd: 100, listings: 1 }]);

    const open = (await app.inject({ method: 'GET', url: '/market/listings?limit=10' })).json();
    expect(open.total).toBe(1);
    expect(open.listings[0]).toMatchObject({ id: listingId, remainingUsd: 100 });
    expect(open.listings[0].seller).toBeUndefined();
  });

  it('rejects listings that are too small, too deep, or beyond the spendable balance', async () => {
    await starter(app, 'alice', 10);
    expect((await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 0.5, discountBps: 1000 } })).json().error).toBe('below_minimum');
    expect((await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 5, discountBps: 7500 } })).json().error).toBe('discount_too_deep');
    const r = await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 11, discountBps: 1000 } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe('insufficient_credits');
    expect(await credits(app, alice)).toBe(10 * M);
  });

  it('cancel refunds the remainder to the seller (market_refund) and takes it off the book', async () => {
    const l = (await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 10, discountBps: 1000 } })).json();
    expect(await credits(app, alice)).toBe(0);
    const r = await app.inject({ method: 'DELETE', url: `/market/listings/${l.id}`, headers: H(alice) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'cancelled', remainingUsd: 0 });
    expect(await credits(app, alice)).toBe(10 * M);
    expect(ledgerKinds(app, 'alice').at(-1)).toEqual({ kind: 'market_refund', delta: 10 * M });
    // idempotent; and nobody else can cancel it
    expect((await app.inject({ method: 'DELETE', url: `/market/listings/${l.id}`, headers: H(alice) })).json().status).toBe('cancelled');
    expect((await app.inject({ method: 'DELETE', url: `/market/listings/${listingId}`, headers: H(bob) })).statusCode).toBe(404);
    const book = (await app.inject({ method: 'GET', url: '/market/book' })).json();
    expect(book.tiers).toHaveLength(1);
  });

  it('a buyer without prepaid balance gets 402 and nothing moves', async () => {
    const r = await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId, amountUsd: 10 } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe('insufficient_prepaid');
    expect(await credits(app, bob)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/market/book' })).json().totalAvailableUsd).toBe(100);
  });

  it('POST /admin/prepaid credits the balance, is audited, and is idempotent per ref', async () => {
    const r = await prepaid(app, 'bob', 50, 'USDC received by hand, tx abc', 'tx:abc');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ wallet: 'bob', amountUsd: 50, ref: 'tx:abc', duplicate: false, prepaidBalanceUsd: 50 });
    const again = await prepaid(app, 'bob', 50, 'same tx again', 'tx:abc');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, prepaidBalanceUsd: 50 });
    const audit = app.ctx.db.prepare(`SELECT payload FROM admin_actions WHERE action = 'prepaid-topup' ORDER BY id`).all() as Array<{ payload: string }>;
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0].payload)).toMatchObject({ wallet: 'bob', amountUsd: 50, note: 'USDC received by hand, tx abc', ref: 'tx:abc', duplicate: false });
    expect(JSON.parse(audit[1].payload)).toMatchObject({ duplicate: true });
    expect((await me(app, bob)).prepaid).toMatchObject({ usd: 50, usdMicros: 50 * M });
    expect((await prepaid(app, 'bob', 1, '')).statusCode).toBe(400); // a note is required
  });

  it('partial fill: credits move at face value, prepaid pays the price, fee splits into treasury + pool_extra', async () => {
    const before = pendingPoolExtra(app.ctx.db).usdMicros;
    const r = await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId, amountUsd: 40 } });
    expect(r.statusCode).toBe(201);
    // $40 face at 30% off = $28 paid; fee 2.5% = $0.70; seller $27.30; holders $0.35; treasury $0.35
    expect(r.json()).toMatchObject({ listingId, buyer: 'bob', seller: 'alice', creditsUsd: 40, paidUsd: 28, feeUsd: 0.7, feeToHoldersUsd: 0.35, feeToTreasuryUsd: 0.35, sellerReceivedUsd: 27.3, discountBps: 3000, settlement: 'prepaid', creditBalanceUsd: 40, prepaidBalanceUsd: 22 });
    expect(await credits(app, bob)).toBe(40 * M);
    expect(ledgerKinds(app, 'bob').at(-1)).toEqual({ kind: 'market_buy', delta: 40 * M });
    expect(await credits(app, alice)).toBe(10 * M); // escrow untouched by the sale
    expect((await me(app, alice)).prepaid.usd).toBe(27.3);
    expect((await me(app, bob)).prepaid.usd).toBe(22);
    expect(treasury(app, 'market_fee')).toBe(350_000);
    expect(pendingPoolExtra(app.ctx.db).usdMicros - before).toBe(350_000);
    const book = (await app.inject({ method: 'GET', url: '/market/book' })).json();
    expect(book.totalAvailableUsd).toBe(60);
    const mine = await me(app, alice);
    expect(mine.listings.find((l: { id: string }) => l.id === listingId)).toMatchObject({ status: 'open', soldUsd: 40, remainingUsd: 60 });
    expect(mine.fills.asSeller[0]).toMatchObject({ creditsUsd: 40, sellerReceivedUsd: 27.3 });
    expect((await me(app, bob)).fills.asBuyer[0]).toMatchObject({ creditsUsd: 40, paidUsd: 28 });
  });

  it('cannot buy your own listing, more than is left, or dust', async () => {
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(alice), payload: { listingId, amountUsd: 1 } })).json().error).toBe('own_listing');
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId, amountUsd: 61 } })).json().error).toBe('insufficient_depth');
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId, amountUsd: 0.001 } })).json().error).toBe('below_minimum');
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId: 'lst_nope', amountUsd: 1 } })).statusCode).toBe(404);
  });

  it('full fill closes the listing; a later buyer gets listing_closed', async () => {
    await prepaid(app, 'carol', 100, 'beta top-up');
    const r = await app.inject({ method: 'POST', url: '/market/fills', headers: H(carol), payload: { listingId, amountUsd: 60 } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ creditsUsd: 60, paidUsd: 42, feeUsd: 1.05, sellerReceivedUsd: 40.95, prepaidBalanceUsd: 58 });
    expect(await credits(app, carol)).toBe(60 * M);
    const mine = await me(app, alice);
    expect(mine.listings.find((l: { id: string }) => l.id === listingId)).toMatchObject({ status: 'filled', remainingUsd: 0, soldUsd: 100 });
    expect(mine.prepaid.usd).toBe(27.3 + 40.95);
    expect((await app.inject({ method: 'GET', url: '/market/book' })).json().tiers).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId, amountUsd: 1 } })).json().error).toBe('listing_closed');
    // money conservation: everything buyers paid = seller proceeds + fees
    expect(treasury(app, 'market_fee')).toBe(875_000);
    expect(pendingPoolExtra(app.ctx.db).usdMicros).toBe(875_000);
    const paid = 28 * M + 42 * M;
    expect(paid).toBe(Math.round((27.3 + 40.95) * M) + 875_000 + 875_000);
  });

  it('the holders share of the fee joins the next epoch pool and is claimed exactly once', async () => {
    const epochStart = 3_600;
    const r = await runEpoch({ db: app.ctx.db, adapter: app.ctx.adapter, config: testConfig }, epochStart);
    expect(r.status).toBe('complete');
    expect(r.holderPoolUsdMicros).toBe(875_000); // no trading fees this epoch: the pool is the marketplace share alone
    expect(r.distributed.reduce((a, d) => a + d.usdMicros, 0)).toBe(875_000);
    expect(r.distributed.find((d) => d.wallet === 'holder1')?.usdMicros).toBe(525_000);
    expect(pendingPoolExtra(app.ctx.db).usdMicros).toBe(0);
    const claimed = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM pool_extra_micros WHERE epoch_start = ?`).get(epochStart) as { n: number };
    expect(claimed.n).toBe(2);
    const next = await runEpoch({ db: app.ctx.db, adapter: app.ctx.adapter, config: testConfig }, epochStart + 3600);
    expect(next.holderPoolUsdMicros).toBe(0);
    expect(next.status).toBe('empty');
  });

  it('withdrawals: the amount leaves the prepaid balance at once; the admin marks it paid (audited)', async () => {
    const bad = await app.inject({ method: 'POST', url: '/me/market/withdraw', headers: H(alice), payload: { amountUsd: 1000 } });
    expect(bad.statusCode).toBe(402);
    const r = await app.inject({ method: 'POST', url: '/me/market/withdraw', headers: H(alice), payload: { amountUsd: 50 } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ wallet: 'alice', amountUsd: 50, status: 'pending', prepaidBalanceUsd: 18.25 });
    const id = r.json().id;
    expect((await me(app, alice)).withdrawals[0]).toMatchObject({ id, status: 'pending' });

    const adminView = (await app.inject({ method: 'GET', url: '/admin/market', headers: ADMIN })).json();
    expect(adminView.withdrawals.pending.map((w: { id: number }) => w.id)).toEqual([id]);
    expect(adminView.withdrawals.pendingUsd).toBe(50);
    expect(adminView.prepaid.outstandingUsd).toBe(18.25 + 22 + 58);
    expect(adminView.totals).toMatchObject({ listedUsd: 110, filledUsd: 100, paidUsd: 70, feesUsd: 1.75, feesToHoldersUsd: 0.875, feesToTreasuryUsd: 0.875, fills: 2, avgDiscountBps: 3000 });

    expect((await app.inject({ method: 'POST', url: `/admin/market/withdrawals/${id}/paid`, payload: { txRef: 'usdc:0xpaid' } })).statusCode).toBe(401);
    const paid = await app.inject({ method: 'POST', url: `/admin/market/withdrawals/${id}/paid`, headers: ADMIN, payload: { txRef: 'usdc:0xpaid' } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ id, status: 'paid', txRef: 'usdc:0xpaid' });
    expect(paid.json().paid_at).toBeTypeOf('number');
    // idempotent
    expect((await app.inject({ method: 'POST', url: `/admin/market/withdrawals/${id}/paid`, headers: ADMIN, payload: {} })).json().status).toBe('paid');
    expect((await app.inject({ method: 'POST', url: `/admin/market/withdrawals/999/paid`, headers: ADMIN, payload: {} })).statusCode).toBe(404);
    const audit = app.ctx.db.prepare(`SELECT payload FROM admin_actions WHERE action = 'withdrawal-paid'`).all() as Array<{ payload: string }>;
    expect(audit).toHaveLength(2); // the idempotent re-mark is audited too
    expect(JSON.parse(audit[0].payload)).toMatchObject({ id, wallet: 'alice', amountUsd: 50, txRef: 'usdc:0xpaid' });
    expect((await me(app, alice)).withdrawals[0].status).toBe('paid');
  });

  it('expired listings return their escrow to the seller', async () => {
    const l = (await app.inject({ method: 'POST', url: '/market/listings', headers: H(alice), payload: { amountUsd: 10, discountBps: 500 } })).json();
    expect(await credits(app, alice)).toBe(0);
    const future = Math.floor(Date.now() / 1000) + cfg.listingTtlHours * 3600 + 1;
    expect(reapMarket(app.ctx.db, future)).toEqual({ listingsExpired: 1 });
    expect(await credits(app, alice)).toBe(10 * M);
    expect(ledgerKinds(app, 'alice').at(-1)).toEqual({ kind: 'market_refund', delta: 10 * M });
    expect((await me(app, alice)).listings[0]).toMatchObject({ id: l.id, status: 'expired', remainingUsd: 0 });
    expect((await app.inject({ method: 'POST', url: '/market/fills', headers: H(bob), payload: { listingId: l.id, amountUsd: 1 } })).json().error).toBe('listing_closed');
    expect((await app.inject({ method: 'POST', url: '/admin/market/reap', headers: ADMIN })).json()).toEqual({ listingsExpired: 0 });
  });

  it('/report carries marketplace totals', async () => {
    const r = (await app.inject({ method: 'GET', url: '/report' })).json();
    expect(r.totals.marketplace).toMatchObject({ listed: 120, filled: 100, paid: 70, fills: 2, feesToHolders: 0.875, feesToTreasury: 0.875, openDepth: 0, openListings: 0, bestDiscountBps: null, avgDiscountBps: 3000 });
    expect(r.totals.treasury.marketFeeUsd).toBe(0.875);
    expect(r.method.marketplace).toContain('2.5%');
  });

  it('quote endpoint mirrors the integer math', async () => {
    const r = (await app.inject({ method: 'GET', url: '/market/quote?amountUsd=100&discountBps=3000' })).json();
    expect(r).toEqual({ creditsUsd: 100, discountBps: 3000, pricePerUsd: 0.7, buyerPaysUsd: 70, feeUsd: 1.75, feeToHoldersUsd: 0.875, feeToTreasuryUsd: 0.875, sellerReceivesUsd: 68.25 });
  });

  it('authed routes need a session', async () => {
    for (const [method, url] of [['POST', '/market/listings'], ['POST', '/market/fills'], ['GET', '/me/market'], ['POST', '/me/market/withdraw']] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/admin/prepaid', payload: { wallet: 'x', amountUsd: 1, note: 'n' } })).statusCode).toBe(401);
  });
});

describe('marketplace disabled', () => {
  it('every /market route is 404 when marketplace.enabled is false', async () => {
    const { app } = await testServer({ config: { ...testConfig, marketplace: { ...cfg, enabled: false } } });
    expect((await app.inject({ method: 'GET', url: '/market/book' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/market/listings' })).statusCode).toBe(404);
    await app.close();
  });
});
