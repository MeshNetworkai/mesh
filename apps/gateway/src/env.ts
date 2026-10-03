import { z } from 'zod';
import { DEFAULT_TRUSTED_PROXY_CIDRS, parseCidrList } from './netaddr.js';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v.trim())));

export const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me';
export const DEV_ADMIN_TOKEN = 'dev-admin-token';
export const DEV_KEY_PEPPER = 'dev-only-insecure-key-pepper-change-me';

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  MESH_DB_PATH: z.string().default('./data/mesh.db'),
  MESH_ADAPTER: z.enum(['mock', 'chain']).default('mock'),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  /**
   * Previous JWT secret, accepted for verification only, so sessions survive a rotation:
   * set JWT_SECRET_PREVIOUS to the old value, JWT_SECRET to the new one, restart, remove
   * JWT_SECRET_PREVIOUS after 7 days (session TTL).
   */
  JWT_SECRET_PREVIOUS: z.string().min(16).optional(),
  ADMIN_TOKEN: z.string().min(1).default(DEV_ADMIN_TOKEN),
  /** /admin/dev-login mints sessions without a signature; refused in production unless this is true. */
  ALLOW_DEV_LOGIN: bool.optional(),
  /**
   * Server pepper for API-key hashes: key_hash = "h1$" + HMAC-SHA256(pepper, key). Legacy unsalted
   * sha256 rows are re-hashed the first time the key is used. Rotating it invalidates every key that
   * has not been rehashed, so treat it like JWT_SECRET. Required (non-default, >= 32 chars) in production.
   */
  KEY_PEPPER: z.string().min(16).default(DEV_KEY_PEPPER),
  /**
   * CIDRs (comma-separated) allowed to reach /admin/* (and /health/alerts). Unset = no IP check
   * (the Caddy 404 rule and the token still apply). The client IP is taken from X-Forwarded-For only
   * when the connection comes from TRUSTED_PROXY_CIDRS.
   */
  ADMIN_IP_ALLOWLIST: z.string().optional(),
  /**
   * CIDRs whose X-Forwarded-For / CF-IPCountry / X-Country headers are believed. Defaults to
   * loopback + private ranges (the reverse proxy on the same host or docker network). Add your CDN's
   * ranges when it connects directly. `*` trusts every peer (dev only).
   */
  TRUSTED_PROXY_CIDRS: z.string().optional(),
  /** Set the Secure flag on session/CSRF/admin cookies. Defaults to NODE_ENV === 'production'. */
  COOKIE_SECURE: bool.optional(),
  /** Optional Domain attribute for cookies (e.g. `.example.com` to share across subdomains). Host-only when unset. */
  COOKIE_DOMAIN: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  /** Abort an upstream call (connect + full body for non-stream, connect + headers for stream) after this long. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  EPOCH_CRON: z.string().default('0 * * * *'),
  V1_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  /** Requests per minute per IP on /auth/*. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** Registrations per hour per IP on /nodes/register (+ /challenge). */
  NODE_REGISTER_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Requests per minute per IP on POST /waitlist (public beta waitlist). */
  WAITLIST_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  /** Override config.nodes.requireSignature (dev/demo convenience). */
  NODES_REQUIRE_SIGNATURE: bool.optional(),
  /**
   * Comma-separated browser origins allowed by CORS. `*` allows any origin (dev default).
   * In production the default is no browser origin at all, so set it to the web app's origin(s).
   */
  CORS_ORIGINS: z.string().optional(),
  /** Max request body for /v1 (bytes). Other routes use much smaller fixed limits. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  /** Domain written into the sign-in message (SIWE style) and checked on verify. */
  AUTH_DOMAIN: z.string().min(1).default('localhost:8787'),
  /** Statement URI in the sign-in message; defaults to https://AUTH_DOMAIN. */
  AUTH_URI: z.string().url().optional(),
  /** /stats cache TTL; 0 disables (tests). */
  STATS_CACHE_MS: z.coerce.number().int().nonnegative().default(10_000),
  /** Enforce config.geoBlock on /v1 and /auth. Defaults to on in production, off otherwise. */
  GEO_BLOCK_ENFORCE: bool.optional(),
  LOG_LEVEL: z.string().default('info'),
  // ---- alerts (apps/gateway/src/alerts.ts) ----
  ALERTS_ENABLED: bool.default(true),
  ALERT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Telegram delivery; when either is unset alerts go to the log only. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** DB file size alert threshold (MB). */
  ALERT_DB_MAX_MB: z.coerce.number().positive().default(1024),
  /** Free disk alert threshold (percent of the volume holding the DB). */
  ALERT_DISK_MIN_FREE_PCT: z.coerce.number().min(0).max(100).default(10),
});

