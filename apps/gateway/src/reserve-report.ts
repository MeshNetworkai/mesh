// The published credit reserve (docs/PRICING.md §5, config `reserve`).
//
// The holder share of every sweep is settled in a stablecoin and sent to the credit-pool wallet, which is
// separate from the treasury. That wallet is what stands behind the credits wallets hold. Once per epoch
// the gateway reads its balance (`ChainAdapterReserve.reserve()`) into `reserve_snapshots`; GET /report
// puts the latest reading next to the credits outstanding so anyone can check the coverage.
//
// Named reserve-report to keep it apart from reserve.ts, which holds credit for requests in flight.
import { hasReserve } from '@mesh/chain-adapter';
import type { AppContext } from './context.js';
import type { Db } from './db.js';
import { nowSec, recordError } from './db.js';
import { microsToUsd, usdToMicros } from './money.js';

/** `chain`: read from the credit-pool wallet. `mock`: no token yet, fees are a test feed and nothing is held. `unavailable`: the read failed. */
export type ReserveSource = 'chain' | 'mock' | 'unavailable';

export interface ReserveSnapshotRow {
  id: number;
  source: ReserveSource;
  asset: string | null;
  held_usd_micros: number | null;
  stable_usd_micros: number | null;
  other_usd_micros: number | null;
  note: string | null;
  created_at: number;
}

export function latestReserveSnapshot(db: Db): ReserveSnapshotRow | null {
  return (db.prepare(`SELECT * FROM reserve_snapshots ORDER BY id DESC LIMIT 1`).get() as ReserveSnapshotRow | undefined) ?? null;
}

function insertSnapshot(db: Db, s: Omit<ReserveSnapshotRow, 'id' | 'created_at'>, now: number): ReserveSnapshotRow {
  const res = db
    .prepare(`INSERT INTO reserve_snapshots (source, asset, held_usd_micros, stable_usd_micros, other_usd_micros, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(s.source, s.asset, s.held_usd_micros, s.stable_usd_micros, s.other_usd_micros, s.note, now);
  return { ...s, id: Number(res.lastInsertRowid), created_at: now };
}

/**
 * Read the credit-pool wallet and store what it holds. Only the stablecoin counts as held reserve; ETH
 * found next to it (a raw sweep, gas money) is recorded separately and is not counted towards coverage,
 * because its dollar value moves. Never throws: a failed read is stored as `unavailable`.
 */
export async function snapshotReserve(ctx: Pick<AppContext, 'db' | 'adapter'>, now = nowSec()): Promise<ReserveSnapshotRow> {
  const { db, adapter } = ctx;
  if (!hasReserve(adapter)) {
    // Before the token launch there is nothing to read. One row is enough: do not add one per epoch.
    const last = latestReserveSnapshot(db);
    if (last?.source === 'mock') return last;
    return insertSnapshot(db, { source: 'mock', asset: null, held_usd_micros: null, stable_usd_micros: null, other_usd_micros: null, note: 'no token yet: fees are a test feed and no reserve is held' }, now);
  }
  try {
    const r = await adapter.reserve();
    const stable = usdToMicros(r.stableUsd);
    const other = r.otherUsd === null ? null : usdToMicros(r.otherUsd);
    const note = r.stable === null ? 'no settlement stablecoin configured' : r.otherUnits > 0 ? `${r.otherUnits} ETH also in the pool wallet, not counted` : null;
    return insertSnapshot(db, { source: 'chain', asset: r.stable, held_usd_micros: stable, stable_usd_micros: stable, other_usd_micros: other, note }, now);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    recordError(db, { route: 'reserve snapshot', status: 500, code: 'reserve_read_failed', message });
    return insertSnapshot(db, { source: 'unavailable', asset: null, held_usd_micros: null, stable_usd_micros: null, other_usd_micros: null, note: message.slice(0, 200) }, now);
  }
}

/**
 * Credit wallets can spend now, plus credit escrowed in open marketplace listings (it is owed to a buyer or
 * back to the seller). A wallet that is overdrawn (a request that cost more than was left, a reward clawed
 * back after it was spent) owes Mesh, not the other way round: it counts as zero, not against the rest.
 */
export function creditsOwedMicros(db: Db): { spendable: number; escrowed: number } {
  const spendable = (db.prepare(`SELECT COALESCE(SUM(b), 0) AS v FROM (SELECT SUM(delta_usd_micros) AS b FROM credits_ledger GROUP BY wallet) WHERE b > 0`).get() as { v: number }).v;
  const escrowed = (db.prepare(`SELECT COALESCE(SUM(remaining_micros), 0) AS v FROM market_listings WHERE status = 'open'`).get() as { v: number }).v;
  return { spendable, escrowed };
}

/**
 * GET /report `totals.reserve`: what the credit pool held at the last reading against what is owed in
 * credits. `coverage` is held ÷ owed (null when nothing is owed or nothing could be read); `short` is true
 * when it is below `reserve.minCoverageBps`.
 */
export function reserveView(ctx: { db: Db; config: Pick<AppContext['config'], 'reserve'> }) {
  const snap = latestReserveSnapshot(ctx.db);
  const owed = creditsOwedMicros(ctx.db);
  const required = owed.spendable + owed.escrowed;
  const held = snap?.held_usd_micros ?? null;
  const coverage = held === null || required <= 0 ? null : Math.round((held / required) * 10_000) / 10_000;
  const minCoverageBps = ctx.config.reserve.minCoverageBps;
  return {
    source: (snap?.source ?? 'mock') as ReserveSource,
    asset: snap?.asset ?? null,
    heldUsd: held === null ? null : microsToUsd(held),
    /** ETH (or anything else) sitting in the pool wallet, valued at the reading; not counted in heldUsd. */
    otherUsd: snap?.other_usd_micros === null || snap?.other_usd_micros === undefined ? null : microsToUsd(snap.other_usd_micros),
    creditsSpendableUsd: microsToUsd(owed.spendable),
    creditsInEscrowUsd: microsToUsd(owed.escrowed),
    requiredUsd: microsToUsd(required),
    coverage,
    surplusUsd: held === null ? null : microsToUsd(held - required),
    short: coverage === null ? null : coverage * 10_000 < minCoverageBps,
    minCoverageBps,
    note: snap?.note ?? null,
    asOf: snap?.created_at ?? null,
  };
}
