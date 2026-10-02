// Pre-launch points programme. Chain-agnostic: points live in the gateway's points_ledger and
// convert to MESH at TGE at a ratio set then (docs/POINTS.md). Nothing here touches a chain.
//
// Sources (all idempotent per source row through the (wallet, kind, ref) unique index):
//   credits   credits_ledger rows of kind 'distribution'  → perUsdCredits per $1 received
//   usage     credits_ledger rows of kind 'usage'         → perUsdSpent per $1 spent
//   node      node_rewards rows of kind 'node_reward'     → perNodeTokenK per 1,000 tokens served
//   referral_signup / referral_share                       → referrals (see claimReferral / awardPoints)
//   adjustment                                             → admin, audited, exempt from the daily cap
import { randomBytes } from 'node:crypto';
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';

export type PointsConfig = TokenomicsConfig['points'];
export type PointsKind = 'credits' | 'usage' | 'node' | 'referral_signup' | 'referral_share' | 'adjustment';

export const POINTS_KINDS: PointsKind[] = ['credits', 'usage', 'node', 'referral_signup', 'referral_share', 'adjustment'];
/** Kinds a referrer gets a share of (the referee's own earning, never bonuses or adjustments). */
const SHAREABLE: ReadonlySet<PointsKind> = new Set(['credits', 'usage', 'node']);

const DAY = 86_400;
export const utcDayStart = (ts: number) => Math.floor(ts / DAY) * DAY;
/** Points are kept to a thousandth so tiny requests still accrue instead of flooring to zero. */
export const roundPoints = (p: number) => Math.round(p * 1000) / 1000;

export interface PointsRow {
  id: number;
  wallet: string;
  kind: PointsKind;
  points: number;
  ref: string | null;
  created_at: number;
}

// ---------------- rates ----------------

export function pointsForCreditsMicros(cfg: PointsConfig, usdMicros: number): number {
  return roundPoints((Math.max(0, usdMicros) / 1e6) * cfg.perUsdCredits);
}

export function pointsForSpendMicros(cfg: PointsConfig, usdMicros: number): number {
  return roundPoints((Math.max(0, usdMicros) / 1e6) * cfg.perUsdSpent);
}

export function pointsForNodeTokens(cfg: PointsConfig, tokens: number): number {
  return roundPoints((Math.max(0, tokens) / 1000) * cfg.perNodeTokenK);
}

// ---------------- awarding ----------------

export interface AwardResult {
  id: number;
  /** Points actually credited (after the daily cap). */
  points: number;
  /** Points requested before the cap. */
  requested: number;
  capped: boolean;
}

/** Points a wallet earned (cap-relevant kinds only) in the UTC day that contains `ts`. */
export function earnedOnDay(db: Db, wallet: string, ts: number): number {
  const start = utcDayStart(ts);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS v FROM points_ledger
       WHERE wallet = ? AND kind != 'adjustment' AND created_at >= ? AND created_at < ?`,
    )
    .get(wallet, start, start + DAY) as { v: number };
  return row.v;
}

/**
 * Append one points row. Returns null when `ref` was already awarded to this wallet for this kind
 * (idempotent replays). Positive awards of every kind but 'adjustment' are clamped to what is left
 * of the wallet's daily cap; a fully clamped award still writes a 0-point row so the ref is spent.
 * When the earner was referred, the referrer gets `referralShareBps` of the credited amount.
 */
export function awardPoints(
  db: Db,
  cfg: PointsConfig,
  entry: { wallet: string; kind: PointsKind; points: number; ref?: string | null; ts?: number },
): AwardResult | null {
  if (!Number.isFinite(entry.points)) throw new Error('points must be finite');
  const ts = entry.ts ?? nowSec();
  const requested = roundPoints(entry.points);
  const run = db.transaction((): AwardResult | null => {
    if (entry.ref) {
      const dup = db.prepare(`SELECT id FROM points_ledger WHERE wallet = ? AND kind = ? AND ref = ?`).get(entry.wallet, entry.kind, entry.ref);
      if (dup) return null;
    }
    let points = requested;
    if (points > 0 && entry.kind !== 'adjustment' && cfg.dailyCapPerWallet > 0) {
      const remaining = Math.max(0, cfg.dailyCapPerWallet - earnedOnDay(db, entry.wallet, ts));
      points = roundPoints(Math.min(points, remaining));
    }
    const res = db
      .prepare(`INSERT INTO points_ledger (wallet, kind, points, ref, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.wallet, entry.kind, points, entry.ref ?? null, ts);
    const id = Number(res.lastInsertRowid);
    if (points > 0 && SHAREABLE.has(entry.kind) && cfg.referralShareBps > 0) {
      const ref = db.prepare(`SELECT referrer FROM referrals WHERE wallet = ?`).get(entry.wallet) as { referrer: string } | undefined;
      if (ref && ref.referrer !== entry.wallet) {
        awardPoints(db, cfg, { wallet: ref.referrer, kind: 'referral_share', points: (points * cfg.referralShareBps) / 10_000, ref: `share:${id}`, ts });
      }
    }
    return { id, points, requested, capped: points < requested };
  });
  return run();
}

