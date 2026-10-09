import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { directSalesTotals } from '../direct-sales.js';
import { expiredTotals } from '../expiry.js';
import { treasuryBalanceMicros, treasuryTotalsByKind } from '../ledger.js';
import { marketTotals } from '../market.js';
import { microsToUsd } from '../money.js';
import { nodePayoutTotals } from '../node-payouts.js';
import { reserveView } from '../reserve-report.js';
import { sampleActivity, sampleConfigured, sampleInfo, sampleUsageShare, sampleViewFor } from '../sample-data.js';
import { usageShareTotals, type UsageShareTotals } from '../usage-share.js';
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
    db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM node_rewards WHERE kind='node_reward' AND status='accrued' AND created_at >= ? AND created_at < ?`).get(from, to) as { v: number }
  ).v;
  const rq = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN upstream LIKE 'node:%' THEN 1 ELSE 0 END) AS node
       FROM requests_log WHERE created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { n: number; node: number | null };
  s.req = rq.n;
  s.node = rq.node ?? 0;
  // Test mode (MESH_SAMPLE_NODES, sample-data.ts): what the simulated Macs did in this period. Zero when off.
  const sim = sampleActivity(ctx, from, to);
  s.req += sim.requests;
  s.node += sim.networkRequests;
  s.used += sim.spendMicros;
  s.rewards += sim.rewardMicros;
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
  marketplace:
    'Credit marketplace (docs/MARKETPLACE.md): listed = face value of every listing ever created; filled = face value that changed hands; buyers paid the discounted price from a prepaid balance. Mesh keeps 2.5% of the price: feesToHolders joins the next hourly holder pool, feesToTreasury is a market_fee treasury row. openDepth = credit on the book right now.',
  usageShare:
    'Usage-revenue share (docs/PRICING.md): when enabled, holderBps of the margin on every paid request (network: user price − node reward; upstream: billed − upstream cost, the cost being list plus the upstream\'s own fee) joins the next hourly holder pool; the rest stays with the treasury. Negative margins and guest messages contribute nothing. bySource.marketplaceFee is the marketplace fee share already paid to the pool, counted here when usageShare.sources.marketplaceFee is on.',
  reserve:
    'Credit reserve (docs/PRICING.md): the holder share of every sweep is swapped to the stablecoin on chain and held in the credit-pool wallet, apart from the treasury. heldUsd is that wallet\'s stablecoin balance at the last hourly reading (asOf); requiredUsd is every credit a wallet could spend plus credit escrowed in open listings; coverage = heldUsd ÷ requiredUsd. Anything else in the wallet (ETH) is shown as otherUsd and not counted. source "mock" means the token is not live: fees are a test feed and no reserve is held.',
  creditExpiry:
    'Credit expiry (docs/PRICING.md): every credit lapses creditExpiry.days after it landed, oldest first; expiredUsd is the total debited so far (expiry ledger rows). Lapsed credit lowers requiredUsd, so the reserve that backed it shows up as surplus.',
  directSales:
    'Direct sales (docs/PRICING.md): credits bought from Mesh at face value with a prepaid balance (purchase ledger rows). The payment backs the credit 1:1; it is not treasury income until the credit is spent and leaves a margin.',
  nodePayouts:
    'Node payouts (docs/NODE_PROTOCOL.md): node rewards are paid as AI credits, off chain. paidUsd is the total added to operators\' credit balances (node_payout ledger rows); pendingUsd is earned and not paid yet (inside the hold, below the minimum, or a quarantined node). Paid rewards are credits like any other: they count in credits owed, can be spent or listed on the marketplace, and expire.',
  guestChat:
    'Free guest messages (POST /v1/guest/chat) are paid by the treasury: upstreamCostUsd is what the upstream charged for guest messages it served (guest_chat treasury rows); nodeRewardsUsd is what Mesh nodes earned serving guest messages (already inside node rewards accrued). Requests are counted in requests_log under the guest wallet.',
};

/** Credit marketplace totals (market.ts): what was listed, what changed hands and where the fee went. */
export function marketplaceTotals(ctx: AppContext) {
  const t = marketTotals(ctx.db);
  return {
    listed: microsToUsd(t.listedMicros),
    filled: microsToUsd(t.filledMicros),
    paid: microsToUsd(t.paidMicros),
    fills: t.fills,
    feesToHolders: microsToUsd(t.feesToHoldersMicros),
    feesToTreasury: microsToUsd(t.feesToTreasuryMicros),
    openDepth: microsToUsd(t.openDepthMicros),
    openListings: t.openListings,
    bestDiscountBps: t.bestDiscountBps,
    avgDiscountBps: t.avgDiscountBps,
  };
}

/** Usage-revenue share totals (usage-share.ts): margins on paid requests and how they were split. */
export function usageShareReport(ctx: AppContext) {
  const cfg = ctx.config.usageShare;
  const all = usageShareTotals(ctx.db);
  const network = usageShareTotals(ctx.db, { source: 'network' });
  const upstream = usageShareTotals(ctx.db, { source: 'upstream' });
  const marketFee = cfg.sources.marketplaceFee ? microsToUsd(marketTotals(ctx.db).feesToHoldersMicros) : 0;
  // Test mode (MESH_SAMPLE_NODES, sample-data.ts): the share the simulated requests would have produced. Zero when off.
  const sim = sampleUsageShare(ctx, 0, nowSec());
  const plus = (real: UsageShareTotals, s: (typeof sim)['network']) => ({
    marginUsd: real.marginUsd + microsToUsd(s.marginMicros),
    toHoldersUsd: real.toHoldersUsd + microsToUsd(s.holderMicros),
    toTreasuryUsd: real.toTreasuryUsd + microsToUsd(s.treasuryMicros),
    requests: real.requests + s.requests,
  });
  const net = plus(network, sim.network);
  const up = plus(upstream, sim.upstream);
  return {
    enabled: cfg.enabled,
    holderBps: cfg.holderBps,
    treasuryBps: cfg.treasuryBps,
    marginUsd: all.marginUsd + microsToUsd(sim.network.marginMicros + sim.upstream.marginMicros),
    toHoldersUsd: all.toHoldersUsd + microsToUsd(sim.network.holderMicros + sim.upstream.holderMicros),
    toTreasuryUsd: all.toTreasuryUsd + microsToUsd(sim.network.treasuryMicros + sim.upstream.treasuryMicros),
    requests: all.requests + sim.network.requests + sim.upstream.requests,
    bySource: {
      network: net,
      upstream: up,
      /** Always paid to the pool by the marketplace (feeToHoldersBps); counted here when sources.marketplaceFee is on. */
      marketplaceFee: { toHoldersUsd: marketFee, counted: cfg.sources.marketplaceFee },
    },
  };
}

/** What free guest chat has cost so far (routes/guest.ts). */
export function guestChatTotals(ctx: AppContext) {
  const db = ctx.db;
  const rq = db
    .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN upstream LIKE 'node:%' THEN 1 ELSE 0 END) AS node, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens FROM requests_log WHERE wallet = 'guest'`)
    .get() as { n: number; node: number | null; tokens: number };
  const upstreamCost = (db.prepare(`SELECT COALESCE(SUM(-usd_micros),0) AS v FROM treasury_ledger WHERE kind = 'guest_chat'`).get() as { v: number }).v;
  const rewards = (
    db
      .prepare(`SELECT COALESCE(SUM(r.usd_micros),0) AS v FROM node_rewards r JOIN jobs j ON j.job_id = r.job_id WHERE j.wallet = 'guest' AND r.kind = 'node_reward' AND r.status = 'accrued'`)
      .get() as { v: number }
  ).v;
  return {
    requests: rq.n,
    servedByNetwork: rq.node ?? 0,
    tokens: rq.tokens,
    upstreamCostUsd: microsToUsd(upstreamCost),
    nodeRewardsUsd: microsToUsd(rewards),
    totalCostUsd: microsToUsd(upstreamCost + rewards),
  };
}

