import { statSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TokenomicsConfig } from '@mesh/config';
import { requireAdmin, type AppContext } from './context.js';
import type { Db } from './db.js';
import type { Env } from './env.js';
import { markWithdrawalAnnounced, unannouncedWithdrawals, withdrawalQueue } from './market.js';
import { microsToUsd } from './money.js';
import { nodePayoutTotals } from './node-payouts.js';
import { reserveView } from './reserve-report.js';
import { NODE_ONLINE_SEC } from './routing.js';

/**
 * Ops monitoring for one gateway process. `AlertMonitor.check()` is pure with respect to time
 * (`now` is injected) and delivery (`sender` is injected), so it is ticked by a timer in
 * production and by hand in tests. Alerts fire once on transition (ok → firing), re-notify every
 * `renotifyMs` while still firing, and send a "resolved" line when they clear.
 *
 * Conditions:
 *   missed_epoch        no complete/empty epoch written for > 1.5 × epochSeconds (cron on)
 *   failed_sweep        a new epochs.status='failed' row, an `epoch_failed` error, or a `sweep_skipped` error
 *                       (fees left unswept because the price feed was stale, jobs/housekeeping.ts) since last check
 *   upstream_error_rate upstream_* errors / (errors + served requests) > 20 % over 5 min (≥ 3 errors)
 *   fleet_drop          online nodes fell by > 50 % compared with 10 minutes ago (≥ 2 nodes before)
 *   db_size             SQLite file (+ WAL) larger than ALERT_DB_MAX_MB
 *   disk_low            free space on the DB volume below ALERT_DISK_MIN_FREE_PCT
 *   reserve_short       the credit-pool wallet holds less stablecoin than reserve.minCoverageBps of the
 *                       credits owed (reserve-report.ts); silent while there is no reading (mock adapter)
 *
 * Plus a daily digest at 09:00 Asia/Dubai: fees, credits, requests, nodes, withdrawals waiting to be
 * paid, errors (24 h).
 *
 * Withdrawals are paid by hand, so each request is also announced as an event: one message per new
 * `withdrawal_requests` row (`notifyWithdrawals`), sent straight after POST /me/market/withdraw and
 * again on every check until it has gone out. It is not a level alert and never "resolves".
 */

export type AlertKey = 'missed_epoch' | 'failed_sweep' | 'upstream_error_rate' | 'fleet_drop' | 'db_size' | 'disk_low' | 'reserve_short';

export interface AlertSender {
  readonly name: string;
  send(text: string): Promise<void>;
}

export interface AlertState {
  key: AlertKey;
  firing: boolean;
  /** ms when it started firing (null when ok). */
  since: number | null;
  lastNotifiedAt: number | null;
  detail: string;
}

export interface Thresholds {
  epochMissFactor: number;
  upstreamWindowMs: number;
  upstreamMinErrors: number;
  upstreamErrorRate: number;
  fleetWindowMs: number;
  fleetDropRatio: number;
  fleetMinBefore: number;
  dbMaxBytes: number;
  diskMinFreePct: number;
  renotifyMs: number;
  /** Local hour (Asia/Dubai) at which the digest is sent. */
  digestHour: number;
  digestTimeZone: string;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  epochMissFactor: 1.5,
  upstreamWindowMs: 5 * 60_000,
  upstreamMinErrors: 3,
  upstreamErrorRate: 0.2,
  fleetWindowMs: 10 * 60_000,
  fleetDropRatio: 0.5,
  fleetMinBefore: 2,
  dbMaxBytes: 1024 * 1024 * 1024,
  diskMinFreePct: 10,
  renotifyMs: 6 * 3_600_000,
  digestHour: 9,
  digestTimeZone: 'Asia/Dubai',
};

export interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
}

export interface AlertMonitorOptions {
  db: Db;
  config: Pick<TokenomicsConfig, 'epochSeconds'> & Partial<Pick<TokenomicsConfig, 'reserve'>> & { marketplace?: Pick<TokenomicsConfig['marketplace'], 'settlementSymbol'> };
  env: Pick<Env, 'EPOCH_CRON' | 'MESH_DB_PATH'>;
  sender: AlertSender;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
  log?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  thresholds?: Partial<Thresholds>;
  /** Size of the DB file (bytes) or null when unknown; defaults to statSync on MESH_DB_PATH (+ -wal). */
  dbSize?: () => number | null;
  /** Disk usage of the volume holding the DB, or null when unknown; defaults to statfsSync. */
  disk?: () => DiskInfo | null;
}

// ---------------- senders ----------------

const TELEGRAM_TIMEOUT_MS = 10_000;

