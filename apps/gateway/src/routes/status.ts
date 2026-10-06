import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { dbOk, nowSec } from '../db.js';
import { isOnline, jobStats24h, uptimePct24h } from '../network.js';
import { isQuarantined, nodeModels, type NodeRow } from '../routing.js';

/**
 * GET /status — the public "is it up" page's data: one verdict, the components behind it, the last 24 h of
 * server-side errors as hourly counts (codes only, never messages), and the fleet as a node explorer.
 *
 * Privacy: the explorer shows what the chat already shows under every reply (a short node id, chip, RAM,
 * models) plus uptime and job counts. No wallets, tokens, load averages, or anything about who asked.
 */

export type ComponentState = 'ok' | 'degraded' | 'down' | 'off';

export interface StatusComponent {
  key: 'gateway' | 'database' | 'upstream' | 'network' | 'epochs' | 'token';
  label: string;
  state: ComponentState;
  detail: string;
}

export interface StatusNode {
  /** First 8 characters of the node id — the same prefix the chat shows in "served by node_xxxx…". */
  id: string;
  chip: string | null;
  ramGb: number | null;
  models: string[];
  state: 'online' | 'busy' | 'offline';
  uptimePct24h: number;
  jobs24h: number;
  tokens24h: number;
  /** Unix seconds the node first registered; "serving since". */
  since: number;
  agentVersion: string | null;
}

const PROCESS_STARTED = nowSec();

export function computeStatus(ctx: AppContext) {
  const now = nowSec();
  const db = dbOk(ctx.db);
  const components: StatusComponent[] = [];

  components.push({ key: 'gateway', label: 'Gateway', state: 'ok', detail: `up ${fmtDuration(now - PROCESS_STARTED)}` });
  components.push({ key: 'database', label: 'Database', state: db ? 'ok' : 'down', detail: db ? 'reads and writes ok' : 'not responding' });

  const upstreamMock = ctx.upstream.name === 'mock';
  components.push({
    key: 'upstream',
    label: 'Frontier models',
    state: upstreamMock ? 'degraded' : 'ok',
    detail: upstreamMock ? 'offline mock upstream (no real frontier models)' : `${ctx.upstream.name} · zero-data-retention providers`,
  });

  let rows: NodeRow[] = [];
  if (db) rows = ctx.db.prepare(`SELECT * FROM nodes ORDER BY last_seen DESC LIMIT 500`).all() as NodeRow[];
  const live = rows.filter((r) => isOnline(r, now) && !isQuarantined(r));
  components.push({
    key: 'network',
    label: 'Mac network',
    state: live.length > 0 ? 'ok' : rows.length > 0 ? 'degraded' : 'off',
    detail: live.length > 0 ? `${live.length} of ${rows.length} registered Mac${rows.length === 1 ? '' : 's'} online` : rows.length > 0 ? 'no Macs online — open models go upstream' : 'no Macs registered yet',
  });

  const last = db
    ? (ctx.db.prepare(`SELECT epoch_start, status, created_at FROM epochs ORDER BY epoch_start DESC LIMIT 1`).get() as { epoch_start: number; status: string; created_at: number } | undefined)
    : undefined;
  const cronOff = ctx.env.EPOCH_CRON === 'off';
  const epochAge = last ? now - last.created_at : null;
  const epochLate = epochAge !== null && epochAge > ctx.config.epochSeconds * 2;
  components.push({
    key: 'epochs',
    label: 'Hourly distribution',
    state: cronOff ? 'off' : !last ? 'ok' : epochLate ? 'degraded' : 'ok',
    detail: cronOff ? 'scheduler off' : last ? `last run ${fmtDuration(epochAge!)} ago · ${last.status}` : 'no epoch yet',
  });

  const tokenLive = !(ctx.adapterStatus ?? 'mock').startsWith('mock');
  components.push({
    key: 'token',
    label: `$${ctx.config.ticker} fee feed`,
    state: tokenLive ? 'ok' : 'off',
    detail: tokenLive ? `${ctx.adapterStatus} · fees swept on chain` : 'before launch — fee feed is the test harness',
  });

  // Hourly error counts for the last 24 h, oldest first. Codes only; messages stay in the admin console.
  const since = now - 86_400;
  const errorRows = db
    ? (ctx.db.prepare(`SELECT (created_at / 3600) * 3600 AS hour, COUNT(*) AS n FROM errors_log WHERE created_at >= ? GROUP BY hour ORDER BY hour`).all(since) as Array<{ hour: number; n: number }>)
    : [];
  const byHour = new Map(errorRows.map((r) => [r.hour, r.n]));
  const firstHour = Math.floor(since / 3600) * 3600 + 3600;
  const errors24h: Array<{ hour: number; n: number }> = [];
  for (let h = firstHour; h <= now; h += 3600) errors24h.push({ hour: h, n: byHour.get(h) ?? 0 });
  const errorTotal = errors24h.reduce((a, b) => a + b.n, 0);
  const topCodes = db
    ? (ctx.db.prepare(`SELECT code, COUNT(*) AS n FROM errors_log WHERE created_at >= ? GROUP BY code ORDER BY n DESC LIMIT 5`).all(since) as Array<{ code: string; n: number }>)
    : [];

  const requests24h = db ? (ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log WHERE created_at >= ?`).get(since) as { n: number }).n : 0;

  const fleet: StatusNode[] = rows
    .filter((r) => !isQuarantined(r))
    .slice(0, 200)
    .map((r) => {
      const online = isOnline(r, now);
      const s24 = jobStats24h(ctx.db, r.node_id, now);
      const state: StatusNode['state'] = !online ? 'offline' : r.busy >= Math.max(1, r.max_parallel) ? 'busy' : 'online';
      return {
        id: r.node_id.slice(0, 8),
        chip: r.chip,
        ramGb: r.ram_gb,
        models: nodeModels(r),
        state,
        uptimePct24h: uptimePct24h(ctx.db, r, now),
        jobs24h: s24.jobs,
        tokens24h: s24.tokens,
        since: r.created_at,
        agentVersion: r.agent_version,
      };
    })
    .sort((a, b) => (a.state === 'offline' ? 1 : 0) - (b.state === 'offline' ? 1 : 0) || b.jobs24h - a.jobs24h);

  const worst = components.reduce<ComponentState>((acc, c) => (rank(c.state) > rank(acc) ? c.state : acc), 'ok');
  const overall: 'operational' | 'degraded' | 'down' = worst === 'down' ? 'down' : worst === 'degraded' ? 'degraded' : 'operational';

  return {
    overall,
    components,
    requests24h,
    errors24h,
    errorTotal24h: errorTotal,
    topErrorCodes: topCodes,
    fleet,
    fleetOnline: live.length,
    generatedAt: now,
  };
}

/** 'off' is a deliberate state (feature not switched on), never a fault; it ranks below ok for the verdict. */
function rank(s: ComponentState): number {
  return s === 'down' ? 3 : s === 'degraded' ? 2 : 0;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`;
}

export async function statusRoutes(app: FastifyInstance, ctx: AppContext) {
  let cache: { at: number; body: ReturnType<typeof computeStatus> } | null = null;
  app.get('/status', async (_req, reply) => {
    const ttl = Math.min(ctx.env.STATS_CACHE_MS, 15_000);
    const t = Date.now();
    if (!cache || ttl === 0 || t - cache.at >= ttl) cache = { at: t, body: computeStatus(ctx) };
    reply.header('cache-control', `public, max-age=${Math.floor(ttl / 1000)}`);
    return reply.code(cache.body.overall === 'down' ? 503 : 200).send(cache.body);
  });
}
