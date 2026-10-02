import type { ChainAdapter } from '@mesh/chain-adapter';
import type { ModelPolicy, ModelPrices, TokenomicsConfig } from '@mesh/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AlertMonitor } from './alerts.js';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SEC,
  CSRF_COOKIE,
  NonceStore,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  bearer,
  newCsrfToken,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifyAdminSession,
  verifySession,
} from './auth.js';
import type { Db } from './db.js';
import { jwtSecrets, type Env } from './env.js';
import type { JobBroker } from './network.js';
import type { StakeResolver } from './staking.js';
import type { Upstream } from './upstream.js';

export interface AppContext {
  db: Db;
  adapter: ChainAdapter;
  config: TokenomicsConfig;
  prices: ModelPrices;
  policy: ModelPolicy;
  env: Env;
  upstream: Upstream;
  nonces: NonceStore;
  /** Node network job queue + live relays. */
  broker: JobBroker;
  /** Ops alerting (alerts.ts); created in buildServer, ticked from index.ts. */
  alerts?: AlertMonitor;
  /** Stake tier resolver (staking.ts): per-epoch cache of wallet → tier/multiplier. */
  stakes?: StakeResolver;
}

export interface Session {
  wallet: string;
  chain: string;
  exp?: number;
  /** How the session reached us: `Authorization: Bearer` (API clients) or the `mesh_session` cookie (web). */
  via?: 'bearer' | 'cookie';
}

/** Where a request's credentials came from, set by the auth preHandlers. */
export type AuthVia = 'bearer' | 'cookie' | 'header';

type AuthedRequest = FastifyRequest & { session?: Session; authVia?: AuthVia; adminAudited?: boolean };

export function cookiesOf(req: FastifyRequest): Record<string, string> {
  const r = req as FastifyRequest & { _cookies?: Record<string, string> };
  if (!r._cookies) r._cookies = parseCookies(req.headers.cookie);
  return r._cookies;
}

/** The session JWT from the bearer header, else from the cookie. Bearer wins so API clients are never confused by a stale cookie. */
export function sessionToken(req: FastifyRequest): { token: string; via: 'bearer' | 'cookie' } | null {
  const b = bearer(req.headers.authorization);
  if (b) return { token: b, via: 'bearer' };
  const c = cookiesOf(req)[SESSION_COOKIE];
  return c ? { token: c, via: 'cookie' } : null;
}

/** Resolve the request's session (bearer or cookie) without failing the request. */
export async function resolveSession(ctx: AppContext, req: FastifyRequest): Promise<Session | null> {
  const t = sessionToken(req);
  if (!t) return null;
  const s = await verifySession(jwtSecrets(ctx.env), t.token);
  return s ? { ...s, via: t.via } : null;
}

/** preHandler: requires a session JWT in `Authorization: Bearer <jwt>` or the `mesh_session` cookie. */
export function requireSession(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await resolveSession(ctx, req);
    if (!session) {
      reply.code(401).send({ error: 'unauthorized', message: 'valid session token required' });
      return reply;
    }
    const r = req as AuthedRequest;
    r.session = session;
    r.authVia = session.via;
  };
}

export function sessionOf(req: FastifyRequest): Session {
  return (req as AuthedRequest).session as Session;
}

export function authViaOf(req: FastifyRequest): AuthVia | undefined {
  return (req as AuthedRequest).authVia;
}

/** Marks that the handler wrote its own audit row, so the generic admin-call audit skips it. */
export function markAdminAudited(req: FastifyRequest): void {
  (req as AuthedRequest).adminAudited = true;
}
export function adminAudited(req: FastifyRequest): boolean {
  return (req as AuthedRequest).adminAudited === true;
}

/** The admin token from `x-admin-token` or bearer (header auth), if any. */
export function adminHeaderToken(req: FastifyRequest): string | null {
  const header = req.headers['x-admin-token'];
  return (Array.isArray(header) ? header[0] : header) ?? bearer(req.headers.authorization);
}

/**
 * preHandler: requires ADMIN_TOKEN via `x-admin-token` header or bearer, or the `mesh_admin` cookie
 * minted by POST /admin/login (an admin-audience JWT, never the token itself).
 */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = adminHeaderToken(req);
    const r = req as AuthedRequest;
    if (token) {
      if (safeEqual(token, ctx.env.ADMIN_TOKEN)) {
        r.authVia = 'header';
        return;
      }
    } else {
      const cookie = cookiesOf(req)[ADMIN_COOKIE];
      if (cookie && (await verifyAdminSession(jwtSecrets(ctx.env), cookie))) {
        r.authVia = 'cookie';
        return;
      }
    }
    reply.code(401).send({ error: 'unauthorized', message: 'admin token required' });
    return reply;
  };
}

// ---------- cookie writers (shared by /auth and /admin) ----------

function cookieBase(env: Env) {
  return { secure: env.COOKIE_SECURE, sameSite: 'Lax' as const, path: '/', domain: env.COOKIE_DOMAIN };
}

/** Set the HttpOnly session cookie plus a fresh readable CSRF cookie (double-submit pair). */
export function setSessionCookies(env: Env, reply: FastifyReply, jwt: string): string {
  const csrf = newCsrfToken();
  appendSetCookie(reply, serializeCookie(SESSION_COOKIE, jwt, { ...cookieBase(env), httpOnly: true, maxAge: SESSION_TTL_SEC }));
  appendSetCookie(reply, serializeCookie(CSRF_COOKIE, csrf, { ...cookieBase(env), httpOnly: false, maxAge: SESSION_TTL_SEC }));
  return csrf;
}

export function clearSessionCookies(env: Env, reply: FastifyReply): void {
  appendSetCookie(reply, serializeCookie(SESSION_COOKIE, '', { ...cookieBase(env), httpOnly: true, maxAge: 0 }));
  appendSetCookie(reply, serializeCookie(CSRF_COOKIE, '', { ...cookieBase(env), httpOnly: false, maxAge: 0 }));
}

/** Admin cookie + its own CSRF cookie (same `mesh_csrf` name: one header works for both consoles). */
export function setAdminCookies(env: Env, reply: FastifyReply, jwt: string): string {
  const csrf = newCsrfToken();
  appendSetCookie(reply, serializeCookie(ADMIN_COOKIE, jwt, { ...cookieBase(env), httpOnly: true, maxAge: ADMIN_SESSION_TTL_SEC }));
  appendSetCookie(reply, serializeCookie(CSRF_COOKIE, csrf, { ...cookieBase(env), httpOnly: false, maxAge: ADMIN_SESSION_TTL_SEC }));
  return csrf;
}

export function clearAdminCookies(env: Env, reply: FastifyReply): void {
  appendSetCookie(reply, serializeCookie(ADMIN_COOKIE, '', { ...cookieBase(env), httpOnly: true, maxAge: 0 }));
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  // Fastify special-cases set-cookie: a second header() call appends instead of replacing.
  reply.header('set-cookie', value);
}
