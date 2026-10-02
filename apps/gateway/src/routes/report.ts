import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { treasuryBalanceMicros, treasuryTotalsByKind } from '../ledger.js';
import { microsToUsd } from '../money.js';
import { publicEpochView, type EpochRow } from './stats.js';

/**
 * Public treasury report. Everything here is derived from the ledgers (`epochs`, `credits_ledger`,
 * `requests_log`, `node_rewards`, `treasury_ledger`), so it is reproducible from the database.
 * Fees and treasury share are attributed to the ISO week of the epoch window they were earned in
 * (epoch_start); credits out follow their epoch via `ref = epoch:<start>`; usage, starter credits
 * and node rewards follow the time they happened.
 */

const DAY = 86_400;
const WEEK = 7 * DAY;
export const REPORT_WEEKS = 12;

export interface IsoWeek {
  /** `YYYY-Www`, ISO 8601 (Monday-based, UTC). */
  isoWeek: string;
  /** unix seconds, Monday 00:00 UTC */
  start: number;
  /** unix seconds, next Monday 00:00 UTC (exclusive) */
  end: number;
}

/** Monday 00:00 UTC of the ISO week containing `sec`. */
export function weekStartOf(sec: number): number {
  const d = new Date(sec * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - dow * DAY;
}

export function isoWeekOf(sec: number): IsoWeek {
  const start = weekStartOf(sec);
  const thursday = new Date((start + 3 * DAY) * 1000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1) / 1000;
  const week = Math.floor((start + 3 * DAY - jan1) / WEEK) + 1;
  return { isoWeek: `${year}-W${String(week).padStart(2, '0')}`, start, end: start + WEEK };
}

/** Parse `YYYY-Www` → week bounds, or null when malformed / out of range. */
export function parseIsoWeek(s: string): IsoWeek | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // ISO week 1 is the week containing Jan 4.
  const jan4 = Date.UTC(year, 0, 4) / 1000;
  const start = weekStartOf(jan4) + (week - 1) * WEEK;
  const resolved = isoWeekOf(start);
  if (resolved.isoWeek !== s) return null; // e.g. W53 in a 52-week year
  return resolved;
}

export interface PeriodTotals {
  feesInUsd: number;
  /** Credits minted to holders (distribution rows). */
  creditsOutUsd: number;
  starterCreditsUsd: number;
  creditsUsedUsd: number;
  nodeRewardsUsd: number;
  /** Treasury share of fees (fee_share rows). */
  treasuryInUsd: number;
  requests: number;
  servedByNetwork: number;
  servedByOpenRouter: number;
  servedByNetworkPercent: number;
  epochs: number;
  completeEpochs: number;
}

type Sums = { fees: number; dist: number; starter: number; used: number; rewards: number; treasury: number; req: number; node: number; epochs: number; complete: number };
const zero = (): Sums => ({ fees: 0, dist: 0, starter: 0, used: 0, rewards: 0, treasury: 0, req: 0, node: 0, epochs: 0, complete: 0 });

function toTotals(s: Sums): PeriodTotals {
  const openrouter = s.req - s.node;
  return {
    feesInUsd: microsToUsd(s.fees),
    creditsOutUsd: microsToUsd(s.dist),
    starterCreditsUsd: microsToUsd(s.starter),
    creditsUsedUsd: microsToUsd(s.used),
    nodeRewardsUsd: microsToUsd(s.rewards),
    treasuryInUsd: microsToUsd(s.treasury),
    requests: s.req,
    servedByNetwork: s.node,
    servedByOpenRouter: openrouter,
    servedByNetworkPercent: s.req === 0 ? 0 : Math.round((s.node / s.req) * 10_000) / 100,
    epochs: s.epochs,
    completeEpochs: s.complete,
  };
}

