import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from './db.js';
import { nowSec } from './db.js';

// ---------- nonces (SQLite-backed, 5 minute expiry, single use) ----------

export const NONCE_TTL_SEC = 5 * 60;

export interface IssuedNonce {
  nonce: string;
  wallet: string;
  domain: string;
  /** unix seconds */
  issuedAt: number;
  expiresAt: number;
}

export class NonceStore {
  constructor(
    private db: Db,
    private ttlSec = NONCE_TTL_SEC,
  ) {}

  issue(wallet: string, domain: string, now = nowSec()): IssuedNonce {
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = now + this.ttlSec;
    this.db
      .prepare(`INSERT INTO auth_nonces (nonce, wallet, domain, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(nonce, wallet, domain, now, expiresAt);
    // opportunistic cleanup of expired rows
    this.db.prepare(`DELETE FROM auth_nonces WHERE expires_at < ?`).run(now - 3600);
    return { nonce, wallet, domain, issuedAt: now, expiresAt };
  }

  /**
   * Look up an unused, unexpired nonce for the wallet and mark it used. If `nonce`
   * is given it must match; otherwise the most recent live nonce for the wallet is used.
   * Returns null when nothing is live. Single use: a second call for the same nonce fails.
   */
  consume(wallet: string, nonce?: string, now = nowSec()): IssuedNonce | null {
    const row = (
      nonce
        ? this.db.prepare(`SELECT * FROM auth_nonces WHERE nonce = ? AND wallet = ?`).get(nonce, wallet)
        : this.db
            .prepare(`SELECT * FROM auth_nonces WHERE wallet = ? AND used_at IS NULL ORDER BY issued_at DESC, rowid DESC LIMIT 1`)
            .get(wallet)
    ) as { nonce: string; wallet: string; domain: string; issued_at: number; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at !== null || row.expires_at < now) return null;
    const res = this.db.prepare(`UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL`).run(now, row.nonce);
    if (res.changes !== 1) return null;
    return { nonce: row.nonce, wallet: row.wallet, domain: row.domain, issuedAt: row.issued_at, expiresAt: row.expires_at };
  }
}

export interface LoginMessageParts {
  domain: string;
  uri: string;
  wallet: string;
  nonce: string;
  /** unix seconds */
  issuedAt: number;
  expiresAt?: number;
}

/**
 * SIWE/SIWS-style sign-in message. Wallets display this text; the server rebuilds it
 * from the stored nonce row and verifies the signature over the exact bytes.
 */
export function loginMessage(p: LoginMessageParts): string {
  const lines = [
    `${p.domain} wants you to sign in with your wallet:`,
    p.wallet,
    '',
    'Sign in to Mesh. This request will not trigger a blockchain transaction or cost any fees.',
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date(p.issuedAt * 1000).toISOString()}`,
  ];
  if (p.expiresAt) lines.push(`Expiration Time: ${new Date(p.expiresAt * 1000).toISOString()}`);
  return lines.join('\n');
}

/** Parse the fields we check out of a message (domain, wallet, nonce, issuedAt). */
export function parseLoginMessage(message: string): { domain: string; wallet: string; nonce: string; issuedAt: number } | null {
  const lines = message.split('\n');
  const m = /^(.+) wants you to sign in with your wallet:$/.exec(lines[0] ?? '');
  if (!m) return null;
  const wallet = lines[1]?.trim();
  const nonce = lines.find((l) => l.startsWith('Nonce: '))?.slice(7).trim();
  const issued = lines.find((l) => l.startsWith('Issued At: '))?.slice(11).trim();
  if (!wallet || !nonce || !issued) return null;
  const issuedAt = Math.floor(Date.parse(issued) / 1000);
  if (!Number.isFinite(issuedAt)) return null;
  return { domain: m[1], wallet, nonce, issuedAt };
}

/**
 * Challenge a node operator signs to prove the reward wallet is theirs (POST /nodes/register).
 * Deliberately a different first line from the sign-in message so a sign-in signature can never
 * be replayed as a registration (and vice versa): both verifiers rebuild their own text.
 */
export function registerMessage(p: LoginMessageParts & { nodeId?: string | null }): string {
  const lines = [
    `${p.domain} wants to register a Mesh node paid to:`,
    p.wallet,
    '',
    'Register this machine as a Mesh node. Rewards for jobs it serves accrue to the wallet above. No transaction, no fee.',
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date(p.issuedAt * 1000).toISOString()}`,
  ];
  if (p.expiresAt) lines.push(`Expiration Time: ${new Date(p.expiresAt * 1000).toISOString()}`);
  if (p.nodeId) lines.push(`Node ID: ${p.nodeId}`);
  return lines.join('\n');
}

/** Constant-time string equality (hashes both sides so lengths never leak). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ---------- session JWT ----------

export const SESSION_TTL_SEC = 7 * 24 * 3600;

export async function signSession(secret: string, wallet: string, chain: string): Promise<string> {
  return new SignJWT({ chain })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(wallet)
    .setIssuedAt()
    .setIssuer('mesh-gateway')
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(new TextEncoder().encode(secret));
}

/**
 * Verify a session JWT. `secret` may be a list (current first, previous second) so sessions
 * survive a JWT_SECRET rotation; the first secret that validates wins. Tokens that carry an
 * audience (admin sessions) are never wallet sessions.
 */
export async function verifySession(
  secret: string | string[],
  token: string,
): Promise<{ wallet: string; chain: string; exp?: number } | null> {
  const secrets = Array.isArray(secret) ? secret : [secret];
  for (const s of secrets) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(s), { issuer: 'mesh-gateway', algorithms: ['HS256'] });
      if (!payload.sub || payload.aud !== undefined) return null;
      return { wallet: payload.sub, chain: String(payload.chain ?? 'unknown'), exp: payload.exp };
    } catch {
      /* try the next secret */
    }
  }
  return null;
}

// ---------- admin session (cookie set by POST /admin/login) ----------

export const ADMIN_SESSION_TTL_SEC = 12 * 3600;
const ADMIN_AUDIENCE = 'mesh-admin';

/** Short-lived JWT proving the admin token was presented; the cookie never carries ADMIN_TOKEN itself. */
export async function signAdminSession(secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin')
    .setAudience(ADMIN_AUDIENCE)
    .setIssuedAt()
    .setIssuer('mesh-gateway')
    .setExpirationTime(`${ADMIN_SESSION_TTL_SEC}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAdminSession(secret: string | string[], token: string): Promise<{ exp?: number } | null> {
  const secrets = Array.isArray(secret) ? secret : [secret];
  for (const s of secrets) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(s), { issuer: 'mesh-gateway', audience: ADMIN_AUDIENCE, algorithms: ['HS256'] });
      if (payload.sub !== 'admin') return null;
      return { exp: payload.exp };
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------- cookies & CSRF ----------

export const SESSION_COOKIE = 'mesh_session';
export const CSRF_COOKIE = 'mesh_csrf';
export const CSRF_HEADER = 'x-mesh-csrf';
export const ADMIN_COOKIE = 'mesh_admin';

/** Parse a Cookie request header. Later duplicates win; values are URI-decoded when possible. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  /** Seconds; 0 deletes the cookie. */
  maxAge?: number;
  path?: string;
  domain?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`];
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
    if (o.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Double-submit check: the X-Mesh-CSRF header must equal the mesh_csrf cookie. */
export function csrfOk(cookies: Record<string, string>, header: string | string[] | undefined): boolean {
  const h = Array.isArray(header) ? header[0] : header;
  const c = cookies[CSRF_COOKIE];
  return Boolean(h && c) && safeEqual(h, c);
}

// ---------- API keys ----------

export const API_KEY_PREFIX = 'mesh_sk_';

/** Hash-scheme tag for peppered rows; legacy rows are bare sha256 hex. */
export const KEY_HASH_V1 = 'h1$';

/**
 * API-key lookup hash. With a pepper: `h1$` + HMAC-SHA256(pepper, key), so a dump of `api_keys`
 * alone cannot be matched against candidate keys. Without one: legacy unsalted sha256 (kept for
 * `lookupApiKey`'s lazy migration and for tests of the old scheme).
 */
export function hashApiKey(key: string, pepper?: string | null): string {
  if (!pepper) return createHash('sha256').update(key, 'utf8').digest('hex');
  return `${KEY_HASH_V1}${createHmac('sha256', pepper).update(key, 'utf8').digest('hex')}`;
}

export function isPepperedKeyHash(hash: string): boolean {
  return hash.startsWith(KEY_HASH_V1);
}

export function maskApiKey(prefix: string): string {
  return `${prefix}${'•'.repeat(24)}`;
}

export interface ApiKeyRow {
  id: number;
  key_hash: string;
  key_prefix: string;
  wallet: string;
  /** legacy column; mirrors `name` */
  label: string | null;
  name: string | null;
  spend_limit_usd_micros: number | null;
  spent_usd_micros: number;
  created_at: number;
  revoked: number;
}

export function createApiKey(
  db: Db,
  wallet: string,
  opts: { name?: string | null; spendLimitUsdMicros?: number | null; pepper?: string | null } | string = {},
): { id: number; key: string; prefix: string; name: string | null } {
  const o = typeof opts === 'string' ? { name: opts } : opts;
  const name = o.name ?? null;
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
  const res = db
    .prepare(
      `INSERT INTO api_keys (key_hash, key_prefix, wallet, label, name, spend_limit_usd_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(hashApiKey(key, o.pepper), prefix, wallet, name, name, o.spendLimitUsdMicros ?? null, nowSec());
  return { id: Number(res.lastInsertRowid), key, prefix, name };
}

export function listApiKeys(db: Db, wallet: string): ApiKeyRow[] {
  return db.prepare(`SELECT * FROM api_keys WHERE wallet = ? ORDER BY id DESC`).all(wallet) as ApiKeyRow[];
}

export function getApiKey(db: Db, wallet: string, id: number): ApiKeyRow | null {
  return (db.prepare(`SELECT * FROM api_keys WHERE id = ? AND wallet = ?`).get(id, wallet) as ApiKeyRow | undefined) ?? null;
}

export function updateApiKey(
  db: Db,
  wallet: string,
  id: number,
  patch: { name?: string | null; spendLimitUsdMicros?: number | null },
): ApiKeyRow | null {
  const sets: string[] = [];
  const args: unknown[] = [];
  if ('name' in patch) {
    sets.push('name = ?', 'label = ?');
    args.push(patch.name ?? null, patch.name ?? null);
  }
  if ('spendLimitUsdMicros' in patch) {
    sets.push('spend_limit_usd_micros = ?');
    args.push(patch.spendLimitUsdMicros ?? null);
  }
  if (sets.length) {
    db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ? AND wallet = ?`).run(...args, id, wallet);
  }
  return getApiKey(db, wallet, id);
}

export function revokeApiKey(db: Db, wallet: string, id: number): boolean {
  const res = db.prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ? AND wallet = ? AND revoked = 0`).run(id, wallet);
  return res.changes > 0;
}

/**
 * Resolve a bearer API key to its row (null if unknown or revoked). With a pepper the peppered hash
 * is tried first; a hit on the legacy sha256 hash is re-written to the peppered form on the spot
 * (lazy migration), so `api_keys` ends up fully peppered without a downtime migration.
 */
export function lookupApiKey(db: Db, key: string, pepper?: string | null): ApiKeyRow | null {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const select = db.prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0`);
  if (pepper) {
    const peppered = hashApiKey(key, pepper);
    const hit = select.get(peppered) as ApiKeyRow | undefined;
    if (hit) return hit;
    const legacy = select.get(hashApiKey(key)) as ApiKeyRow | undefined;
    if (!legacy) return null;
    db.prepare(`UPDATE api_keys SET key_hash = ? WHERE id = ? AND key_hash = ?`).run(peppered, legacy.id, legacy.key_hash);
    return { ...legacy, key_hash: peppered };
  }
  const row = select.get(hashApiKey(key)) as ApiKeyRow | undefined;
  return row ?? null;
}

/** True when the key has a limit and has already spent it. */
export function keySpendExhausted(row: Pick<ApiKeyRow, 'spend_limit_usd_micros' | 'spent_usd_micros'>): boolean {
  return row.spend_limit_usd_micros !== null && row.spent_usd_micros >= row.spend_limit_usd_micros;
}

export function publicKeyView(k: ApiKeyRow) {
  return {
    id: k.id,
    masked: maskApiKey(k.key_prefix),
    name: k.name ?? k.label,
    label: k.name ?? k.label,
    spendLimitUsd: k.spend_limit_usd_micros === null ? null : k.spend_limit_usd_micros / 1_000_000,
    spentUsd: k.spent_usd_micros / 1_000_000,
    created_at: k.created_at,
    revoked: k.revoked === 1,
  };
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