export type Env = z.infer<typeof EnvSchema> & { GEO_BLOCK_ENFORCE: boolean; AUTH_URI: string; ALLOW_DEV_LOGIN: boolean; COOKIE_SECURE: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(source);
  const env: Env = {
    ...parsed,
    GEO_BLOCK_ENFORCE: parsed.GEO_BLOCK_ENFORCE ?? parsed.NODE_ENV === 'production',
    AUTH_URI: parsed.AUTH_URI ?? `https://${parsed.AUTH_DOMAIN}`,
    ALLOW_DEV_LOGIN: parsed.ALLOW_DEV_LOGIN ?? parsed.NODE_ENV !== 'production',
    COOKIE_SECURE: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
  };
  return env;
}

/** TRUSTED_PROXY_CIDRS as a list; `*` → null (trust every peer); unset → loopback + private ranges. */
export function trustedProxyCidrs(env: Pick<Env, 'TRUSTED_PROXY_CIDRS'>): string[] | null {
  const raw = env.TRUSTED_PROXY_CIDRS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TRUSTED_PROXY_CIDRS;
  if (raw === '*') return null;
  return parseCidrList(raw);
}

/** ADMIN_IP_ALLOWLIST as a list; empty = not enforced. */
export function adminIpAllowlist(env: Pick<Env, 'ADMIN_IP_ALLOWLIST'>): string[] {
  return parseCidrList(env.ADMIN_IP_ALLOWLIST);
}

/** Secrets accepted when verifying a session JWT: current first, then the previous one during a rotation. */
export function jwtSecrets(env: Pick<Env, 'JWT_SECRET' | 'JWT_SECRET_PREVIOUS'>): string[] {
  return env.JWT_SECRET_PREVIOUS && env.JWT_SECRET_PREVIOUS !== env.JWT_SECRET ? [env.JWT_SECRET, env.JWT_SECRET_PREVIOUS] : [env.JWT_SECRET];
}

/**
 * Production misconfigurations that must stop the process before it listens:
 * default/dev secrets, missing CORS allowlist. Returns the list of problems (empty = fine).
 */
export function productionProblems(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  if (env.JWT_SECRET === DEV_JWT_SECRET || env.JWT_SECRET.length < 32) out.push('JWT_SECRET must be a random string of at least 32 characters in production');
  if (env.ADMIN_TOKEN === DEV_ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) out.push('ADMIN_TOKEN must be a random string of at least 24 characters in production');
  if (env.KEY_PEPPER === DEV_KEY_PEPPER || env.KEY_PEPPER.length < 32) out.push('KEY_PEPPER must be a random string of at least 32 characters in production (API-key hash pepper)');
  if (env.AUTH_DOMAIN.startsWith('localhost')) out.push('AUTH_DOMAIN must be the public hostname in production');
  if (env.CORS_ORIGINS === '*') out.push('CORS_ORIGINS must list explicit origins in production (not *)');
  if (env.TRUSTED_PROXY_CIDRS?.trim() === '*') out.push('TRUSTED_PROXY_CIDRS must list the proxy ranges in production (not *)');
  try {
    trustedProxyCidrs(env);
    adminIpAllowlist(env);
  } catch (err) {
    out.push((err as Error).message);
  }
  return out;
}

/** Parse CORS_ORIGINS into what @fastify/cors accepts. */
export function corsOrigin(env: Pick<Env, 'CORS_ORIGINS' | 'NODE_ENV'>): boolean | string[] {
  const raw = env.CORS_ORIGINS?.trim();
  if (raw === undefined || raw === '') return env.NODE_ENV === 'production' ? [] : true;
  if (raw === '*') return true;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