export function telegramSender(botToken: string, chatId: string, fetchImpl: typeof fetch = fetch): AlertSender {
  return {
    name: 'telegram',
    async send(text: string) {
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        // A send that hangs would hold up every check behind it (check() awaits its deliveries).
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`telegram sendMessage failed: HTTP ${res.status}`);
    },
  };
}

export function logSender(log: { warn(o: unknown, m?: string): void }): AlertSender {
  return {
    name: 'log',
    async send(text: string) {
      log.warn({ alert: text }, 'ALERT');
    },
  };
}

/** Telegram when both env vars are set, otherwise the log. */
export function senderFromEnv(env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>, log: { warn(o: unknown, m?: string): void }, fetchImpl?: typeof fetch): AlertSender {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? telegramSender(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetchImpl) : logSender(log);
}

// ---------------- helpers ----------------

function defaultDbSize(path: string): number | null {
  if (path === ':memory:') return null;
  try {
    let total = statSync(path).size;
    try {
      total += statSync(`${path}-wal`).size;
    } catch {
      /* no WAL file */
    }
    return total;
  } catch {
    return null;
  }
}

function defaultDisk(path: string): DiskInfo | null {
  if (path === ':memory:') return null;
  try {
    const s = statfsSync(dirname(resolve(path)));
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Local calendar day + hour in `timeZone` for `ms`. */
export function localDayHour(ms: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24; // some ICU builds print "24" for midnight
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

// ---------------- monitor ----------------

export class AlertMonitor {
  readonly thresholds: Thresholds;
  private states = new Map<AlertKey, AlertState>();
  private now: () => number;
  private log: NonNullable<AlertMonitorOptions['log']>;
  private dbSize: () => number | null;
  private disk: () => DiskInfo | null;
  private startedAt: number;
  private lastCheckAt: number | null = null;
  private lastFailedSweepSeen: { epochId: number; errorId: number };
  private lastDigestDay: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** A withdrawal announcement run is in flight (the request route and the timer may both ask for one). */
  private announcing: Promise<number> | null = null;
  /** Every message handed to the sender (bounded), for /health/alerts and tests. */
  readonly sent: Array<{ at: number; text: string; ok: boolean }> = [];
  deliveryFailures = 0;

  constructor(private opts: AlertMonitorOptions) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? { info() {}, warn() {}, error() {} };
    this.dbSize = opts.dbSize ?? (() => defaultDbSize(opts.env.MESH_DB_PATH));
    this.disk = opts.disk ?? (() => defaultDisk(opts.env.MESH_DB_PATH));
    this.startedAt = this.now();
    for (const key of ['missed_epoch', 'failed_sweep', 'upstream_error_rate', 'fleet_drop', 'db_size', 'disk_low', 'reserve_short'] as AlertKey[]) {
      this.states.set(key, { key, firing: false, since: null, lastNotifiedAt: null, detail: 'not evaluated yet' });
    }
    // Failures that predate this process were (hopefully) handled by the previous one.
    this.lastFailedSweepSeen = {
      epochId: (this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS v FROM epochs WHERE status = 'failed'`).get() as { v: number }).v,
      errorId: (this.db.prepare(`SELECT COALESCE(MAX(id),0) AS v FROM errors_log WHERE code IN ('epoch_failed', 'sweep_skipped')`).get() as { v: number }).v,
    };
    // Don't re-send today's digest after a restart that happens after 09:00.
    const { day, hour } = localDayHour(this.now(), this.thresholds.digestTimeZone);
    if (hour >= this.thresholds.digestHour) this.lastDigestDay = day;
  }

  private get db() {
    return this.opts.db;
  }

  get sender(): AlertSender {
    return this.opts.sender;
  }

  /** Begin ticking on a timer (production). */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check().catch((err) => this.log.error({ err }, 'alert check failed')), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- evaluators (each returns firing + detail) ----

  evalMissedEpoch(now: number): { firing: boolean; detail: string } {
    if (this.opts.env.EPOCH_CRON === 'off') return { firing: false, detail: 'EPOCH_CRON=off' };
    const E = this.opts.config.epochSeconds * 1000;
    const limit = E * this.thresholds.epochMissFactor;
    const last = this.db.prepare(`SELECT created_at FROM epochs WHERE status IN ('complete','empty') ORDER BY created_at DESC LIMIT 1`).get() as { created_at: number } | undefined;
    const ref = last ? last.created_at * 1000 : this.startedAt;
    const age = now - ref;
    const firing = age > limit;
    const detail = last
      ? `last epoch written ${Math.round(age / 60_000)} min ago (limit ${Math.round(limit / 60_000)} min)`
      : `no epoch since boot ${Math.round(age / 60_000)} min ago (limit ${Math.round(limit / 60_000)} min)`;
    return { firing, detail };
  }

  evalFailedSweep(): { firing: boolean; detail: string } {
    const ep = this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS v, COUNT(*) AS n FROM epochs WHERE status = 'failed' AND rowid > ?`).get(this.lastFailedSweepSeen.epochId) as { v: number; n: number };
    const er = this.db.prepare(`SELECT COALESCE(MAX(id),0) AS v, COUNT(*) AS n, MAX(message) AS m FROM errors_log WHERE code IN ('epoch_failed', 'sweep_skipped') AND id > ?`).get(this.lastFailedSweepSeen.errorId) as { v: number; n: number; m: string | null };
    const n = ep.n + er.n;
    if (ep.v) this.lastFailedSweepSeen.epochId = ep.v;
    if (er.v) this.lastFailedSweepSeen.errorId = er.v;
    return n > 0 ? { firing: true, detail: `${n} failed sweep(s) since last check${er.m ? `: ${er.m.slice(0, 160)}` : ''}` } : { firing: false, detail: 'no failed sweeps' };
  }

  evalUpstreamErrors(now: number): { firing: boolean; detail: string } {
    const since = Math.floor((now - this.thresholds.upstreamWindowMs) / 1000);
    const errs = (this.db.prepare(`SELECT COUNT(*) AS n FROM errors_log WHERE created_at >= ? AND (code LIKE 'upstream_%' OR code = 'node_stream_failed')`).get(since) as { n: number }).n;
    const ok = (this.db.prepare(`SELECT COUNT(*) AS n FROM requests_log WHERE created_at >= ?`).get(since) as { n: number }).n;
    const total = errs + ok;
    const rate = total === 0 ? 0 : errs / total;
    const firing = errs >= this.thresholds.upstreamMinErrors && rate > this.thresholds.upstreamErrorRate;
    return { firing, detail: `${errs} upstream errors / ${total} requests in ${this.thresholds.upstreamWindowMs / 60_000} min (${Math.round(rate * 100)} %)` };
  }

  evalFleet(now: number): { firing: boolean; detail: string } {
    const nowSec = Math.floor(now / 1000);
    const online = (this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE last_seen >= ?`).get(nowSec - NODE_ONLINE_SEC) as { n: number }).n;
    const then = nowSec - Math.floor(this.thresholds.fleetWindowMs / 1000);
    const before = (this.db.prepare(`SELECT COUNT(DISTINCT node_id) AS n FROM heartbeats WHERE ts BETWEEN ? AND ?`).get(then - NODE_ONLINE_SEC, then) as { n: number }).n;
    const firing = before >= this.thresholds.fleetMinBefore && online < before * (1 - this.thresholds.fleetDropRatio);
    return { firing, detail: `${online} nodes online now, ${before} ten minutes ago` };
  }

  evalDbSize(): { firing: boolean; detail: string } {
    const size = this.dbSize();
    if (size === null) return { firing: false, detail: 'db size unknown (in-memory)' };
    return { firing: size > this.thresholds.dbMaxBytes, detail: `db ${fmtBytes(size)} (limit ${fmtBytes(this.thresholds.dbMaxBytes)})` };
  }

  evalDisk(): { firing: boolean; detail: string } {
    const d = this.disk();
    if (!d || d.totalBytes <= 0) return { firing: false, detail: 'disk unknown' };
    const pct = (d.freeBytes / d.totalBytes) * 100;
    return { firing: pct < this.thresholds.diskMinFreePct, detail: `${fmtBytes(d.freeBytes)} free of ${fmtBytes(d.totalBytes)} (${pct.toFixed(1)} %, min ${this.thresholds.diskMinFreePct} %)` };
  }

  evalReserve(): { firing: boolean; detail: string } {
    const r = reserveView({ db: this.db, config: { reserve: this.opts.config.reserve ?? { minCoverageBps: 10_000 } } });
    // A failed read says nothing about the reserve: keep the alert as it was rather than report it resolved.
    if (r.source === 'unavailable') return { firing: this.states.get('reserve_short')?.firing ?? false, detail: 'the last read of the credit-pool wallet failed; waiting for the next epoch' };
    if (r.short === null || r.heldUsd === null || r.coverage === null) return { firing: false, detail: `reserve ${r.source}: nothing to compare` };
    return { firing: r.short, detail: `credit pool holds $${r.heldUsd.toFixed(2)} against $${r.requiredUsd.toFixed(2)} of credits owed (${(r.coverage * 100).toFixed(1)} %, min ${r.minCoverageBps / 100} %)` };
  }

  /**
   * Tell the operator channel about every pending withdrawal it has not heard of yet: one message per
   * request, stamped `notified_at` once it has been sent. A message that fails to send leaves the row
   * unstamped, so the next check tries again. Returns how many went out. Safe to call at any time; calls
   * that overlap share one run.
   */
  notifyWithdrawals(): Promise<number> {
    if (this.announcing) return this.announcing;
    const run = (async () => {
      let sent = 0;
      for (const w of unannouncedWithdrawals(this.db)) {
        const q = withdrawalQueue(this.db);
        const ok = await this.deliver(
          `[mesh] WITHDRAWAL requested #${w.id}: $${microsToUsd(w.amount_micros).toFixed(2)} to ${w.wallet}\n` +
            `pending now: ${q.pending} request(s), $${microsToUsd(q.pendingMicros).toFixed(2)}. Send the ${this.opts.config.marketplace?.settlementSymbol ?? 'stablecoin'} to that wallet, then mark it paid in Admin → Withdrawals (POST /admin/market/withdrawals/${w.id}/paid).`,
        );
        if (!ok) break;
        markWithdrawalAnnounced(this.db, w.id, Math.floor(this.now() / 1000));
        sent++;
      }
      return sent;
    })();
    this.announcing = run.finally(() => {
      this.announcing = null;
    });
    return this.announcing;
  }

  /** Evaluate every condition, notify on transitions, send the digest when due. */
  async check(): Promise<AlertState[]> {
    const now = this.now();
    this.lastCheckAt = now;
    await this.notifyWithdrawals();
    const results: Array<[AlertKey, { firing: boolean; detail: string }]> = [
      ['missed_epoch', this.evalMissedEpoch(now)],
      ['failed_sweep', this.evalFailedSweep()],
      ['upstream_error_rate', this.evalUpstreamErrors(now)],
      ['fleet_drop', this.evalFleet(now)],
      ['db_size', this.evalDbSize()],
      ['disk_low', this.evalDisk()],
      ['reserve_short', this.evalReserve()],
    ];
    for (const [key, r] of results) {
      const st = this.states.get(key)!;
      st.detail = r.detail;
      if (r.firing && !st.firing) {
        st.firing = true;
        st.since = now;
        st.lastNotifiedAt = now;
        await this.deliver(`[mesh] ALERT ${key}: ${r.detail}`);
      } else if (r.firing && st.firing && st.lastNotifiedAt !== null && now - st.lastNotifiedAt >= this.thresholds.renotifyMs) {
        st.lastNotifiedAt = now;
        await this.deliver(`[mesh] STILL FIRING ${key} (${Math.round((now - (st.since ?? now)) / 60_000)} min): ${r.detail}`);
      } else if (!r.firing && st.firing) {
        // failed_sweep is an event, not a level: it clears silently on the next clean check.
        if (key !== 'failed_sweep') await this.deliver(`[mesh] resolved ${key}: ${r.detail}`);
        st.firing = false;
        st.since = null;
      }
    }
    const { day, hour } = localDayHour(now, this.thresholds.digestTimeZone);
    if (hour >= this.thresholds.digestHour && this.lastDigestDay !== day) {
      this.lastDigestDay = day;
      await this.deliver(this.digest(now));
    }
    return this.status().alerts;
  }

  /** Daily digest text (last 24 h). */
  digest(now = this.now()): string {
    const since = Math.floor(now / 1000) - 86_400;
    const db = this.db;
    const ep = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(fees_usd_micros),0) AS fees, COALESCE(SUM(holder_pool_usd_micros),0) AS pool, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM epochs WHERE created_at >= ?`).get(since) as { n: number; fees: number; pool: number; failed: number | null };
    const dist = (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind = 'distribution' AND created_at >= ?`).get(since) as { v: number }).v;
    const used = (db.prepare(`SELECT COALESCE(-SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind = 'usage' AND created_at >= ?`).get(since) as { v: number }).v;
    const req = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT wallet) AS wallets, SUM(CASE WHEN upstream LIKE 'node:%' THEN 1 ELSE 0 END) AS byNode FROM requests_log WHERE created_at >= ?`).get(since) as { n: number; wallets: number; byNode: number | null };
    const nodes = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS online FROM nodes`).get(Math.floor(now / 1000) - NODE_ONLINE_SEC) as { total: number; online: number | null };
    const rewards = (db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM node_rewards WHERE kind = 'node_reward' AND status = 'accrued' AND created_at >= ?`).get(since) as { v: number }).v;
    const errs = db.prepare(`SELECT code, COUNT(*) AS n FROM errors_log WHERE created_at >= ? GROUP BY code ORDER BY n DESC LIMIT 5`).all(since) as Array<{ code: string; n: number }>;
    const errTotal = errs.reduce((a, e) => a + e.n, 0);
    const firing = [...this.states.values()].filter((s) => s.firing).map((s) => s.key);
    const wq = withdrawalQueue(db);
    const wdNew = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros), 0) AS v FROM withdrawal_requests WHERE created_at >= ?`).get(since) as { n: number; v: number };
    const wdPaid = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros), 0) AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?`).get(since) as { n: number; v: number };
    const oldestH = wq.oldestAt === null ? 0 : Math.max(0, Math.floor((Math.floor(now / 1000) - wq.oldestAt) / 3600));
    const np = nodePayoutTotals(db, since);
    const { day } = localDayHour(now, this.thresholds.digestTimeZone);
    return [
      `[mesh] daily digest ${day} (${this.thresholds.digestTimeZone}, last 24 h)`,
      `fees: $${microsToUsd(ep.fees).toFixed(2)} over ${ep.n} epoch(s)${ep.failed ? `, ${ep.failed} failed` : ''}; holder pool $${microsToUsd(ep.pool).toFixed(2)}`,
      `credits: +$${microsToUsd(dist).toFixed(2)} distributed, -$${microsToUsd(used).toFixed(4)} used`,
      `requests: ${req.n} from ${req.wallets} wallet(s), ${req.byNode ?? 0} served by nodes`,
      `nodes: ${nodes.online ?? 0} online / ${nodes.total} registered; rewards accrued $${microsToUsd(rewards).toFixed(4)}, paid as credits $${microsToUsd(np.paidMicros).toFixed(4)} to ${np.wallets} wallet(s), $${microsToUsd(np.pendingMicros).toFixed(4)} waiting`,
      `withdrawals: ${wq.pending === 0 ? 'none waiting' : `${wq.pending} waiting to be paid ($${microsToUsd(wq.pendingMicros).toFixed(2)}), oldest ${oldestH} h`}; last 24 h: ${wdNew.n} requested ($${microsToUsd(wdNew.v).toFixed(2)}), ${wdPaid.n} paid ($${microsToUsd(wdPaid.v).toFixed(2)})`,
      `errors: ${errTotal}${errs.length ? ` (${errs.map((e) => `${e.code} ×${e.n}`).join(', ')})` : ''}`,
      `alerts firing: ${firing.length ? firing.join(', ') : 'none'}`,
    ].join('\n');
  }

  status() {
    return {
      sender: this.opts.sender.name,
      startedAt: this.startedAt,
      lastCheckAt: this.lastCheckAt,
      lastDigestDay: this.lastDigestDay,
      deliveryFailures: this.deliveryFailures,
      thresholds: this.thresholds,
      alerts: [...this.states.values()].map((s) => ({ ...s })),
      recentlySent: this.sent.slice(-20),
    };
  }

  /** POST /health/alerts/test: one message through the real sender, so the wiring can be proven from the admin side. */
  async sendTest(): Promise<boolean> {
    return this.deliver('Mesh alerts: test message sent through the gateway. Delivery works.');
  }

  private async deliver(text: string): Promise<boolean> {
    let ok = true;
    try {
      await this.opts.sender.send(text);
    } catch (err) {
      ok = false;
      this.deliveryFailures += 1;
      this.log.error({ err, text }, 'alert delivery failed');
    }
    this.sent.push({ at: this.now(), text, ok });
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200);
    if (ok) this.log.info({ alert: text.split('\n')[0] }, 'alert sent');
    return ok;
  }
}

/** GET /health/alerts (admin): monitor state, thresholds and the last messages sent. */
export async function alertRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/health/alerts', { preHandler: requireAdmin(ctx) }, async (_req, reply) => {
    if (!ctx.alerts) return reply.code(503).send({ error: 'alerts_disabled', message: 'ALERTS_ENABLED=false' });
    return ctx.alerts.status();
  });
  app.post('/health/alerts/test', { preHandler: requireAdmin(ctx) }, async (_req, reply) => {
    if (!ctx.alerts) return reply.code(503).send({ error: 'alerts_disabled', message: 'ALERTS_ENABLED=false' });
    const ok = await ctx.alerts.sendTest();
    return reply.code(ok ? 200 : 502).send({ ok, sent: ok ? 'telegram' : 'failed — see gateway logs' });
  });
}