// ---------------- incremental sync from the money ledgers ----------------

type SyncSource = 'credits_ledger' | 'node_rewards';

function cursor(db: Db, source: SyncSource): number {
  const row = db.prepare(`SELECT last_id FROM points_sync WHERE source = ?`).get(source) as { last_id: number } | undefined;
  return row?.last_id ?? 0;
}

function setCursor(db: Db, source: SyncSource, lastId: number): void {
  db.prepare(`INSERT INTO points_sync (source, last_id) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_id = excluded.last_id`).run(source, lastId);
}

export interface SyncResult {
  entries: number;
  points: number;
}

/**
 * Award points for every credits_ledger / node_rewards row written since the last sync. Called
 * after distributions and request accounting, and lazily before points are read, so a wallet's
 * points never lag its money by more than one read. Safe to call concurrently or repeatedly: the
 * cursor and the unique (wallet, kind, ref) index make each source row count exactly once.
 */
export function syncPoints(db: Db, cfg: PointsConfig, batch = 5000): SyncResult {
  const out: SyncResult = { entries: 0, points: 0 };
  if (!cfg.enabled) return out;
  const credit = (r: AwardResult | null) => {
    if (!r) return;
    out.entries++;
    out.points = roundPoints(out.points + r.points);
  };
  const run = db.transaction(() => {
    // credits received (distributions) and credits spent (usage)
    for (;;) {
      const from = cursor(db, 'credits_ledger');
      const rows = db
        .prepare(
          `SELECT id, wallet, delta_usd_micros, kind, created_at FROM credits_ledger
           WHERE id > ? AND kind IN ('distribution', 'usage') ORDER BY id LIMIT ?`,
        )
        .all(from, batch) as Array<{ id: number; wallet: string; delta_usd_micros: number; kind: string; created_at: number }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.kind === 'distribution' && r.delta_usd_micros > 0) {
          credit(awardPoints(db, cfg, { wallet: r.wallet, kind: 'credits', points: pointsForCreditsMicros(cfg, r.delta_usd_micros), ref: `credit:${r.id}`, ts: r.created_at }));
        } else if (r.kind === 'usage' && r.delta_usd_micros < 0) {
          credit(awardPoints(db, cfg, { wallet: r.wallet, kind: 'usage', points: pointsForSpendMicros(cfg, -r.delta_usd_micros), ref: `usage:${r.id}`, ts: r.created_at }));
        }
      }
      setCursor(db, 'credits_ledger', rows[rows.length - 1].id);
      if (rows.length < batch) break;
    }
    // tokens served by the wallet's nodes
    for (;;) {
      const from = cursor(db, 'node_rewards');
      const rows = db
        .prepare(`SELECT id, wallet, tokens, kind, created_at FROM node_rewards WHERE id > ? ORDER BY id LIMIT ?`)
        .all(from, batch) as Array<{ id: number; wallet: string; tokens: number; kind: string; created_at: number }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.kind !== 'node_reward' || r.tokens <= 0) continue;
        credit(awardPoints(db, cfg, { wallet: r.wallet, kind: 'node', points: pointsForNodeTokens(cfg, r.tokens), ref: `node:${r.id}`, ts: r.created_at }));
      }
      setCursor(db, 'node_rewards', rows[rows.length - 1].id);
      if (rows.length < batch) break;
    }
  });
  run();
  return out;
}

// ---------------- reads ----------------

export function pointsBalance(db: Db, wallet: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(points), 0) AS v FROM points_ledger WHERE wallet = ?`).get(wallet) as { v: number };
  return roundPoints(row.v);
}

export function pointsSince(db: Db, wallet: string, sinceSec: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(points), 0) AS v FROM points_ledger WHERE wallet = ? AND created_at >= ?`)
    .get(wallet, sinceSec) as { v: number };
  return roundPoints(row.v);
}

export function recentPoints(db: Db, wallet: string, limit = 20): PointsRow[] {
  return db.prepare(`SELECT * FROM points_ledger WHERE wallet = ? ORDER BY id DESC LIMIT ?`).all(wallet, limit) as PointsRow[];
}

export interface PointsSummary {
  wallet: string;
  points: number;
  /** Points earned in the last 24 hours. */
  delta24h: number;
  /** Points earned so far in the current UTC day (cap-relevant kinds). */
  today: number;
  dailyCap: number;
  byKind: Record<PointsKind, number>;
  rank: number | null;
  recent: Array<{ id: number; kind: PointsKind; points: number; ref: string | null; created_at: number }>;
  rules: PointsRules;
}

