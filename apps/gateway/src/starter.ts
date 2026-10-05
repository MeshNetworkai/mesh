import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { nowSec, type Db } from './db.js';
import { addLedgerEntry, balanceMicros, ensureWallet } from './ledger.js';
import { microsToUsd, usdToMicros } from './money.js';
import { hashIp } from './routes/guest.js';

/**
 * Starter credits on first connect (docs/SWITCHING.md, config.starterCredits).
 *
 * A developer arriving from another OpenAI-compatible gateway should be able to point their client at Mesh
 * and send a request in the same minute. So the first time a wallet ever signs in, the gateway credits a
 * small USD amount to it with the existing `starter` ledger kind (the same kind the admin batch flow uses),
 * ref `starter:auto`. The grant is recorded in `starter_grants` (wallet UNIQUE) so it happens once per
 * wallet, counted against `maxWallets`, and capped per client-IP hash per rolling day against sybil farming.
 * Admins can pause/resume the programme at runtime; the override lives in `starter_settings`.
 */

export const STARTER_REF = 'starter:auto';
const DAY_SEC = 86_400;
const ENABLED_KEY = 'enabled';

export type StarterSkipReason = 'disabled' | 'already_granted' | 'cap_reached' | 'ip_capped' | 'min_hold' | 'zero_amount';

export interface StarterGrantRow {
  wallet: string;
  amount_micros: number;
  granted_at: number;
  ip_hash: string;
}

export interface StarterStatus {
  /** Effective state: config.enabled unless an admin override is set. */
  enabled: boolean;
  /** What config/tokenomics.json says. */
  configEnabled: boolean;
  /** Admin override from POST /admin/starter/toggle (null = none). */
  override: boolean | null;
  amountUsd: number;
  maxWallets: number;
  requireMinHold: boolean;
  maxPerIpPerDay: number;
  granted: number;
  /** Wallets that may still receive the grant (null when maxWallets is 0 = unlimited). */
  remaining: number | null;
  grantedUsd: number;
}

/** Admin override: true/false, or null when the config value stands. */
export function starterOverride(db: Db): boolean | null {
  const row = db.prepare(`SELECT value FROM starter_settings WHERE key = ?`).get(ENABLED_KEY) as { value: string } | undefined;
  if (!row) return null;
  return row.value === '1';
}

/** Set (true/false) or clear (null) the runtime override. */
export function setStarterOverride(db: Db, enabled: boolean | null): void {
  if (enabled === null) {
    db.prepare(`DELETE FROM starter_settings WHERE key = ?`).run(ENABLED_KEY);
    return;
  }
  db.prepare(
    `INSERT INTO starter_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ENABLED_KEY, enabled ? '1' : '0', nowSec());
}

export function starterEnabled(ctx: AppContext): boolean {
  const o = starterOverride(ctx.db);
  return o === null ? ctx.config.starterCredits.enabled : o;
}

export function starterGrantCount(db: Db): { granted: number; grantedMicros: number } {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros),0) AS v FROM starter_grants`).get() as { n: number; v: number };
  return { granted: row.n, grantedMicros: row.v };
}

export function starterStatus(ctx: AppContext): StarterStatus {
  const c = ctx.config.starterCredits;
  const { granted, grantedMicros } = starterGrantCount(ctx.db);
  return {
    enabled: starterEnabled(ctx),
    configEnabled: c.enabled,
    override: starterOverride(ctx.db),
    amountUsd: c.amountUsd,
    maxWallets: c.maxWallets,
    requireMinHold: c.requireMinHold,
    maxPerIpPerDay: c.maxPerIpPerDay,
    granted,
    remaining: c.maxWallets === 0 ? null : Math.max(0, c.maxWallets - granted),
    grantedUsd: microsToUsd(grantedMicros),
  };
}

/** Public slice for GET /stats. */
export function starterStatsView(ctx: AppContext): { enabled: boolean; amountUsd: number; granted: number; remaining: number | null } {
  const s = starterStatus(ctx);
  return { enabled: s.enabled, amountUsd: s.amountUsd, granted: s.granted, remaining: s.remaining };
}

export function listStarterGrants(db: Db, limit = 200): StarterGrantRow[] {
  return db.prepare(`SELECT wallet, amount_micros, granted_at, ip_hash FROM starter_grants ORDER BY granted_at DESC, wallet LIMIT ?`).all(limit) as StarterGrantRow[];
}

