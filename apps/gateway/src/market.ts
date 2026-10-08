import type { TokenomicsConfig } from '@mesh/config';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addLedgerEntry, addTreasuryEntry, balanceMicros, ensureWallet } from './ledger.js';
import { bpsOf, MICROS } from './money.js';

/**
 * Credit marketplace (docs/MARKETPLACE.md). Holders list unused credits at a discount; a buyer pays
 * the discounted price from a prepaid USD balance and receives the credits at face value. Mesh keeps
 * `feeBps` (2.5%) of the price: `feeToHoldersBps` of that joins the next hourly holder pool (via
 * `pool_extra_micros`), the rest is a `market_fee` treasury row. The seller is paid the price minus
 * the fee into the same prepaid balance and withdraws it through `withdrawal_requests`.
 *
 * Every state change is one SQLite transaction. All amounts are integer micro-USD.
 *
 *   pricePerUsd = 1e6 − bps(1e6, discount)           (stored on the listing)
 *   paid        = credits − bps(credits, discount)
 *   fee         = bps(paid, feeBps)
 *   toHolders   = bps(fee, feeToHoldersBps);  toTreasury = fee − toHolders
 *   seller      = paid − fee
 *
 *   e.g. $100 face at 30% off: paid $70, fee $1.75, seller receives $68.25, holders $0.875, treasury $0.875.
 *
 * Settlement today is `prepaid` (an admin tops the balance up after an off-chain / USDG payment); a
 * chain adapter that credits `prepaid_ledger` from on-chain USDG transfers plugs in without a schema
 * change, and fills it settles directly would carry `settlement = 'external'` plus the tx in
 * `settlement_ref`.
 */

export type MarketConfig = TokenomicsConfig['marketplace'];

export class MarketError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}

export type ListingStatus = 'open' | 'filled' | 'cancelled' | 'expired';
export type Settlement = 'prepaid' | 'external';
export type WithdrawalStatus = 'pending' | 'paid';
/** `credit_purchase`: paid to Mesh for credits bought at face value (direct-sales.ts). */
export type PrepaidKind = 'topup' | 'market_buy' | 'market_sale' | 'withdrawal' | 'withdrawal_refund' | 'adjustment' | 'credit_purchase';

export interface ListingRow {
  id: string;
  seller_wallet: string;
  amount_micros: number;
  remaining_micros: number;
  discount_bps: number;
  price_micros_per_usd: number;
  status: ListingStatus;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
}

export interface FillRow {
  id: string;
  listing_id: string;
  buyer_wallet: string;
  seller_wallet: string;
  credits_micros: number;
  paid_micros: number;
  fee_micros: number;
  fee_to_holders_micros: number;
  fee_to_treasury_micros: number;
  discount_bps: number;
  settlement: Settlement;
  settlement_ref: string | null;
  created_at: number;
}

export interface PrepaidRow {
  id: number;
  wallet: string;
  delta_micros: number;
  kind: PrepaidKind;
  ref: string | null;
  created_at: number;
}

export interface WithdrawalRow {
  id: number;
  wallet: string;
  amount_micros: number;
  status: WithdrawalStatus;
  note: string | null;
  tx_ref: string | null;
  created_at: number;
  paid_at: number | null;
}

export interface Quote {
  creditsMicros: number;
  discountBps: number;
  priceMicrosPerUsd: number;
  paidMicros: number;
  feeMicros: number;
  feeToHoldersMicros: number;
  feeToTreasuryMicros: number;
  sellerReceivesMicros: number;
}

const HOUR = 3_600;
/** Smallest partial fill unless it takes everything that is left: keeps fee-free dust fills off the book. */
export const MIN_FILL_MICROS = 10_000; // $0.01

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const usdStr = (micros: number) => (micros / MICROS).toFixed(2);

/** What a buyer pays per $1 of credit at `discountBps`, in micro-USD. */
export function pricePerUsdMicros(discountBps: number): number {
  return MICROS - bpsOf(MICROS, discountBps);
}

