import type { ChainAdapter, HolderBalance } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { addTreasuryEntry, ensureWallet } from '../ledger.js';
import { bpsOf, splitProRata, usdToMicros } from '../money.js';
import { syncPoints } from '../points.js';

export type HoldingAgeConfig = TokenomicsConfig['distribution']['holdingAge'];

const DAY = 86_400;

/**
 * Holding-age multiplier: linear from minMultiplier at age 0 to maxMultiplier at age >= maxDays.
 * Disabled config, or an unknown age (no adapter value and nothing cached), yields 1: plain pro-rata.
 */
export function holdingAgeMultiplier(cfg: HoldingAgeConfig, holdSinceTs: number | undefined, at: number): number {
  if (!cfg.enabled) return 1;
  if (holdSinceTs === undefined || !Number.isFinite(holdSinceTs)) return 1;
  const ageDays = Math.max(0, (at - holdSinceTs) / DAY);
  const t = Math.min(1, ageDays / cfg.maxDays);
  return cfg.minMultiplier + (cfg.maxMultiplier - cfg.minMultiplier) * t;
}

export interface HolderAgeRow {
  wallet: string;
  hold_since: number;
  last_balance: number;
  updated_at: number;
}

/**
 * Resolve each holder's hold-since timestamp and refresh the `holder_age` cache.
 * - The adapter's `holdSinceTs` wins when present (and is cached).
 * - Otherwise the cache is used: a wallet is first seen above `minHoldTokens` at `at`; dropping
 *   below the threshold forgets it; a lower balance than last time (a transfer out) resets it.
 * The cache is maintained even when weighting is disabled so ages are ready when it is enabled.
 */
