// Credit expiry and non-transferable starter credit (docs/PRICING.md §6, config `creditExpiry`,
// `starterCredits.transferable`).
//
// Every credit lapses `creditExpiry.days` after it landed in the wallet, whatever its source. The ledger
// is append-only and has no lots, so the rule is derived from sums, which is exact because every credit
// has the same lifetime and the oldest credit is always spent first:
//
//   grants   = rows that add credit with a fresh clock (distribution, starter, market_buy, purchase,
//              positive adjustment)
//   consumed = everything that took credit away (usage, market_escrow, expiry, negative adjustment)
//              minus market_refund, which hands escrowed credit back with its original date
//   lapsed   = max(0, grants older than the cutoff − consumed)
//
// Whatever was consumed came off the oldest grants first, so what is left of the grants older than the
// cutoff is exactly the credit that has outlived its window. It is debited with one `expiry` row.
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addLedgerEntry, balanceMicros } from './ledger.js';
import { microsToUsd } from './money.js';

export type ExpiryConfig = TokenomicsConfig['creditExpiry'];

const DAY = 86_400;

/** Rows that add credit with a fresh clock. A `market_refund` is not one: it returns credit that is already ageing. */
const GRANT = `delta_usd_micros > 0 AND kind != 'market_refund'`;

/** Credit taken out of the wallet so far (spent, listed, lapsed), net of listing refunds. Oldest grants absorb it first. */
function consumedMicros(db: Db, wallet: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN delta_usd_micros < 0 THEN -delta_usd_micros ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN kind = 'market_refund' THEN delta_usd_micros ELSE 0 END), 0) AS v
       FROM credits_ledger WHERE wallet = ?`,
    )
    .get(wallet) as { v: number };
  return row.v;
}

function grantsUpTo(db: Db, wallet: string, cutoff: number): number {
  return (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros), 0) AS v FROM credits_ledger WHERE wallet = ? AND ${GRANT} AND created_at <= ?`).get(wallet, cutoff) as { v: number }).v;
}

/** Micro-USD of `wallet`'s credit that has outlived the window and is still in the spendable balance. */
export function lapsedMicros(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec()): number {
  if (!cfg.enabled) return 0;
  const cutoff = now - cfg.days * DAY;
  return Math.max(0, grantsUpTo(db, wallet, cutoff) - consumedMicros(db, wallet));
}

/**
 * Debit whatever has lapsed in `wallet`. `heldMicros` is credit reserved by the wallet's requests in
 * flight (reserve.ts): it is about to be spent, and that spend comes off the oldest credit, so it is left
 * alone here rather than expired under a request that was already promised it. Returns micro-USD expired.
 */
export function expireWallet(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec(), heldMicros = 0): number {
  if (!cfg.enabled) return 0;
  const tx = db.transaction(() => {
    const lapsed = Math.min(lapsedMicros(db, wallet, cfg, now), Math.max(0, balanceMicros(db, wallet) - heldMicros));
    if (lapsed <= 0) return 0;
    addLedgerEntry(db, { wallet, deltaMicros: -lapsed, kind: 'expiry', ref: `expiry:${now - cfg.days * DAY}` });
    return lapsed;
  });
  return tx();
}

/**
 * Sweep every wallet that holds a grant older than the window. Run once per epoch (jobs/housekeeping.ts);
 * the request path and the market also expire a single wallet lazily, so a balance is never spendable
 * past its date between sweeps.
 */
export function expireAll(db: Db, cfg: ExpiryConfig, opts: { now?: number; heldMicros?: (wallet: string) => number } = {}): { wallets: number; expiredMicros: number } {
  if (!cfg.enabled) return { wallets: 0, expiredMicros: 0 };
  const now = opts.now ?? nowSec();
  const cutoff = now - cfg.days * DAY;
  const candidates = db.prepare(`SELECT DISTINCT wallet FROM credits_ledger WHERE ${GRANT} AND created_at <= ?`).all(cutoff) as Array<{ wallet: string }>;
  let wallets = 0;
  let expiredMicros = 0;
  for (const { wallet } of candidates) {
    const n = expireWallet(db, wallet, cfg, now, opts.heldMicros?.(wallet) ?? 0);
    if (n > 0) {
      wallets++;
      expiredMicros += n;
    }
  }
  return { wallets, expiredMicros };
}