/** Exact integer fee math for `creditsMicros` of face value at `discountBps`. */
export function quote(cfg: MarketConfig, creditsMicros: number, discountBps: number): Quote {
  if (!Number.isInteger(creditsMicros) || creditsMicros < 0) throw new Error('creditsMicros must be a non-negative integer');
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new Error('discountBps out of range');
  const paidMicros = creditsMicros - bpsOf(creditsMicros, discountBps);
  const feeMicros = bpsOf(paidMicros, cfg.feeBps);
  const feeToHoldersMicros = bpsOf(feeMicros, cfg.feeToHoldersBps);
  const feeToTreasuryMicros = feeMicros - feeToHoldersMicros;
  return {
    creditsMicros,
    discountBps,
    priceMicrosPerUsd: pricePerUsdMicros(discountBps),
    paidMicros,
    feeMicros,
    feeToHoldersMicros,
    feeToTreasuryMicros,
    sellerReceivesMicros: paidMicros - feeMicros,
  };
}

export function getListing(db: Db, id: string): ListingRow | null {
  return (db.prepare(`SELECT * FROM market_listings WHERE id = ?`).get(id) as ListingRow | undefined) ?? null;
}

export function getFill(db: Db, id: string): FillRow | null {
  return (db.prepare(`SELECT * FROM market_fills WHERE id = ?`).get(id) as FillRow | undefined) ?? null;
}

// ---------------- prepaid balance ----------------

/** Prepaid USD this wallet can spend on the market or withdraw. */
export function prepaidBalanceMicros(db: Db, wallet: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(delta_micros), 0) AS v FROM prepaid_ledger WHERE wallet = ?`).get(wallet) as { v: number }).v;
}

export function addPrepaidEntry(db: Db, entry: { wallet: string; deltaMicros: number; kind: PrepaidKind; ref?: string | null }, ts = nowSec()): number {
  if (!Number.isInteger(entry.deltaMicros)) throw new Error('deltaMicros must be an integer');
  const res = db
    .prepare(`INSERT INTO prepaid_ledger (wallet, delta_micros, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(entry.wallet, entry.deltaMicros, entry.kind, entry.ref ?? null, ts);
  return Number(res.lastInsertRowid);
}

export function recentPrepaid(db: Db, wallet: string, limit = 20): PrepaidRow[] {
  return db.prepare(`SELECT * FROM prepaid_ledger WHERE wallet = ? ORDER BY id DESC LIMIT ?`).all(wallet, limit) as PrepaidRow[];
}

/** Sum of every wallet's prepaid balance: what the platform holds on behalf of users. */
export function prepaidOutstandingMicros(db: Db): number {
  return (db.prepare(`SELECT COALESCE(SUM(delta_micros), 0) AS v FROM prepaid_ledger`).get() as { v: number }).v;
}

/**
 * Admin top-up: a payment received off-chain (or, later, a USDG transfer the chain adapter saw) becomes
 * spendable prepaid balance. `ref` is unique per (kind, ref), so re-posting the same payment reference
 * is a no-op (returns null).
 */
export function topUpPrepaid(db: Db, input: { wallet: string; chain: string; amountMicros: number; ref: string }, now = nowSec()): number | null {
  if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) throw new MarketError(400, 'bad_amount', 'amount must be a positive number of USD');
  const tx = db.transaction(() => {
    ensureWallet(db, input.wallet, input.chain);
    const dup = db.prepare(`SELECT id FROM prepaid_ledger WHERE kind = 'topup' AND ref = ?`).get(input.ref) as { id: number } | undefined;
    if (dup) return null;
    return addPrepaidEntry(db, { wallet: input.wallet, deltaMicros: input.amountMicros, kind: 'topup', ref: input.ref }, now);
  });
  return tx();
}

// ---------------- sellers ----------------

/**
 * Escrow `amountMicros` of the seller's spendable credits into a new listing. The escrow is a negative
 * `market_escrow` ledger row, so `balanceMicros` (what /v1 checks before serving) no longer counts it.
 */