export function resolveHoldSince(
  db: Db,
  balances: HolderBalance[],
  minHoldTokens: number,
  at: number,
): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  const get = db.prepare(`SELECT wallet, hold_since, last_balance, updated_at FROM holder_age WHERE wallet = ?`);
  const upsert = db.prepare(
    `INSERT INTO holder_age (wallet, hold_since, last_balance, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET hold_since = excluded.hold_since, last_balance = excluded.last_balance, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(`DELETE FROM holder_age WHERE wallet = ?`);
  const run = db.transaction(() => {
    for (const b of balances) {
      const bal = b.timeWeightedBalance;
      if (b.holdSinceTs !== undefined) {
        out.set(b.wallet, b.holdSinceTs);
        if (bal >= minHoldTokens && bal > 0) upsert.run(b.wallet, b.holdSinceTs, bal, at);
        else del.run(b.wallet);
        continue;
      }
      const row = get.get(b.wallet) as HolderAgeRow | undefined;
      if (!(bal >= minHoldTokens && bal > 0)) {
        if (row) del.run(b.wallet);
        out.set(b.wallet, undefined);
        continue;
      }
      let since = row?.hold_since ?? at;
      if (row && bal < row.last_balance) since = at; // transfer out observed → age resets
      upsert.run(b.wallet, since, bal, at);
      out.set(b.wallet, since);
    }
  });
  run();
  return out;
}

export interface EpochResult {
  epochStart: number;
  epochEnd: number;
  status: 'complete' | 'empty' | 'skipped';
  feesUsdMicros: number;
  holderPoolUsdMicros: number;
  treasuryUsdMicros: number;
  eligibleHolders: number;
  feeTxId: string | null;
  /** Whether holding-age weighting was applied to this epoch. */
  holdingAgeApplied: boolean;
  distributed: Array<{ wallet: string; usdMicros: number; multiplier: number }>;
}

export interface EpochRow {
  epoch_start: number;
  epoch_end: number;
  fees_usd_micros: number;
  holder_pool_usd_micros: number;
  treasury_usd_micros: number;
  eligible_holders: number;
  fee_tx_id: string | null;
  status: string;
  created_at: number;
}

/** Start of the most recently *completed* epoch window. */
export function previousEpochStart(config: Pick<TokenomicsConfig, 'epochSeconds'>, now = nowSec()): number {
  const E = config.epochSeconds;
  return Math.floor(now / E) * E - E;
}

export function getEpoch(db: Db, epochStart: number): EpochRow | null {
  return (db.prepare(`SELECT * FROM epochs WHERE epoch_start = ?`).get(epochStart) as EpochRow | undefined) ?? null;
}

/**
 * Run one distribution epoch. Idempotent per epoch_start: a second call for the
 * same window returns the stored result without touching the adapter or ledger.
 */
export async function runEpoch(
  deps: { db: Db; adapter: ChainAdapter; config: TokenomicsConfig },
  epochStart: number = previousEpochStart(deps.config),
): Promise<EpochResult> {
  const { db, adapter, config } = deps;
  const epochEnd = epochStart + config.epochSeconds;

  const existing = getEpoch(db, epochStart);
  if (existing) {
    return {
      epochStart,
      epochEnd,
      status: 'skipped',
      feesUsdMicros: existing.fees_usd_micros,
      holderPoolUsdMicros: existing.holder_pool_usd_micros,
      treasuryUsdMicros: existing.treasury_usd_micros,
      eligibleHolders: existing.eligible_holders,
      feeTxId: existing.fee_tx_id,
      holdingAgeApplied: false,
      distributed: [],
    };
  }
  const ageCfg = config.distribution.holdingAge;

  // 1. sweep fees
  const fees = await adapter.collectFees();
  const feesUsdMicros = usdToMicros(fees.amountUsd);

  // 2. split holder / treasury, apply credit conversion rate
  const holderPoolRaw = bpsOf(feesUsdMicros, config.holderShareBps);
  const treasuryUsdMicros = feesUsdMicros - holderPoolRaw;
  const holderPoolUsdMicros = Math.floor(holderPoolRaw * config.creditUsdPerFeeUsd);

  // 3. eligible holders (time-weighted over the window, >= minHoldTokens)
  const balances = await adapter.getHolderBalances({ from: epochStart, to: epochEnd });
  const eligible = balances
    .filter((b) => b.timeWeightedBalance >= config.minHoldTokens && b.timeWeightedBalance > 0)
    .sort((a, b) => a.wallet.localeCompare(b.wallet));

  // 3b. holding age: adapter-reported hold-since, else the gateway's first-seen cache
  const holdSince = resolveHoldSince(db, balances, config.minHoldTokens, epochEnd);
  const multipliers = eligible.map((b) => holdingAgeMultiplier(ageCfg, holdSince.get(b.wallet), epochEnd));

  // 4. pro-rata on weight = balance × multiplier (integer micros; remainder assigned deterministically)
  const shares = splitProRata(
    holderPoolUsdMicros,
    eligible.map((b, i) => b.timeWeightedBalance * multipliers[i]),
  );
  const distributed = eligible
    .map((b, i) => ({ wallet: b.wallet, usdMicros: shares[i], multiplier: multipliers[i] }))
    .filter((d) => d.usdMicros > 0);

  const status: 'complete' | 'empty' = feesUsdMicros > 0 && distributed.length > 0 ? 'complete' : 'empty';
  const ref = `epoch:${epochStart}`;

  // 5. write ledger + epoch row atomically; re-check inside the transaction
  const write = db.transaction(() => {
    if (getEpoch(db, epochStart)) return false;
    const ins = db.prepare(
      `INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES (?, ?, 'distribution', ?, ?)`,
    );
    const ts = nowSec();
    for (const d of distributed) {
      ensureWallet(db, d.wallet, adapter.chain);
      ins.run(d.wallet, d.usdMicros, ref, ts);
    }
    if (treasuryUsdMicros > 0) addTreasuryEntry(db, { kind: 'fee_share', usdMicros: treasuryUsdMicros, ref }, ts);
    db.prepare(
      `INSERT INTO epochs (epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros,
                           eligible_holders, fee_tx_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      epochStart,
      epochEnd,
      feesUsdMicros,
      holderPoolUsdMicros,
      treasuryUsdMicros,
      eligible.length,
      fees.txId ?? null,
      status,
      ts,
    );
    return true;
  });
  const wrote = write();
  // Pre-launch points for the credits just distributed (idempotent; see points.ts).
  if (wrote && config.points.enabled) syncPoints(db, config.points); // points programme: built, disabled by default

  return {
    epochStart,
    epochEnd,
    status: wrote ? status : 'skipped',
    feesUsdMicros,
    holderPoolUsdMicros,
    treasuryUsdMicros,
    eligibleHolders: eligible.length,
    feeTxId: fees.txId ?? null,
    holdingAgeApplied: ageCfg.enabled,
    distributed: wrote ? distributed : [],
  };
}