/** Credit that has lapsed (expiry.ts): the policy and what it has removed so far. */
export function creditExpiryReport(ctx: AppContext, now = nowSec()) {
  const cfg = ctx.config.creditExpiry;
  const all = expiredTotals(ctx.db);
  const last30 = expiredTotals(ctx.db, now - 30 * DAY);
  return { enabled: cfg.enabled, days: cfg.days, expiredUsd: microsToUsd(all.expiredMicros), wallets: all.wallets, last30dUsd: microsToUsd(last30.expiredMicros) };
}

/** Node rewards paid as credits (node-payouts.ts). */
export function nodePayoutsReport(ctx: AppContext, now = nowSec()) {
  const cfg = ctx.config.nodeRewards.payout;
  const all = nodePayoutTotals(ctx.db);
  const last30 = nodePayoutTotals(ctx.db, now - 30 * DAY);
  // Test mode (MESH_SAMPLE_NODES, sample-data.ts): simulated rewards count as paid once they are older than
  // the hold, like real ones, so the figure sits right next to the simulated rewards. Nothing was paid to anyone.
  const simPaid = cfg.enabled ? sampleActivity(ctx, 0, now - cfg.holdSeconds, now).rewardMicros : 0;
  const simPending = sampleActivity(ctx, 0, now, now).rewardMicros - simPaid;
  all.paidMicros += simPaid;
  all.pendingMicros += simPending;
  last30.paidMicros += cfg.enabled ? sampleActivity(ctx, now - 30 * DAY, now - cfg.holdSeconds, now).rewardMicros : 0;
  return { enabled: cfg.enabled, paidAs: 'credits' as const, holdSeconds: cfg.holdSeconds, minUsd: cfg.minUsd, paidUsd: microsToUsd(all.paidMicros), wallets: all.wallets, pendingUsd: microsToUsd(all.pendingMicros), last30dUsd: microsToUsd(last30.paidMicros) };
}

