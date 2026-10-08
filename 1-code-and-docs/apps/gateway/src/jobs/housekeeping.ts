import type { SweepDetail } from '@mesh/chain-adapter';
import type { AppContext } from '../context.js';
import { recordError } from '../db.js';
import { expireAll } from '../expiry.js';
import { payNodeRewards } from '../node-payouts.js';
import { snapshotReserve } from '../reserve-report.js';
import { walletHold } from '../reserve.js';

export interface HousekeepingResult {
  expiredWallets: number;
  expiredUsdMicros: number;
  reserveSource: string;
  reserveHeldUsdMicros: number | null;
  /** What the epoch's sweep left behind, as logged (`SweepDetail.unswept`: no fresh price, or an asset whose sweep failed). */
  sweepWarnings: string[];
  /** Node rewards paid as credits in this run (node-payouts.ts). */
  nodePayoutWallets: number;
  nodePayoutUsdMicros: number;
}

/** Sweeps whose warnings have already been logged: a replayed epoch does not sweep again and must not log again. */
const reportedSweeps = new WeakSet<object>();

/**
 * A live adapter keeps the detail of its last sweep (`lastSweep`, chain-adapter types.ts `SweepDetail`).
 * When that sweep left fees behind (no fresh price, or the sweep of an asset failed) nothing else says so:
 * the epoch simply reads as smaller than it should be. Log each as `sweep_skipped`, which the
 * `failed_sweep` alert (alerts.ts) and the admin overview pick up.
 */
export function logSweepWarnings(ctx: Pick<AppContext, 'db' | 'adapter'>): string[] {
  const last = (ctx.adapter as { lastSweep?: Pick<SweepDetail, 'unswept'> }).lastSweep;
  if (!last || typeof last !== 'object' || reportedSweeps.has(last)) return [];
  reportedSweeps.add(last);
  const skipped = last.unswept ?? [];
  for (const message of skipped) recordError(ctx.db, { route: 'epoch sweep', status: 503, code: 'sweep_skipped', message });
  return skipped;
}

/**
 * Per-epoch chores that are not the distribution itself: log a sweep that left fees behind, pay node
 * rewards that have been held long enough as credits (node-payouts.ts), lapse credit that has outlived
 * `creditExpiry.days` (expiry.ts) and read the credit-pool wallet for the published reserve
 * (reserve-report.ts). Run after every epoch (index.ts cron, POST /admin/run-epoch); safe to run at any
 * time and as often as wanted.
 */
export async function runHousekeeping(ctx: Pick<AppContext, 'db' | 'adapter' | 'config' | 'reservations'>): Promise<HousekeepingResult> {
  const sweepWarnings = logSweepWarnings(ctx);
  const paid = payNodeRewards(ctx.db, ctx.config.nodeRewards.payout, { chain: ctx.adapter.chain });
  const expired = expireAll(ctx.db, ctx.config.creditExpiry, { heldMicros: (wallet) => ctx.reservations.reserved(walletHold(wallet)) });
  const snap = await snapshotReserve(ctx);
  return { expiredWallets: expired.wallets, expiredUsdMicros: expired.expiredMicros, reserveSource: snap.source, reserveHeldUsdMicros: snap.held_usd_micros, sweepWarnings, nodePayoutWallets: paid.wallets, nodePayoutUsdMicros: paid.paidMicros };
}
