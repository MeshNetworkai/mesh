// Credit expiry and non-transferable starter credit (docs/PRICING.md §6, config `creditExpiry`,
// `starterCredits.transferable`).
//
// Every credit lapses `creditExpiry.days` after it landed in the wallet, whatever its source. The ledger
// is append-only and has no lots, so the rule is derived from two sums, which is exact because every
// credit has the same lifetime and the oldest credit is always spent first:
//
//   fresh  = grants still inside the window: rows that add credit with a fresh clock (distribution,
//            starter, market_buy, purchase, node_payout, positive adjustment) newer than the cutoff
//   lapsed = max(0, balance − fresh)
//
// Whatever left the wallet (spent, listed, lapsed) came off the oldest grants first, so any part of the
// balance that the grants inside the window cannot account for is credit that has outlived its window.
// It is debited with one `expiry` row. A `market_refund` is not a grant: it hands escrowed credit back
// with its original date, so it raises the balance without raising `fresh`.
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addLedgerEntry, balanceMicros } from './ledger.js';
import { microsToUsd } from './money.js';

export type ExpiryConfig = TokenomicsConfig['creditExpiry'];

const DAY = 86_400;

/** Rows that add credit with a fresh clock. A `market_refund` is not one: it returns credit that is already ageing. */
const GRANT = `delta_usd_micros > 0 AND kind != 'market_refund'`;

/** The wallet's balance and the grants still inside the window, in one pass over its rows. */
function position(db: Db, wallet: string, cutoff: number): { balance: number; fresh: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(delta_usd_micros), 0) AS balance,
              COALESCE(SUM(CASE WHEN ${GRANT} AND created_at > ? THEN delta_usd_micros ELSE 0 END), 0) AS fresh
       FROM credits_ledger WHERE wallet = ?`,
    )
    .get(cutoff, wallet) as { balance: number; fresh: number };
}

/** Micro-USD of `wallet`'s credit that has outlived the window and is still in the spendable balance. */
export function lapsedMicros(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec()): number {
  if (!cfg.enabled) return 0;
  const { balance, fresh } = position(db, wallet, now - cfg.days * DAY);
  return Math.max(0, balance - fresh);
}

/**
 * Debit whatever has lapsed in `wallet` and return what was expired and the balance that is left.
 * `heldMicros` is credit reserved by the wallet's requests in flight (reserve.ts): it is about to be
 * spent, and that spend comes off the oldest credit, so it is left alone here rather than expired under a
 * request that was already promised it. One pass over the wallet's rows, so the request path (routes/v1.ts)
 * reads its balance here instead of a second time.
 */
export function settleExpiry(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec(), heldMicros = 0): { expiredMicros: number; balanceMicros: number } {
  if (!cfg.enabled) return { expiredMicros: 0, balanceMicros: balanceMicros(db, wallet) };
  const cutoff = now - cfg.days * DAY;
  const { balance, fresh } = position(db, wallet, cutoff);
  const lapsed = Math.min(balance - fresh, balance - heldMicros);
  if (lapsed <= 0) return { expiredMicros: 0, balanceMicros: balance };
  addLedgerEntry(db, { wallet, deltaMicros: -lapsed, kind: 'expiry', ref: `expiry:${cutoff}` }, now);
  return { expiredMicros: lapsed, balanceMicros: balance - lapsed };
}

/** Debit whatever has lapsed in `wallet` (see `settleExpiry`). Returns micro-USD expired. */
export function expireWallet(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec(), heldMicros = 0): number {
  return settleExpiry(db, wallet, cfg, now, heldMicros).expiredMicros;
}

/**
 * Sweep every wallet whose balance holds more than its grants inside the window account for. Run once per
 * epoch (jobs/housekeeping.ts); the request path and the market also expire a single wallet lazily, so a
 * balance is never spendable past its date between sweeps. One pass over the ledger finds the wallets;
 * only those are then settled.
 */
export function expireAll(db: Db, cfg: ExpiryConfig, opts: { now?: number; heldMicros?: (wallet: string) => number } = {}): { wallets: number; expiredMicros: number } {
  if (!cfg.enabled) return { wallets: 0, expiredMicros: 0 };
  const now = opts.now ?? nowSec();
  const candidates = db
    .prepare(
      `SELECT wallet FROM credits_ledger GROUP BY wallet
       HAVING SUM(delta_usd_micros) > SUM(CASE WHEN ${GRANT} AND created_at > ? THEN delta_usd_micros ELSE 0 END)`,
    )
    .all(now - cfg.days * DAY) as Array<{ wallet: string }>;
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
  // What has been spent comes off the oldest credit first: only the part of the grants inside the window
  // that the balance no longer holds has been taken from them.
  const { balance, fresh } = position(db, wallet, cutoff);
  let absorb = Math.max(0, fresh - balance);
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
 * made since the grant are counted against it first, so earned and bought credit stays listable; requests
 * from before it, and other credit lapsing, do not unlock it. Once the grant has outlived the expiry
 * window nothing of it is left to hold back.
 */
export function nonTransferableMicros(db: Db, wallet: string, cfg: ExpiryConfig, now = nowSec()): number {
  const grant = db
    .prepare(`SELECT MIN(id) AS firstId, COALESCE(SUM(delta_usd_micros), 0) AS total, MAX(created_at) AS lastAt FROM credits_ledger WHERE wallet = ? AND kind = 'starter'`)
    .get(wallet) as { firstId: number | null; total: number; lastAt: number | null };
  if (grant.firstId === null || grant.lastAt === null || grant.total <= 0) return 0;
  if (cfg.enabled && grant.lastAt + cfg.days * DAY <= now) return 0;
  const used = (db.prepare(`SELECT COALESCE(SUM(-delta_usd_micros), 0) AS v FROM credits_ledger WHERE wallet = ? AND kind = 'usage' AND id > ?`).get(wallet, grant.firstId) as { v: number }).v;
  const left = Math.max(0, grant.total - used);
  return left === 0 ? 0 : Math.min(left, Math.max(0, balanceMicros(db, wallet)));
}
