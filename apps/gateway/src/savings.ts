// Network credits: cost math and per-wallet aggregation.
//
// A request served by a Mesh node is billed the flat network price (requestPricing.networkPricePerMTokens)
// instead of the model's list price. The difference is what the wallet "saved", and
// list ÷ network is how much further the credits went ("2.4× further").
import { listPriceForModel, type ModelPolicy, type ModelPrices } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { microsToUsd, usdToMicros } from './money.js';
import { tokenCount, type Usage } from './upstream.js';

/** Micro-USD the upstream would have charged for `usage` at the model's list price (plus markup). */
export function listCostMicros(usage: Usage | null | undefined, model: string, prices: ModelPrices, policy: ModelPolicy, markupBps = 0): number {
  const p = listPriceForModel(prices, policy, model);
  const prompt = tokenCount(usage?.prompt_tokens);
  const completion = tokenCount(usage?.completion_tokens);
  let micros = usdToMicros((prompt * p.promptUsdPerM + completion * p.completionUsdPerM) / 1_000_000);
  if (markupBps) micros += Math.floor((micros * markupBps) / 10_000);
  return micros;
}

/** Micro-USD saved by paying the network price instead of list. Never negative: a model that is cheaper upstream saves nothing. */
export function savedMicros(listMicros: number, networkMicros: number): number {
  return Math.max(0, listMicros - networkMicros);
}

/**
 * Effective multiplier: how many times further credits went on the network (list ÷ network cost).
 * 1 when nothing was saved or nothing was spent; rounded to 1 decimal.
 */
export function effectiveMultiplier(listMicros: number, networkMicros: number): number {
  if (networkMicros <= 0 || listMicros <= networkMicros) return 1;
  return Math.round((listMicros / networkMicros) * 10) / 10;
}

export interface SavingsView {
  /** Saved over the last 24h, USD. */
  usd24h: number;
  /** Saved all time, USD. */
  usdTotal: number;
  /** Share of this wallet's requests served by Mesh nodes (all time), 0..100. */
  networkSharePercent: number;
  /** list ÷ network cost over every network-served request (all time). 1 when nothing saved. */
  multiplier: number;
  /** What the wallet paid for network-served requests (all time), USD. */
  networkSpendUsdTotal: number;
  /** Requests served by Mesh nodes (all time). */
  networkRequests: number;
  requests: number;
}

/** Per-wallet savings from requests_log. */
export function walletSavings(db: Db, wallet: string, now = nowSec()): SavingsView {
  const day = db
    .prepare(`SELECT COALESCE(SUM(saved_usd_micros),0) AS saved FROM requests_log WHERE wallet = ? AND created_at >= ?`)
    .get(wallet, now - 86_400) as { saved: number };
  const all = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(saved_usd_micros),0) AS saved,
              COALESCE(SUM(CASE WHEN upstream LIKE 'node:%' THEN 1 ELSE 0 END),0) AS networkN,
              COALESCE(SUM(CASE WHEN upstream LIKE 'node:%' THEN cost_usd_micros ELSE 0 END),0) AS networkCost,
              COALESCE(SUM(CASE WHEN upstream LIKE 'node:%' THEN list_cost_usd_micros ELSE 0 END),0) AS networkList
       FROM requests_log WHERE wallet = ?`,
    )
    .get(wallet) as { n: number; saved: number; networkN: number; networkCost: number; networkList: number };
  return {
    usd24h: microsToUsd(day.saved),
    usdTotal: microsToUsd(all.saved),
    networkSharePercent: all.n === 0 ? 0 : Math.round((all.networkN / all.n) * 10_000) / 100,
    multiplier: effectiveMultiplier(all.networkList, all.networkCost),
    networkSpendUsdTotal: microsToUsd(all.networkCost),
    networkRequests: all.networkN,
    requests: all.n,
  };
}

/** Network-wide savings over the last 24h, USD. */
export function networkSavingsUsd24h(db: Db, now = nowSec()): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(saved_usd_micros),0) AS saved FROM requests_log WHERE created_at >= ?`)
    .get(now - 86_400) as { saved: number };
  return microsToUsd(row.saved);
}
