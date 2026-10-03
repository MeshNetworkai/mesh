import { randomBytes } from 'node:crypto';
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';

/**
 * Public beta gating (docs/RUNBOOK.md "Public beta rollout").
 *
 * With `beta.enabled && beta.inviteRequired`, a wallet may sign in (POST /auth/verify) and register
 * nodes only once it is *admitted*. Admission happens once, the first time the wallet presents a
 * valid invite code; after that the wallet is in `admissions` for good. Codes come from an admin
 * (POST /admin/invites) or from admitting the oldest waitlist entries (POST /admin/waitlist/admit),
 * which mints a one-use code per entry for the operator to send by hand.
 */

export type BetaConfig = TokenomicsConfig['beta'];

/** Codes: 10 chars from an alphabet without 0/O/1/I, grouped as XXXXX-XXXXX for humans. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 10;

export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Uppercases and strips separators so `abcde-fghjk`, `ABCDE FGHJK` and `abcdefghjk` all match. */
export function normalizeInviteCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === INVITE_CODE_LENGTH ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}

export function inviteRequired(cfg: Pick<BetaConfig, 'enabled' | 'inviteRequired'>): boolean {
  return cfg.enabled && cfg.inviteRequired;
}

export interface AdmissionRow {
  wallet: string;
  admitted_at: number;
  via: 'invite' | 'admin' | 'dev' | 'open';
  code: string | null;
}

export function isAdmitted(db: Db, wallet: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM admissions WHERE wallet = ?`).get(wallet));
}

export function admit(db: Db, wallet: string, via: AdmissionRow['via'], code: string | null = null, now = nowSec()): void {
  db.prepare(`INSERT INTO admissions (wallet, admitted_at, via, code) VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO NOTHING`).run(wallet, now, via, code);
}

export interface InviteCodeRow {
  code: string;
  uses_left: number;
  created_by: string;
  created_at: number;
}

export function createInviteCodes(db: Db, count: number, uses: number, createdBy: string, now = nowSec()): string[] {
  const insert = db.prepare(`INSERT INTO invite_codes (code, uses_left, created_by, created_at) VALUES (?, ?, ?, ?)`);
  const codes: string[] = [];
  db.transaction(() => {
    while (codes.length < count) {
      const code = generateInviteCode();
      try {
        insert.run(code, uses, createdBy, now);
        codes.push(code);
      } catch {
        /* collision (astronomically unlikely): draw again */
      }
    }
  })();
  return codes;
}

export type RedeemResult = { ok: true; code: string } | { ok: false; reason: 'invalid' | 'exhausted' };

/**
 * Consume one use of `raw` for `wallet` and admit it, atomically. A wallet that is already admitted
 * is left alone (and the code is not consumed). Also marks the matching waitlist entry, if any.
 */
export function redeemInvite(db: Db, wallet: string, raw: string, now = nowSec()): RedeemResult {
  const code = normalizeInviteCode(raw);
  const tx = db.transaction((): RedeemResult => {
    if (isAdmitted(db, wallet)) return { ok: true, code };
    const row = db.prepare(`SELECT * FROM invite_codes WHERE code = ?`).get(code) as InviteCodeRow | undefined;
    if (!row) return { ok: false, reason: 'invalid' };
    const used = db.prepare(`UPDATE invite_codes SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0`).run(code);
    if (used.changes !== 1) return { ok: false, reason: 'exhausted' };
    admit(db, wallet, 'invite', code, now);
    db.prepare(`UPDATE waitlist SET wallet = COALESCE(wallet, ?) WHERE code = ?`).run(wallet, code);
    return { ok: true, code };
  });
  return tx();
}

export interface WaitlistRow {
  id: number;
  wallet: string | null;
  email: string | null;
  created_at: number;
  invited_at: number | null;
  code: string | null;
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export type JoinResult = { ok: true; id: number; position: number; alreadyListed: boolean };

/** Add a wallet or e-mail to the waitlist (idempotent per identifier). `position` is 1-based among the not-yet-invited. */
export function joinWaitlist(db: Db, input: { wallet?: string | null; email?: string | null }, now = nowSec()): JoinResult {
  const wallet = input.wallet?.trim() || null;
  const email = input.email?.trim().toLowerCase() || null;
  const tx = db.transaction((): JoinResult => {
    const existing = db.prepare(`SELECT * FROM waitlist WHERE (wallet IS NOT NULL AND wallet = ?) OR (email IS NOT NULL AND email = ?)`).get(wallet, email) as WaitlistRow | undefined;
    let row = existing;
    if (!row) {
      const res = db.prepare(`INSERT INTO waitlist (wallet, email, created_at) VALUES (?, ?, ?)`).run(wallet, email, now);
      row = db.prepare(`SELECT * FROM waitlist WHERE id = ?`).get(Number(res.lastInsertRowid)) as WaitlistRow;
    }
    const position = row.invited_at
      ? 0
      : (db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE invited_at IS NULL AND id <= ?`).get(row.id) as { n: number }).n;
    return { ok: true, id: row.id, position, alreadyListed: Boolean(existing) };
  });
  return tx();
}

/** Admit the oldest `n` not-yet-invited entries: one single-use code each, returned for the operator to send. */
export function admitOldest(db: Db, n: number, createdBy: string, now = nowSec()): WaitlistRow[] {
  const tx = db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM waitlist WHERE invited_at IS NULL ORDER BY id ASC LIMIT ?`).all(n) as WaitlistRow[];
    const out: WaitlistRow[] = [];
    for (const r of rows) {
      const [code] = createInviteCodes(db, 1, 1, createdBy, now);
      db.prepare(`UPDATE waitlist SET invited_at = ?, code = ? WHERE id = ?`).run(now, code, r.id);
      // A wallet entry can be admitted straight away: it signs in without typing the code.
      if (r.wallet) {
        admit(db, r.wallet, 'admin', code, now);
        db.prepare(`UPDATE invite_codes SET uses_left = 0 WHERE code = ?`).run(code);
      }
      out.push({ ...r, invited_at: now, code });
    }
    return out;
  });
  return tx();
}

export function waitlistCounts(db: Db) {
  const row = db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN invited_at IS NULL THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN invited_at IS NOT NULL THEN 1 ELSE 0 END) AS invited FROM waitlist`)
    .get() as { total: number; waiting: number | null; invited: number | null };
  const admitted = (db.prepare(`SELECT COUNT(*) AS n FROM admissions`).get() as { n: number }).n;
  const codes = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(uses_left),0) AS uses FROM invite_codes WHERE uses_left > 0`).get() as { n: number; uses: number };
  return { total: row.total, waiting: row.waiting ?? 0, invited: row.invited ?? 0, admitted, liveCodes: codes.n, liveUses: codes.uses };
}

export function listWaitlist(db: Db, opts: { limit: number; status?: 'waiting' | 'invited' | 'all' }): WaitlistRow[] {
  const where = opts.status === 'waiting' ? 'WHERE invited_at IS NULL' : opts.status === 'invited' ? 'WHERE invited_at IS NOT NULL' : '';
  return db.prepare(`SELECT * FROM waitlist ${where} ORDER BY id ASC LIMIT ?`).all(opts.limit) as WaitlistRow[];
}

/** Public shape of the beta config (GET /stats). */
export function betaView(cfg: BetaConfig) {
  return { enabled: cfg.enabled, label: cfg.label, inviteRequired: inviteRequired(cfg) };
}