/** Does `wallet` hold at least config.minHoldTokens right now? Any adapter error counts as "no". */
async function holdsMinimum(ctx: AppContext, wallet: string): Promise<boolean> {
  try {
    const now = nowSec();
    const balances = await ctx.adapter.getHolderBalances({ from: now - ctx.config.epochSeconds, to: now });
    const mine = balances.find((b) => b.wallet === wallet);
    return (mine?.timeWeightedBalance ?? 0) >= ctx.config.minHoldTokens;
  } catch {
    return false;
  }
}

export type StarterGrantResult = { granted: true; amountUsd: number; ledgerId: number; balanceUsd: number } | { granted: false; reason: StarterSkipReason };

/**
 * Called after a successful wallet sign-in. Grants the starter credit when every condition holds; otherwise
 * says why not. Never throws into the sign-in path: the caller treats a failure as "no grant".
 */
export async function maybeGrantStarter(ctx: AppContext, input: { wallet: string; chain: string; ip: string; now?: number }): Promise<StarterGrantResult> {
  const c = ctx.config.starterCredits;
  if (!starterEnabled(ctx)) return { granted: false, reason: 'disabled' };
  const micros = usdToMicros(c.amountUsd);
  if (micros <= 0) return { granted: false, reason: 'zero_amount' };
  const db = ctx.db;
  const now = input.now ?? nowSec();
  const ipHash = hashIp(input.ip || 'unknown', ctx.env.KEY_PEPPER);

  // Cheap checks first (no chain call) so a repeat sign-in costs one indexed lookup.
  if (db.prepare(`SELECT 1 FROM starter_grants WHERE wallet = ?`).get(input.wallet)) return { granted: false, reason: 'already_granted' };
  if (c.maxWallets > 0 && starterGrantCount(db).granted >= c.maxWallets) return { granted: false, reason: 'cap_reached' };
  const ipCount = (db.prepare(`SELECT COUNT(*) AS n FROM starter_grants WHERE ip_hash = ? AND granted_at >= ?`).get(ipHash, now - DAY_SEC) as { n: number }).n;
  if (ipCount >= c.maxPerIpPerDay) return { granted: false, reason: 'ip_capped' };
  if (c.requireMinHold && !(await holdsMinimum(ctx, input.wallet))) return { granted: false, reason: 'min_hold' };

  // Re-check the per-wallet and total caps inside the write so two concurrent first sign-ins cannot double-grant.
  const tx = db.transaction((): StarterGrantResult => {
    if (db.prepare(`SELECT 1 FROM starter_grants WHERE wallet = ?`).get(input.wallet)) return { granted: false, reason: 'already_granted' };
    if (c.maxWallets > 0 && starterGrantCount(db).granted >= c.maxWallets) return { granted: false, reason: 'cap_reached' };
    ensureWallet(db, input.wallet, input.chain);
    db.prepare(`INSERT INTO starter_grants (wallet, amount_micros, granted_at, ip_hash) VALUES (?, ?, ?, ?)`).run(input.wallet, micros, now, ipHash);
    const ledgerId = addLedgerEntry(db, { wallet: input.wallet, deltaMicros: micros, kind: 'starter', ref: STARTER_REF });
    return { granted: true, amountUsd: microsToUsd(micros), ledgerId, balanceUsd: microsToUsd(balanceMicros(db, input.wallet)) };
  });
  return tx();
}

/**
 * Admin endpoints, registered from routes/admin.ts inside the admin plugin so they share its guard and audit hook.
 *   GET  /admin/starter         status + recent grants
 *   POST /admin/starter/toggle  { enabled: boolean | null }  (null clears the override; audited)
 */
export function starterAdminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  guard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  audit: (req: FastifyRequest, action: string, payload: unknown) => number,
) {
  app.get('/admin/starter', { preHandler: guard }, async () => {
    const status = starterStatus(ctx);
    const grants = listStarterGrants(ctx.db).map((g) => ({ wallet: g.wallet, amountUsd: microsToUsd(g.amount_micros), grantedAt: g.granted_at, ipHash: g.ip_hash.slice(0, 8) }));
    return { ...status, grants };
  });

  app.post('/admin/starter/toggle', { preHandler: guard, bodyLimit: 16 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    let enabled: boolean | null;
    if (body.enabled === undefined) enabled = !starterEnabled(ctx); // bare toggle
    else if (body.enabled === null) enabled = null;
    else if (typeof body.enabled === 'boolean') enabled = body.enabled;
    else return reply.code(400).send({ error: 'bad_request', message: 'enabled must be a boolean or null' });
    const before = starterEnabled(ctx);
    setStarterOverride(ctx.db, enabled);
    const status = starterStatus(ctx);
    audit(req, 'starter-toggle', { before, after: status.enabled, override: status.override });
    return status;
  });
}