/** Totals for epochs whose window starts in [from, to) and ledger rows created in [from, to). */
export function periodTotals(ctx: AppContext, from: number, to: number): PeriodTotals {
  const db = ctx.db;
  const s = zero();
  const ep = db
    .prepare(
      `SELECT COALESCE(SUM(fees_usd_micros),0) AS fees, COALESCE(SUM(treasury_usd_micros),0) AS treasury,
              COUNT(*) AS n, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete
       FROM epochs WHERE epoch_start >= ? AND epoch_start < ?`,
    )
    .get(from, to) as { fees: number; treasury: number; n: number; complete: number | null };
  s.fees = ep.fees;
  s.treasury = ep.treasury;
  s.epochs = ep.n;
  s.complete = ep.complete ?? 0;
  // credits out follow the epoch they belong to (ref = epoch:<start>)
  s.dist = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.delta_usd_micros),0) AS v FROM credits_ledger l
         JOIN epochs e ON l.ref = 'epoch:' || e.epoch_start
         WHERE l.kind='distribution' AND e.epoch_start >= ? AND e.epoch_start < ?`,
      )
      .get(from, to) as { v: number }
  ).v;
  const led = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind='starter' THEN delta_usd_micros ELSE 0 END),0) AS starter,
              COALESCE(SUM(CASE WHEN kind='usage' THEN -delta_usd_micros ELSE 0 END),0) AS used
       FROM credits_ledger WHERE created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { starter: number; used: number };
  s.starter = led.starter;
  s.used = led.used;
  s.rewards = (
    db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM node_rewards WHERE kind='node_reward' AND created_at >= ? AND created_at < ?`).get(from, to) as { v: number }
  ).v;
  const rq = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN upstream LIKE 'node:%' THEN 1 ELSE 0 END) AS node
       FROM requests_log WHERE created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { n: number; node: number | null };
  s.req = rq.n;
  s.node = rq.node ?? 0;
  return toTotals(s);
}

export interface WeekReport extends IsoWeek, PeriodTotals {
  current: boolean;
}

export function weekReport(ctx: AppContext, w: IsoWeek, now = nowSec()): WeekReport {
  return { ...w, ...periodTotals(ctx, w.start, w.end), current: now >= w.start && now < w.end };
}

