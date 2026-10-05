// Usage-revenue share to holders (docs/PRICING.md, "Engine 2").
//
// Trading fees are engine 1: they fund the hourly credit pool. This is engine 2: when a PAID request
// leaves Mesh a margin, `usageShare.holderBps` of that margin joins the next hourly holder pool through
// `pool_extra_micros` (the same hook the credit marketplace uses for its fee share, market.ts) and the
// rest stays with the treasury. Margins:
//
//   network-served  : what the user paid (flat network price) − the node's reward
//   upstream-served : what the user was billed (list ± markup/discount) − the upstream's cost (list)
//
// A negative margin (an upstream discount, a network price below the node reward) contributes nothing;
// guests contribute nothing (the treasury paid for them, there is no revenue). Ships off: with
// `enabled: false` this module never writes a row.
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { bpsOf, microsToUsd } from './money.js';

export type UsageShareConfig = TokenomicsConfig['usageShare'];
export type UsageShareSource = 'network' | 'upstream';

export interface UsageShareInput {
  source: UsageShareSource;
  /** Unique per request (`usage:job:<jobId>` / `usage:up:<…>`): the pool_extra and log rows are keyed by it. */
  ref: string;
  wallet: string;
  model: string;
  /** Micro-USD the user paid. */
  billedMicros: number;
  /** Micro-USD it cost Mesh (node reward or upstream list cost). */
  costMicros: number;
}

export interface UsageShareSplit {
  marginMicros: number;
  holderMicros: number;
  treasuryMicros: number;
}

/** Pure split: margin = billed − cost; holderBps of a positive margin to holders, the rest to the treasury; nothing on a non-positive margin. */
export function splitUsageMargin(cfg: Pick<UsageShareConfig, 'holderBps'>, billedMicros: number, costMicros: number): UsageShareSplit {
  const marginMicros = billedMicros - costMicros;
  if (marginMicros <= 0) return { marginMicros, holderMicros: 0, treasuryMicros: 0 };
  const holderMicros = bpsOf(marginMicros, cfg.holderBps);
  return { marginMicros, holderMicros, treasuryMicros: marginMicros - holderMicros };
}

/**
 * Book one paid request's margin. Returns the split, or null when nothing was written (feature off,
 * source disabled, margin ≤ 0, or the ref was already booked). Call inside the request's accounting
 * transaction so the pool row and the audit row land together with the ledger debit.
 */
export function recordUsageShare(db: Db, cfg: UsageShareConfig, input: UsageShareInput, now = nowSec()): UsageShareSplit | null {
  if (!cfg.enabled) return null;
  if (!cfg.sources[input.source]) return null;
  const split = splitUsageMargin(cfg, input.billedMicros, input.costMicros);
  if (split.holderMicros <= 0 && split.treasuryMicros <= 0) return null;
  const res = db
    .prepare(
      `INSERT INTO usage_share_log (source, ref, wallet, model, billed_micros, cost_micros, margin_micros, holder_micros, treasury_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING`,
    )
    .run(input.source, input.ref, input.wallet, input.model, input.billedMicros, input.costMicros, split.marginMicros, split.holderMicros, split.treasuryMicros, now);
  if (res.changes === 0) return null;
  if (split.holderMicros > 0) {
    db.prepare(`INSERT INTO pool_extra_micros (source, usd_micros, ref, created_at) VALUES ('usage', ?, ?, ?) ON CONFLICT(ref) DO NOTHING`).run(split.holderMicros, input.ref, now);
  }
  return split;
}

export interface UsageShareTotals {
  marginUsd: number;
  toHoldersUsd: number;
  toTreasuryUsd: number;
  requests: number;
}

const EMPTY: UsageShareTotals = { marginUsd: 0, toHoldersUsd: 0, toTreasuryUsd: 0, requests: 0 };

/** Totals from usage_share_log, optionally per source and since a timestamp. */
export function usageShareTotals(db: Db, opts: { source?: UsageShareSource; sinceSec?: number } = {}): UsageShareTotals {
  const conds = ['created_at >= ?'];
  const args: unknown[] = [opts.sinceSec ?? 0];
  if (opts.source) {
    conds.push('source = ?');
    args.push(opts.source);
  }
  const row = db
    .prepare(`SELECT COALESCE(SUM(margin_micros),0) AS m, COALESCE(SUM(holder_micros),0) AS h, COALESCE(SUM(treasury_micros),0) AS t, COUNT(*) AS n FROM usage_share_log WHERE ${conds.join(' AND ')}`)
    .get(...args) as { m: number; h: number; t: number; n: number } | undefined;
  if (!row) return EMPTY;
  return { marginUsd: microsToUsd(row.m), toHoldersUsd: microsToUsd(row.h), toTreasuryUsd: microsToUsd(row.t), requests: row.n };
}

/** Micro-USD booked to holders from usage in the last 24h (GET /stats `usageShareToHolders24hUsd`). */
export function usageShareToHolders24hUsd(db: Db, now = nowSec()): number {
  return usageShareTotals(db, { sinceSec: now - 86_400 }).toHoldersUsd;
}
