import { MockAdapter } from '@mesh/chain-adapter';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { betaView } from '../beta.js';
import type { AppContext } from '../context.js';
import { dbOk, nowSec } from '../db.js';
import { microsToUsd } from '../money.js';
import { jobStats24h } from '../network.js';
import { NODE_ONLINE_SEC } from '../routing.js';
import { networkSavingsUsd24h } from '../savings.js';

export interface HourPoint {
  /** unix seconds, start of hour */
  hour: number;
  feesUsd: number;
  creditsDistributedUsd: number;
  requests: number;
  spendUsd: number;
}

/** 24 hourly buckets ending at the current hour (oldest first). */
export function hourlySeries(ctx: AppContext, now = nowSec()): HourPoint[] {
  const db = ctx.db;
  const end = Math.floor(now / 3600) * 3600;
  const start = end - 23 * 3600;
  const buckets = new Map<number, HourPoint>();
  for (let h = start; h <= end; h += 3600) buckets.set(h, { hour: h, feesUsd: 0, creditsDistributedUsd: 0, requests: 0, spendUsd: 0 });

  const fees = db
    .prepare(`SELECT (created_at / 3600) * 3600 AS h, SUM(fees_usd_micros) AS v FROM epochs WHERE created_at >= ? GROUP BY h`)
    .all(start) as Array<{ h: number; v: number }>;
  for (const r of fees) if (buckets.has(r.h)) buckets.get(r.h)!.feesUsd = microsToUsd(r.v);

  const dist = db
    .prepare(
      `SELECT (created_at / 3600) * 3600 AS h, SUM(delta_usd_micros) AS v
       FROM credits_ledger WHERE kind = 'distribution' AND created_at >= ? GROUP BY h`,
    )
    .all(start) as Array<{ h: number; v: number }>;
  for (const r of dist) if (buckets.has(r.h)) buckets.get(r.h)!.creditsDistributedUsd = microsToUsd(r.v);

  const reqs = db
    .prepare(
      `SELECT (created_at / 3600) * 3600 AS h, COUNT(*) AS n, SUM(cost_usd_micros) AS cost
       FROM requests_log WHERE created_at >= ? GROUP BY h`,
    )
    .all(start) as Array<{ h: number; n: number; cost: number }>;
  for (const r of reqs) {
    const b = buckets.get(r.h);
    if (b) {
      b.requests = r.n;
      b.spendUsd = microsToUsd(r.cost);
    }
  }
  return [...buckets.values()];
}

export interface EpochRow {
  epoch_start: number;
  epoch_end: number;
  fees_usd_micros: number;
  holder_pool_usd_micros: number;
  treasury_usd_micros: number;
  eligible_holders: number;
  status: string;
  created_at: number;
}

/** Public view of one epoch (no fee tx id). */
export function publicEpochView(e: EpochRow) {
  return {
    epochStart: e.epoch_start,
    epochEnd: e.epoch_end,
    feesUsd: microsToUsd(e.fees_usd_micros),
    holderPoolUsd: microsToUsd(e.holder_pool_usd_micros),
    treasuryUsd: microsToUsd(e.treasury_usd_micros),
    eligibleHolders: e.eligible_holders,
    status: e.status,
    createdAt: e.created_at,
  };
}

export function recentEpochs(ctx: AppContext, limit: number) {
  return (
    ctx.db
      .prepare(
        `SELECT epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, status, created_at
         FROM epochs ORDER BY epoch_start DESC LIMIT ?`,
      )
      .all(limit) as EpochRow[]
  ).map(publicEpochView);
}

/**
 * Fees accrued since the last epoch, when the adapter can tell us cheaply (MockAdapter keeps
 * them in memory). Real chain adapters would need an RPC call, so they report null and the
 * UI falls back to "last epoch".
 */
export function feesThisEpochUsd(ctx: AppContext): number | null {
  return ctx.adapter instanceof MockAdapter ? Math.round(ctx.adapter.pendingFees() * 1e6) / 1e6 : null;
}