export interface PointsRules {
  enabled: boolean;
  perUsdCredits: number;
  perUsdSpent: number;
  perNodeTokenK: number;
  perReferralSignup: number;
  referralSharePercent: number;
  dailyCapPerWallet: number;
  conversion: string;
}

export const CONVERSION_NOTE = 'Points convert to MESH at TGE at a ratio set then. Points are not a promise of any amount of MESH.';

export function pointsRules(cfg: PointsConfig): PointsRules {
  return {
    enabled: cfg.enabled,
    perUsdCredits: cfg.perUsdCredits,
    perUsdSpent: cfg.perUsdSpent,
    perNodeTokenK: cfg.perNodeTokenK,
    perReferralSignup: cfg.perReferralSignup,
    referralSharePercent: cfg.referralShareBps / 100,
    dailyCapPerWallet: cfg.dailyCapPerWallet,
    conversion: CONVERSION_NOTE,
  };
}

export function pointsSummary(db: Db, cfg: PointsConfig, wallet: string, now = nowSec()): PointsSummary {
  const byKind = Object.fromEntries(POINTS_KINDS.map((k) => [k, 0])) as Record<PointsKind, number>;
  const rows = db.prepare(`SELECT kind, COALESCE(SUM(points), 0) AS v FROM points_ledger WHERE wallet = ? GROUP BY kind`).all(wallet) as Array<{ kind: PointsKind; v: number }>;
  for (const r of rows) byKind[r.kind] = roundPoints(r.v);
  const points = pointsBalance(db, wallet);
  const rank =
    points > 0
      ? (db.prepare(`SELECT COUNT(*) + 1 AS r FROM points_balances WHERE points > ?`).get(points) as { r: number }).r
      : null;
  return {
    wallet,
    points,
    delta24h: pointsSince(db, wallet, now - DAY),
    today: roundPoints(earnedOnDay(db, wallet, now)),
    dailyCap: cfg.dailyCapPerWallet,
    byKind,
    rank,
    recent: recentPoints(db, wallet, 20).map((r) => ({ id: r.id, kind: r.kind, points: r.points, ref: r.ref, created_at: r.created_at })),
    rules: pointsRules(cfg),
  };
}

// ---------------- referrals ----------------

/** No 0/O/1/I so codes survive being read aloud or retyped. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LEN = 6;
export const REFERRAL_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${REFERRAL_CODE_LEN}}$`);

export function randomReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LEN);
  let s = '';
  for (let i = 0; i < REFERRAL_CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/** Every wallet gets exactly one code, minted on first request. */
export function getOrCreateReferralCode(db: Db, wallet: string): string {
  const run = db.transaction(() => {
    const existing = db.prepare(`SELECT code FROM referral_codes WHERE wallet = ?`).get(wallet) as { code: string } | undefined;
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomReferralCode();
      const res = db
        .prepare(`INSERT INTO referral_codes (wallet, code, created_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING`)
        .run(wallet, code, nowSec());
      if (res.changes === 1) return code;
    }
    throw new Error('could not mint a unique referral code');
  });
  return run();
}

export function walletForCode(db: Db, code: string): string | null {
  const row = db.prepare(`SELECT wallet FROM referral_codes WHERE code = ?`).get(code) as { wallet: string } | undefined;
  return row?.wallet ?? null;
}

export type ClaimError = 'invalid_code' | 'unknown_code' | 'self_referral' | 'already_referred' | 'circular_referral' | 'disabled';

export type ClaimResult = { ok: true; referrer: string; pointsAwarded: number } | { ok: false; error: ClaimError };

/**
 * Bind `wallet` to the owner of `code` once. Rejects self-referral, a second claim, and the referee
 * referring their own referrer (A→B then B→A), which would otherwise mint signup points both ways.
 */
export function claimReferral(db: Db, cfg: PointsConfig, input: { wallet: string; code: string; ts?: number }): ClaimResult {
  if (!cfg.enabled) return { ok: false, error: 'disabled' };
  const code = input.code.trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(code)) return { ok: false, error: 'invalid_code' };
  const ts = input.ts ?? nowSec();
  const run = db.transaction((): ClaimResult => {
    const referrer = walletForCode(db, code);
    if (!referrer) return { ok: false, error: 'unknown_code' };
    if (referrer === input.wallet) return { ok: false, error: 'self_referral' };
    if (db.prepare(`SELECT 1 FROM referrals WHERE wallet = ?`).get(input.wallet)) return { ok: false, error: 'already_referred' };
    const theirs = db.prepare(`SELECT referrer FROM referrals WHERE wallet = ?`).get(referrer) as { referrer: string } | undefined;
    if (theirs?.referrer === input.wallet) return { ok: false, error: 'circular_referral' };
    db.prepare(`INSERT INTO referrals (wallet, referrer, code, created_at) VALUES (?, ?, ?, ?)`).run(input.wallet, referrer, code, ts);
    const award = awardPoints(db, cfg, { wallet: referrer, kind: 'referral_signup', points: cfg.perReferralSignup, ref: `signup:${input.wallet}`, ts });
    return { ok: true, referrer, pointsAwarded: award?.points ?? 0 };
  });
  return run();
}