export function createListing(
  db: Db,
  cfg: MarketConfig,
  input: {
    seller: string;
    chain: string;
    amountMicros: number;
    discountBps: number;
    reservedMicros?: number;
    /** Credit in the balance that may be spent but not sold (unused starter credit, expiry.ts `nonTransferableMicros`). */
    lockedMicros?: number;
  },
  now = nowSec(),
): ListingRow {
  const { seller, amountMicros, discountBps } = input;
  if (!Number.isInteger(amountMicros) || amountMicros <= 0) throw new MarketError(400, 'bad_amount', 'amount must be a positive number of USD');
  const minMicros = Math.round(cfg.minListingUsd * MICROS);
  if (amountMicros < minMicros) throw new MarketError(400, 'below_minimum', `listings start at $${cfg.minListingUsd}`);
  if (!Number.isInteger(discountBps) || discountBps < 0) throw new MarketError(400, 'bad_discount', 'discountBps must be a non-negative integer');
  if (discountBps > cfg.maxDiscountBps) throw new MarketError(400, 'discount_too_deep', `the deepest discount allowed is ${cfg.maxDiscountBps / 100}%`);
  const tx = db.transaction(() => {
    ensureWallet(db, seller, input.chain);
    // Credit held by the seller's requests in flight (reserve.ts) is about to be spent: it cannot be listed too.
    const bal = balanceMicros(db, seller) - (input.reservedMicros ?? 0);
    if (bal < amountMicros) throw new MarketError(402, 'insufficient_credits', `spendable balance is $${usdStr(bal)}; cannot list $${usdStr(amountMicros)}`);
    const locked = Math.max(0, input.lockedMicros ?? 0);
    if (bal - locked < amountMicros) {
      throw new MarketError(402, 'non_transferable', `$${usdStr(locked)} of this balance is starter credit, which can be spent on requests but not sold; $${usdStr(Math.max(0, bal - locked))} can be listed`);
    }
    const id = newId('lst');
    db.prepare(
      `INSERT INTO market_listings (id, seller_wallet, amount_micros, remaining_micros, discount_bps, price_micros_per_usd, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(id, seller, amountMicros, amountMicros, discountBps, pricePerUsdMicros(discountBps), now, now + cfg.listingTtlHours * HOUR);
    addLedgerEntry(db, { wallet: seller, deltaMicros: -amountMicros, kind: 'market_escrow', ref: `listing:${id}` });
    return getListing(db, id)!;
  });
  return tx();
}

/** Cancel an open listing: what is left returns to the seller's spendable credits. Idempotent for an already-closed listing (returns it). */
export function cancelListing(db: Db, input: { seller: string; id: string }, now = nowSec()): ListingRow {
  const tx = db.transaction(() => {
    const row = getListing(db, input.id);
    if (!row || row.seller_wallet !== input.seller) throw new MarketError(404, 'not_found', 'no such listing for this wallet');
    if (row.status !== 'open') return row;
    closeListing(db, row, 'cancelled', now);
    return getListing(db, row.id)!;
  });
  return tx();
}

function closeListing(db: Db, row: ListingRow, status: 'cancelled' | 'expired', now: number): void {
  db.prepare(`UPDATE market_listings SET status = ?, remaining_micros = 0, closed_at = ? WHERE id = ?`).run(status, now, row.id);
  if (row.remaining_micros > 0) {
    addLedgerEntry(db, { wallet: row.seller_wallet, deltaMicros: row.remaining_micros, kind: 'market_refund', ref: `listing:${row.id}:${status}` });
  }
}

export function listingsOf(db: Db, seller: string, limit = 50): ListingRow[] {
  return db.prepare(`SELECT * FROM market_listings WHERE seller_wallet = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(seller, limit) as ListingRow[];
}

// ---------------- buyers ----------------

/**
 * Fill (part of) a listing from the buyer's prepaid balance. In one transaction: the listing's
 * remainder shrinks (filled when it hits zero), the buyer's prepaid balance pays the price, the seller's
 * prepaid balance receives price − fee, the buyer's credits grow by the face value, the treasury books
 * its share of the fee and the holders' share waits in `pool_extra_micros` for the next epoch.
 */
export function fillListing(
  db: Db,
  cfg: MarketConfig,
  input: { buyer: string; chain: string; listingId: string; creditsMicros: number },
  now = nowSec(),
): FillRow {
  const { buyer, creditsMicros } = input;
  if (!Number.isInteger(creditsMicros) || creditsMicros <= 0) throw new MarketError(400, 'bad_amount', 'amount must be a positive number of USD');
  const tx = db.transaction(() => {
    const listing = getListing(db, input.listingId);
    if (!listing) throw new MarketError(404, 'not_found', 'no such listing');
    if (listing.status !== 'open' || listing.expires_at <= now) throw new MarketError(409, 'listing_closed', 'this listing is no longer open');
    if (listing.seller_wallet === buyer) throw new MarketError(409, 'own_listing', 'you cannot buy your own listing; cancel it instead');
    if (creditsMicros > listing.remaining_micros) throw new MarketError(409, 'insufficient_depth', `only $${usdStr(listing.remaining_micros)} of this listing is left`);
    if (creditsMicros < MIN_FILL_MICROS && creditsMicros !== listing.remaining_micros) throw new MarketError(400, 'below_minimum', 'buys start at $0.01 (or the whole remainder)');
    ensureWallet(db, buyer, input.chain);
    const q = quote(cfg, creditsMicros, listing.discount_bps);
    const prepaid = prepaidBalanceMicros(db, buyer);
    if (prepaid < q.paidMicros) throw new MarketError(402, 'insufficient_prepaid', `prepaid balance is $${usdStr(prepaid)}; this buy costs $${usdStr(q.paidMicros)}`);

    const id = newId('fill');
    const ref = `fill:${id}`;
    const remaining = listing.remaining_micros - creditsMicros;
    db.prepare(`UPDATE market_listings SET remaining_micros = ?, status = ?, closed_at = ? WHERE id = ?`).run(remaining, remaining === 0 ? 'filled' : 'open', remaining === 0 ? now : null, listing.id);
    db.prepare(
      `INSERT INTO market_fills (id, listing_id, buyer_wallet, seller_wallet, credits_micros, paid_micros, fee_micros, fee_to_holders_micros, fee_to_treasury_micros, discount_bps, settlement, settlement_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepaid', NULL, ?)`,
    ).run(id, listing.id, buyer, listing.seller_wallet, q.creditsMicros, q.paidMicros, q.feeMicros, q.feeToHoldersMicros, q.feeToTreasuryMicros, listing.discount_bps, now);
    // money: buyer prepaid → seller prepaid (net of fee), treasury, holder pool
    if (q.paidMicros > 0) addPrepaidEntry(db, { wallet: buyer, deltaMicros: -q.paidMicros, kind: 'market_buy', ref }, now);
    if (q.sellerReceivesMicros > 0) addPrepaidEntry(db, { wallet: listing.seller_wallet, deltaMicros: q.sellerReceivesMicros, kind: 'market_sale', ref }, now);
    if (q.feeToTreasuryMicros > 0) addTreasuryEntry(db, { kind: 'market_fee', usdMicros: q.feeToTreasuryMicros, ref }, now);
    if (q.feeToHoldersMicros > 0) db.prepare(`INSERT INTO pool_extra_micros (source, usd_micros, ref, created_at) VALUES ('market_fee', ?, ?, ?)`).run(q.feeToHoldersMicros, ref, now);
    // credits: the escrowed face value moves to the buyer
    addLedgerEntry(db, { wallet: buyer, deltaMicros: q.creditsMicros, kind: 'market_buy', ref });
    return getFill(db, id)!;
  });
  return tx();
}

export function fillsOf(db: Db, wallet: string, limit = 50): { asBuyer: FillRow[]; asSeller: FillRow[] } {
  return {
    asBuyer: db.prepare(`SELECT * FROM market_fills WHERE buyer_wallet = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(wallet, limit) as FillRow[],
    asSeller: db.prepare(`SELECT * FROM market_fills WHERE seller_wallet = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(wallet, limit) as FillRow[],
  };
}

// ---------------- withdrawals ----------------

/** Ask for prepaid USD to be paid out. The amount leaves the balance at once (so it cannot be spent twice) and an admin marks the request paid. */
export function requestWithdrawal(db: Db, input: { wallet: string; amountMicros: number }, now = nowSec()): WithdrawalRow {
  if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) throw new MarketError(400, 'bad_amount', 'amount must be a positive number of USD');
  const tx = db.transaction(() => {
    const bal = prepaidBalanceMicros(db, input.wallet);
    if (bal < input.amountMicros) throw new MarketError(402, 'insufficient_prepaid', `prepaid balance is $${usdStr(bal)}; cannot withdraw $${usdStr(input.amountMicros)}`);
    const res = db.prepare(`INSERT INTO withdrawal_requests (wallet, amount_micros, status, created_at) VALUES (?, ?, 'pending', ?)`).run(input.wallet, input.amountMicros, now);
    const id = Number(res.lastInsertRowid);
    addPrepaidEntry(db, { wallet: input.wallet, deltaMicros: -input.amountMicros, kind: 'withdrawal', ref: `withdrawal:${id}` }, now);
    return getWithdrawal(db, id)!;
  });
  return tx();
}

export function getWithdrawal(db: Db, id: number): WithdrawalRow | null {
  return (db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(id) as WithdrawalRow | undefined) ?? null;
}

export function withdrawalsOf(db: Db, wallet: string, limit = 50): WithdrawalRow[] {
  return db.prepare(`SELECT * FROM withdrawal_requests WHERE wallet = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(wallet, limit) as WithdrawalRow[];
}

export function pendingWithdrawals(db: Db, limit = 200): WithdrawalRow[] {
  return db.prepare(`SELECT * FROM withdrawal_requests WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`).all(limit) as WithdrawalRow[];
}

/** Admin confirms the payout went out. Idempotent: a paid request is returned unchanged. */
export function markWithdrawalPaid(db: Db, input: { id: number; txRef?: string | null; note?: string | null }, now = nowSec()): WithdrawalRow {
  const tx = db.transaction(() => {
    const row = getWithdrawal(db, input.id);
    if (!row) throw new MarketError(404, 'not_found', 'no such withdrawal request');
    if (row.status === 'paid') return row;
    db.prepare(`UPDATE withdrawal_requests SET status = 'paid', tx_ref = ?, note = ?, paid_at = ? WHERE id = ?`).run(input.txRef ?? null, input.note ?? null, now, row.id);
    return getWithdrawal(db, row.id)!;
  });
  return tx();
}

// ---------------- maintenance ----------------

/** Expire old open listings; escrow returns to the sellers. Safe to run any time. */
export function reapMarket(db: Db, now = nowSec()): { listingsExpired: number } {
  const tx = db.transaction(() => {
    const listings = db.prepare(`SELECT * FROM market_listings WHERE status = 'open' AND expires_at <= ?`).all(now) as ListingRow[];
    for (const l of listings) closeListing(db, l, 'expired', now);
    return { listingsExpired: listings.length };
  });
  return tx();
}

/**
 * Extra micro-USD waiting to join the holder pool (today: the holders' share of marketplace fees).
 * `runEpoch` reads the amount and the id watermark before splitting, then `claimPoolExtra` marks exactly
 * those rows inside its write transaction so nothing is distributed twice or lost.
 */
export function pendingPoolExtra(db: Db): { usdMicros: number; maxId: number } {
  const row = db.prepare(`SELECT COALESCE(SUM(usd_micros), 0) AS v, COALESCE(MAX(id), 0) AS m FROM pool_extra_micros WHERE epoch_start IS NULL`).get() as { v: number; m: number };
  return { usdMicros: row.v, maxId: row.m };
}

export function claimPoolExtra(db: Db, epochStart: number, maxId: number): number {
  return db.prepare(`UPDATE pool_extra_micros SET epoch_start = ? WHERE epoch_start IS NULL AND id <= ?`).run(epochStart, maxId).changes;
}

// ---------------- public views ----------------

export interface BookTier {
  discountBps: number;
  availableMicros: number;
  listings: number;
}

export interface Book {
  tiers: BookTier[];
  bestDiscountBps: number | null;
  totalAvailableMicros: number;
  listings: number;
}

/** Open depth aggregated by discount, deepest discount first (what a buyer wants to see). */
export function book(db: Db, now = nowSec()): Book {
  const tiers = db
    .prepare(
      `SELECT discount_bps AS discountBps, SUM(remaining_micros) AS availableMicros, COUNT(*) AS listings
       FROM market_listings WHERE status = 'open' AND remaining_micros > 0 AND expires_at > ?
       GROUP BY discount_bps ORDER BY discount_bps DESC`,
    )
    .all(now) as BookTier[];
  return {
    tiers,
    bestDiscountBps: tiers.length ? tiers[0].discountBps : null,
    totalAvailableMicros: tiers.reduce((a, t) => a + t.availableMicros, 0),
    listings: tiers.reduce((a, t) => a + t.listings, 0),
  };
}

/** Open listings, deepest discount first then oldest first (so partial fills drain the queue fairly). */
export function openListings(db: Db, opts: { limit: number; offset: number; discountBps?: number }, now = nowSec()): { rows: ListingRow[]; total: number } {
  const where = [`status = 'open'`, 'remaining_micros > 0', 'expires_at > ?'];
  const args: unknown[] = [now];
  if (opts.discountBps !== undefined) {
    where.push('discount_bps = ?');
    args.push(opts.discountBps);
  }
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM market_listings WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM market_listings WHERE ${w} ORDER BY discount_bps DESC, created_at ASC, rowid ASC LIMIT ? OFFSET ?`).all(...args, opts.limit, opts.offset) as ListingRow[];
  return { rows, total };
}

export interface MarketTotals {
  /** Face value ever listed (all statuses). */
  listedMicros: number;
  /** Face value that changed hands. */
  filledMicros: number;
  /** What buyers paid for it. */
  paidMicros: number;
  feesMicros: number;
  feesToHoldersMicros: number;
  feesToTreasuryMicros: number;
  fills: number;
  openListings: number;
  openDepthMicros: number;
  bestDiscountBps: number | null;
  /** Volume-weighted average discount of fills, bps (null before the first fill). */
  avgDiscountBps: number | null;
  poolExtraPendingMicros: number;
  prepaidOutstandingMicros: number;
  withdrawalsPendingMicros: number;
  withdrawalsPaidMicros: number;
}

export function marketTotals(db: Db, since = 0, now = nowSec()): MarketTotals {
  const listed = db.prepare(`SELECT COALESCE(SUM(amount_micros), 0) AS v FROM market_listings WHERE created_at >= ?`).get(since) as { v: number };
  const f = db
    .prepare(
      `SELECT COALESCE(SUM(credits_micros),0) AS credits, COALESCE(SUM(paid_micros),0) AS paid, COALESCE(SUM(fee_micros),0) AS fee,
              COALESCE(SUM(fee_to_holders_micros),0) AS holders, COALESCE(SUM(fee_to_treasury_micros),0) AS treasury,
              COALESCE(SUM(credits_micros * discount_bps),0) AS weighted, COUNT(*) AS n
       FROM market_fills WHERE created_at >= ?`,
    )
    .get(since) as { credits: number; paid: number; fee: number; holders: number; treasury: number; weighted: number; n: number };
  const b = book(db, now);
  const wd = db
    .prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_micros END),0) AS pending, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_micros END),0) AS paid FROM withdrawal_requests`)
    .get() as { pending: number; paid: number };
  return {
    listedMicros: listed.v,
    filledMicros: f.credits,
    paidMicros: f.paid,
    feesMicros: f.fee,
    feesToHoldersMicros: f.holders,
    feesToTreasuryMicros: f.treasury,
    fills: f.n,
    openListings: b.listings,
    openDepthMicros: b.totalAvailableMicros,
    bestDiscountBps: b.bestDiscountBps,
    avgDiscountBps: f.credits > 0 ? Math.round(f.weighted / f.credits) : null,
    poolExtraPendingMicros: pendingPoolExtra(db).usdMicros,
    prepaidOutstandingMicros: prepaidOutstandingMicros(db),
    withdrawalsPendingMicros: wd.pending,
    withdrawalsPaidMicros: wd.paid,
  };
}