export function computeStats(ctx: AppContext) {
  const db = ctx.db;
  const now = nowSec();
  const fees = db.prepare(`SELECT COALESCE(SUM(fees_usd_micros),0) AS v FROM epochs`).get() as { v: number };
  const dist = db
    .prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind='distribution'`)
    .get() as { v: number };
  const used = db
    .prepare(`SELECT COALESCE(-SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind='usage'`)
    .get() as { v: number };
  const last = db
    .prepare(`SELECT epoch_start, epoch_end, eligible_holders, fees_usd_micros, status FROM epochs ORDER BY epoch_start DESC LIMIT 1`)
    .get() as { epoch_start: number; epoch_end: number; eligible_holders: number; fees_usd_micros: number; status: string } | undefined;
  const req24 = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd_micros),0) AS cost FROM requests_log WHERE created_at >= ?`)
    .get(now - 86_400) as { n: number; cost: number };
  const epochs = db.prepare(`SELECT COUNT(*) AS n FROM epochs`).get() as { n: number };
  const nodes = db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE last_seen >= ?`).get(now - NODE_ONLINE_SEC) as { n: number };
  const servedByNode = db
    .prepare(`SELECT COUNT(*) AS n FROM requests_log WHERE upstream LIKE 'node:%' AND created_at >= ?`)
    .get(now - 86_400) as { n: number };
  const jobs = jobStats24h(db, undefined, now);

  return {
    token: {
      name: ctx.config.name,
      ticker: ctx.config.ticker,
      chain: ctx.config.chain,
      tradeFeeBps: ctx.config.tradeFeeBps,
      holderShareBps: ctx.config.holderShareBps,
      treasuryShareBps: ctx.config.treasuryShareBps,
      minHoldTokens: ctx.config.minHoldTokens,
      epochSeconds: ctx.config.epochSeconds,
      ...ctx.config.meta,
    },
    totalFeesUsd: microsToUsd(fees.v),
    creditsDistributedUsd: microsToUsd(dist.v),
    creditsUsedUsd: microsToUsd(used.v),
    epochsRun: epochs.n,
    lastEpoch: last
      ? {
          epochStart: last.epoch_start,
          epochEnd: last.epoch_end,
          eligibleHolders: last.eligible_holders,
          feesUsd: microsToUsd(last.fees_usd_micros),
          status: last.status,
        }
      : null,
    holdersEligibleLastEpoch: last?.eligible_holders ?? 0,
    feesThisEpochUsd: feesThisEpochUsd(ctx),
    requestsLast24h: req24.n,
    spendLast24hUsd: microsToUsd(req24.cost),
    nodesOnline: nodes.n,
    servedByNetworkPercent: req24.n === 0 ? 0 : Math.round((servedByNode.n / req24.n) * 10_000) / 100,
    servedByNetwork24h: servedByNode.n,
    jobs24h: jobs.jobs,
    networkTokens24h: jobs.tokens,
    networkPricePerMTokens: ctx.config.requestPricing.networkPricePerMTokens,
    /** Network credits: USD saved across all wallets in the last 24h by Mesh nodes serving requests at the network price. */
    networkSavingsUsd24h: networkSavingsUsd24h(db, now),
    showSavings: ctx.config.requestPricing.showSavings,
    /** Points/leaderboard/referral programme: built but disabled by default; the web app hides every points surface when false. */
    pointsEnabled: ctx.config.points.enabled,
    /** Public beta gating: the web app shows the pill and swaps the CTA for the waitlist when `inviteRequired`. */
    beta: betaView(ctx.config.beta),
    /** Spot-check verification is on: a sampled fraction of node work is re-checked (docs/NODE_PROTOCOL.md §10). */
    verificationEnabled: ctx.config.verification.enabled,
    nodeRewardUsdPerMTokens: ctx.config.nodeRewards.usdPerMTokens,
    series24h: hourlySeries(ctx, now),
    epochSeconds: ctx.config.epochSeconds,
    upstream: ctx.upstream.name,
    generatedAt: now,
  };
}

export async function statsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/health', async (_req, reply) => {
    const ok = dbOk(ctx.db);
    const last = ok
      ? (ctx.db.prepare(`SELECT epoch_start, status, created_at FROM epochs ORDER BY epoch_start DESC LIMIT 1`).get() as
          | { epoch_start: number; status: string; created_at: number }
          | undefined)
      : undefined;
    const now = nowSec();
    const body = {
      ok,
      db: ok ? 'ok' : 'error',
      adapter: ctx.env.MESH_ADAPTER,
      chain: ctx.adapter.chain,
      upstream: ctx.upstream.name,
      upstreamMode: ctx.upstream.name === 'mock' ? 'mock (offline)' : 'live',
      epochCron: ctx.env.EPOCH_CRON,
      lastEpoch: last ? { epochStart: last.epoch_start, status: last.status, ageSec: now - last.created_at } : null,
      geoBlock: ctx.env.GEO_BLOCK_ENFORCE ? ctx.config.geoBlock : 'off',
      time: now,
    };
    return reply.code(ok ? 200 : 503).send(body);
  });

  const EpochsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(48) });
  /** Public epoch history, newest first. */
  app.get('/epochs', async (req, reply) => {
    const parsed = EpochsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const epochs = recentEpochs(ctx, parsed.data.limit);
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM epochs`).get() as { n: number }).n;
    return { epochs, total, limit: parsed.data.limit, epochSeconds: ctx.config.epochSeconds, generatedAt: nowSec() };
  });

  let cache: { at: number; body: ReturnType<typeof computeStats> } | null = null;
  app.get('/stats', async (_req, reply) => {
    const ttl = ctx.env.STATS_CACHE_MS;
    const t = Date.now();
    if (!cache || ttl === 0 || t - cache.at >= ttl) cache = { at: t, body: computeStats(ctx) };
    reply.header('cache-control', `public, max-age=${Math.floor(ttl / 1000)}`);
    reply.header('x-cache-age-ms', String(t - cache.at));
    return cache.body;
  });
}