export interface ExpiryOutlook {
  enabled: boolean;
  days: number;
  /** The next credit to lapse: how much, and when (unix seconds). Null when nothing is ageing. */
  next: { usd: number; at: number } | null;
  /** USD of the spendable balance that lapses within the next 7 / 30 days if it is not spent. */
  within7dUsd: number;
  within30dUsd: number;
}

/**
 * What is about to lapse in `wallet`, for GET /me. Walks the grants still inside the window oldest first
 * and takes what has been consumed off them in that order; what is left of each grant lapses `days`
 * after it landed. Lots that land in the same hour are reported together.
 */
export function expiryOutlook(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec()): ExpiryOutlook {
  const out: ExpiryOutlook = { enabled: cfg.enabled, days: cfg.days, next: null, within7dUsd: 0, within30dUsd: 0 };
  if (!cfg.enabled) return out;
  const window = cfg.days * DAY;
  const cutoff = now - window;
  // Consumption is absorbed by the grants older than the cutoff first; only the rest reaches the window.
  let absorb = Math.max(0, consumedMicros(db, wallet) - grantsUpTo(db, wallet, cutoff));
  const grants = db
    .prepare(`SELECT delta_usd_micros AS v, created_at AS at FROM credits_ledger WHERE wallet = ? AND ${GRANT} AND created_at > ? ORDER BY created_at ASC, id ASC`)
    .all(wallet, cutoff) as Array<{ v: number; at: number }>;
  let in7 = 0;
  let in30 = 0;
  let nextAt: number | null = null;
  let nextMicros = 0;
  for (const g of grants) {
    const take = Math.min(g.v, absorb);
    absorb -= take;
    const left = g.v - take;
    if (left <= 0) continue;
    const at = g.at + window;
    if (nextAt === null) nextAt = at;
    if (Math.floor(at / 3600) === Math.floor(nextAt / 3600)) nextMicros += left;
    if (at <= now + 7 * DAY) in7 += left;
    if (at <= now + 30 * DAY) in30 += left;
  }
  if (nextAt !== null) out.next = { usd: microsToUsd(nextMicros), at: nextAt };
  out.within7dUsd = microsToUsd(in7);
  out.within30dUsd = microsToUsd(in30);
  return out;
}

/** USD lapsed so far, across every wallet (GET /report `totals.creditExpiry`). */
export function expiredTotals(db: Db, sinceSec = 0): { expiredMicros: number; wallets: number } {
  const row = db.prepare(`SELECT COALESCE(SUM(-delta_usd_micros), 0) AS v, COUNT(DISTINCT wallet) AS n FROM credits_ledger WHERE kind = 'expiry' AND created_at >= ?`).get(sinceSec) as { v: number; n: number };
  return { expiredMicros: row.v, wallets: row.n };
}

/**
 * Micro-USD of `wallet`'s spendable balance that came from a starter grant and has not been used yet.
 * With `starterCredits.transferable: false` this much is held back from marketplace listings. Requests
 * (and expiry) are counted against the grant first, so earned and bought credit stays listable.
 */
export function nonTransferableMicros(db: Db, wallet: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'starter' THEN delta_usd_micros ELSE 0 END), 0) AS starter,
              COALESCE(SUM(CASE WHEN kind IN ('usage', 'expiry') THEN -delta_usd_micros ELSE 0 END), 0) AS used
       FROM credits_ledger WHERE wallet = ?`,
    )
    .get(wallet) as { starter: number; used: number };
  const left = Math.max(0, row.starter - row.used);
  return left === 0 ? 0 : Math.min(left, Math.max(0, balanceMicros(db, wallet)));
}