/** Last `weeks` ISO weeks including the current one, oldest first. */
export function byWeek(ctx: AppContext, weeks = REPORT_WEEKS, now = nowSec()): WeekReport[] {
  const thisWeek = weekStartOf(now);
  const out: WeekReport[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(weekReport(ctx, isoWeekOf(thisWeek - i * WEEK), now));
  return out;
}

export const REPORT_METHOD = {
  credits: 'Credits are a share of trading fees already collected, converted 1:1 to USD-denominated inference credits. They are not a yield, a promise, or a claim on future fees.',
  attribution:
    'Fees and the treasury share are booked to the ISO week (UTC) of the epoch window that earned them; credits out follow their epoch; usage, starter credits and node rewards follow the time they happened.',
  treasury:
    'treasuryBalanceUsd = treasury share received − node rewards accrued − buybacks − ops, from the treasury ledger. Node rewards accrue in USD when a Mesh node completes a job and are paid from the treasury share.',
  network: 'servedByNetworkPercent = requests served by a Mesh node ÷ all requests in the period (requests_log).',
};

export function computeReport(ctx: AppContext, now = nowSec()) {
  const db = ctx.db;
  const all = periodTotals(ctx, 0, Number.MAX_SAFE_INTEGER);
  const last7d = periodTotals(ctx, now - 7 * DAY, Number.MAX_SAFE_INTEGER);
  const last30d = periodTotals(ctx, now - 30 * DAY, Number.MAX_SAFE_INTEGER);
  const treasury = treasuryTotalsByKind(db);
  const outstanding = (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger`).get() as { v: number }).v;
  const holders = (db.prepare(`SELECT COUNT(*) AS v FROM (SELECT wallet FROM credits_ledger GROUP BY wallet HAVING SUM(delta_usd_micros) > 0)`).get() as { v: number }).v;
  const last = db.prepare(`SELECT MAX(created_at) AS v FROM epochs`).get() as { v: number | null };
  const lastLedger = db.prepare(`SELECT MAX(created_at) AS v FROM credits_ledger`).get() as { v: number | null };
  const lastTreasury = db.prepare(`SELECT MAX(created_at) AS v FROM treasury_ledger`).get() as { v: number | null };
  const lastUpdated = Math.max(last.v ?? 0, lastLedger.v ?? 0, lastTreasury.v ?? 0) || null;

  return {
    token: { name: ctx.config.name, ticker: ctx.config.ticker, chain: ctx.config.chain, holderShareBps: ctx.config.holderShareBps, treasuryShareBps: ctx.config.treasuryShareBps },
    totals: {
      ...all,
      creditsOutstandingUsd: microsToUsd(outstanding),
      walletsWithCredits: holders,
      treasury: {
        feeShareUsd: microsToUsd(treasury.fee_share),
        nodeRewardAccrualUsd: microsToUsd(treasury.node_reward_accrual),
        buybackUsd: microsToUsd(treasury.buyback),
        opsUsd: microsToUsd(treasury.ops),
        otherUsd: microsToUsd(treasury.other),
        balanceUsd: microsToUsd(treasuryBalanceMicros(db)),
      },
    },
    last7d,
    last30d,
    byWeek: byWeek(ctx, REPORT_WEEKS, now),
    feesIn: all.feesInUsd,
    creditsOut: all.creditsOutUsd,
    nodeRewards: all.nodeRewardsUsd,
    treasuryBalanceUsd: microsToUsd(treasuryBalanceMicros(db)),
    servedByNetworkPercent: all.servedByNetworkPercent,
    epochsRun: all.epochs,
    holdingAge: ctx.config.distribution.holdingAge,
    method: REPORT_METHOD,
    lastUpdated,
    generatedAt: now,
  };
}

export type Report = ReturnType<typeof computeReport>;

export async function reportRoutes(app: FastifyInstance, ctx: AppContext) {
  let cache: { at: number; body: Report } | null = null;
  app.get('/report', async (_req, reply) => {
    const ttl = ctx.env.STATS_CACHE_MS;
    const t = Date.now();
    if (!cache || ttl === 0 || t - cache.at >= ttl) cache = { at: t, body: computeReport(ctx) };
    reply.header('cache-control', `public, max-age=${Math.floor(ttl / 1000)}`);
    return cache.body;
  });

  /** One ISO week in detail: totals, daily buckets and the public view of each epoch in it (`epochDetails`). */
  app.get<{ Params: { isoWeek: string } }>('/report/weekly/:isoWeek', async (req, reply) => {
    const w = parseIsoWeek(req.params.isoWeek);
    if (!w) return reply.code(400).send({ error: 'bad_request', message: 'isoWeek must look like 2026-W40' });
    const now = nowSec();
    const days = [];
    for (let d = w.start; d < w.end; d += DAY) {
      days.push({ day: new Date(d * 1000).toISOString().slice(0, 10), start: d, end: d + DAY, ...periodTotals(ctx, d, d + DAY) });
    }
    const epochDetails = (
      ctx.db
        .prepare(
          `SELECT epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, status, created_at
           FROM epochs WHERE epoch_start >= ? AND epoch_start < ? ORDER BY epoch_start ASC`,
        )
        .all(w.start, w.end) as EpochRow[]
    ).map(publicEpochView);
    const prev = isoWeekOf(w.start - WEEK);
    const next = isoWeekOf(w.end);
    return {
      ...weekReport(ctx, w, now),
      days,
      epochDetails,
      previous: prev.isoWeek,
      next: next.start <= now ? next.isoWeek : null,
      method: REPORT_METHOD,
      generatedAt: now,
    };
  });
}