export interface ReferralSummary {
  wallet: string;
  code: string;
  /** Wallets that claimed this wallet's code. */
  referred: number;
  /** Signup bonuses + shares earned from referees. */
  pointsEarned: number;
  pointsFromSignups: number;
  pointsFromShare: number;
  /** Who referred this wallet (null when nobody did). */
  referredBy: string | null;
  perReferralSignup: number;
  referralSharePercent: number;
}

export function referralSummary(db: Db, cfg: PointsConfig, wallet: string): ReferralSummary {
  const code = getOrCreateReferralCode(db, wallet);
  const referred = (db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer = ?`).get(wallet) as { n: number }).n;
  const sums = db
    .prepare(`SELECT kind, COALESCE(SUM(points), 0) AS v FROM points_ledger WHERE wallet = ? AND kind IN ('referral_signup', 'referral_share') GROUP BY kind`)
    .all(wallet) as Array<{ kind: PointsKind; v: number }>;
  const signups = roundPoints(sums.find((s) => s.kind === 'referral_signup')?.v ?? 0);
  const share = roundPoints(sums.find((s) => s.kind === 'referral_share')?.v ?? 0);
  const by = db.prepare(`SELECT referrer FROM referrals WHERE wallet = ?`).get(wallet) as { referrer: string } | undefined;
  return {
    wallet,
    code,
    referred,
    pointsEarned: roundPoints(signups + share),
    pointsFromSignups: signups,
    pointsFromShare: share,
    referredBy: by?.referrer ?? null,
    perReferralSignup: cfg.perReferralSignup,
    referralSharePercent: cfg.referralShareBps / 100,
  };
}

// ---------------- leaderboards ----------------

export type Board = 'holders' | 'nodes' | 'points' | 'referrers';
export const BOARDS: Board[] = ['holders', 'nodes', 'points', 'referrers'];

export interface BoardRow {
  wallet: string;
  /** The ranked quantity: credits earned (USD), tokens served, points, or wallets referred. */
  value: number;
  /** Supporting figure: jobs served (nodes) or referral points earned (referrers). */
  secondary: number | null;
}

/** Full ordering for one board, best first. Ties break on wallet so the order is stable. */
export function leaderboardRows(db: Db, board: Board): BoardRow[] {
  switch (board) {
    case 'holders':
      return (
        db
          .prepare(
            `SELECT wallet, SUM(delta_usd_micros) AS v FROM credits_ledger WHERE kind = 'distribution'
             GROUP BY wallet HAVING v > 0 ORDER BY v DESC, wallet ASC`,
          )
          .all() as Array<{ wallet: string; v: number }>
      ).map((r) => ({ wallet: r.wallet, value: r.v / 1e6, secondary: null }));
    case 'nodes':
      return (
        db
          .prepare(
            `SELECT wallet, SUM(tokens) AS v, COUNT(*) AS jobs FROM node_rewards WHERE kind = 'node_reward'
             GROUP BY wallet HAVING v > 0 ORDER BY v DESC, wallet ASC`,
          )
          .all() as Array<{ wallet: string; v: number; jobs: number }>
      ).map((r) => ({ wallet: r.wallet, value: r.v, secondary: r.jobs }));
    case 'points':
      return (
        db.prepare(`SELECT wallet, points AS v FROM points_balances WHERE points > 0 ORDER BY v DESC, wallet ASC`).all() as Array<{ wallet: string; v: number }>
      ).map((r) => ({ wallet: r.wallet, value: roundPoints(r.v), secondary: null }));
    case 'referrers':
      return (
        db
          .prepare(
            `SELECT r.referrer AS wallet, COUNT(*) AS v,
                    (SELECT COALESCE(SUM(points), 0) FROM points_ledger p WHERE p.wallet = r.referrer AND p.kind IN ('referral_signup', 'referral_share')) AS pts
             FROM referrals r GROUP BY r.referrer ORDER BY v DESC, pts DESC, wallet ASC`,
          )
          .all() as Array<{ wallet: string; v: number; pts: number }>
      ).map((r) => ({ wallet: r.wallet, value: r.v, secondary: roundPoints(r.pts) }));
  }
}

/** Public form of a wallet address: enough to recognise yourself, not enough to look anyone up. */
export function truncateWallet(wallet: string): string {
  if (wallet.length > 10) return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  return `${wallet.slice(0, 2)}…`;
}