/** Credits sold by Mesh at face value (direct-sales.ts). */
export function directSalesReport(ctx: AppContext, now = nowSec()) {
  const cfg = ctx.config.directSales;
  const all = directSalesTotals(ctx.db);
  const last30 = directSalesTotals(ctx.db, now - 30 * DAY);
  return { enabled: cfg.enabled, soldUsd: microsToUsd(all.soldMicros), purchases: all.purchases, wallets: all.wallets, last30dUsd: microsToUsd(last30.soldMicros) };
}

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
        guestChatUsd: microsToUsd(treasury.guest_chat),
        marketFeeUsd: microsToUsd(treasury.market_fee),
        balanceUsd: microsToUsd(treasuryBalanceMicros(db)),
      },
      guestChat: guestChatTotals(ctx),
      marketplace: marketplaceTotals(ctx),
      usageShare: usageShareReport(ctx),
      reserve: reserveView(ctx),
      creditExpiry: creditExpiryReport(ctx, now),
      directSales: directSalesReport(ctx, now),
      nodePayouts: nodePayoutsReport(ctx, now),
    },
    last7d,
    last30d,
    byWeek: byWeek(ctx, REPORT_WEEKS, now),
    /** Set while requests, usage and node rewards include simulated Macs (test mode, operator view); null otherwise. */
    sample: sampleInfo(ctx),
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
  app.get('/report', async (req, reply) => {
    // Test mode: a signed-in operator gets the view with the simulated Macs, uncached and never shared.
    const view = await sampleViewFor(ctx, req);
    if (view !== ctx) return reply.header('cache-control', 'private, no-store').send(computeReport(view));
    if (sampleConfigured(ctx) > 0) reply.header('vary', 'cookie');
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
    const view = await sampleViewFor(ctx, req);
    if (view !== ctx) reply.header('cache-control', 'private, no-store');
    const days = [];
    for (let d = w.start; d < w.end; d += DAY) {
      days.push({ day: new Date(d * 1000).toISOString().slice(0, 10), start: d, end: d + DAY, ...periodTotals(view, d, d + DAY) });
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
      ...weekReport(view, w, now),
      days,
      epochDetails,
      previous: prev.isoWeek,
      next: next.start <= now ? next.isoWeek : null,
      sample: sampleInfo(view),
      method: REPORT_METHOD,
      generatedAt: now,
    };
  });
}
