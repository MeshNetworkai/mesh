import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createAdapter } from '@mesh/chain-adapter';
import { loadModelPolicy, loadModelPrices, loadTokenomics } from '@mesh/config';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AlertMonitor, alertRoutes, senderFromEnv } from './alerts.js';
import { randomUUID } from 'node:crypto';
import { ADMIN_COOKIE, CSRF_HEADER, NonceStore, SESSION_COOKIE, csrfOk } from './auth.js';
import { cookiesOf, type AppContext } from './context.js';
import { openDb, recordAdminAction, recordError } from './db.js';
import { adminIpAllowlist, corsOrigin, loadEnv, productionProblems, trustedProxyCidrs, type Env } from './env.js';
import { geoBlockHook } from './geoblock.js';
import { cidrMatcher } from './netaddr.js';
import { JobBroker } from './network.js';
import { isTrustedNode, reputationConfig } from './routing.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { guestRoutes } from './routes/guest.js';
import { installRoutes, type InstallOptions } from './routes/install.js';
import { keyRoutes } from './routes/keys.js';
import { marketRoutes } from './routes/market.js';
import { meRoutes } from './routes/me.js';
import { nodeRoutes } from './routes/nodes.js';
import { openapiRoutes } from './routes/openapi.js';
import { pointsRoutes } from './routes/points.js';
import { referralRoutes } from './routes/referrals.js';
import { reportRoutes } from './routes/report.js';
import { stakeRoutes } from './routes/stake.js';
import { statsRoutes } from './routes/stats.js';
import { v1Routes } from './routes/v1.js';
import { StakeResolver } from './staking.js';
import { createUpstream } from './upstream.js';
import { Verifier } from './verification.js';
import { waitlistRoutes } from './routes/waitlist.js';

export interface BuildOptions {
  env?: Partial<Env>;
  /** Override pieces of the context (tests inject ':memory:' db, custom adapter, etc). */
  context?: Partial<AppContext>;
  logger?: boolean | object;
  /** Test hooks for /install/* (fake fetch, clock). */
  install?: InstallOptions;
}

export function createContext(opts: BuildOptions = {}): AppContext {
  const env = { ...loadEnv(), ...opts.env } as Env;
  const problems = productionProblems(env);
  if (problems.length) throw new Error(`refusing to start in production:\n - ${problems.join('\n - ')}`);
  const loaded = opts.context?.config ?? loadTokenomics();
  // VERIFICATION_ENABLED (env) overrides config.verification.enabled, like NODES_REQUIRE_SIGNATURE does for registration.
  const config = env.VERIFICATION_ENABLED === undefined ? loaded : { ...loaded, verification: { ...loaded.verification, enabled: env.VERIFICATION_ENABLED } };
  const adapter = opts.context?.adapter ?? createAdapter(config, { mock: env.MESH_ADAPTER === 'mock' });
  const db = opts.context?.db ?? openDb(env.MESH_DB_PATH);
  const stakes = opts.context?.stakes ?? new StakeResolver({ adapter, config });
  // Trusted-tier jobs (docs/PRIVACY.md) may only be claimed by trusted nodes; the broker asks here.
  const broker = opts.context?.broker ?? new JobBroker(db, () => reputationConfig(config), (node) => isTrustedNode({ config, stakes }, node));
  // Jobs left queued/running by a previous process can never complete: fail them now.
  broker.reapExpired(Number.MAX_SAFE_INTEGER);
  const upstream = opts.context?.upstream ?? createUpstream(env);
  const ctx: AppContext = {
    broker,
    env,
    config,
    adapter,
    db,
    prices: opts.context?.prices ?? loadModelPrices(),
    policy: opts.context?.policy ?? loadModelPolicy(),
    upstream,
    nonces: opts.context?.nonces ?? new NonceStore(db),
    stakes,
  };
  // Spot-check verification (verification.ts) re-runs sampled jobs after the client has its answer.
  ctx.verifier = opts.context?.verifier ?? new Verifier({ db, config, stakes, broker, upstream });
  return ctx;
}

/** One JSON shape for every unexpected error; OpenAI shape under /v1 so SDKs can parse it. */
export function errorHandler(ctx: AppContext) {
  return (err: FastifyError & { validation?: unknown }, req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const code =
      status === 429
        ? 'rate_limited'
        : status === 415
          ? 'unsupported_media_type'
          : status === 400
            ? 'bad_request'
            : status === 413
              ? 'payload_too_large'
              : status >= 500
                ? 'internal_error'
                : (err.code ?? 'error').toString().toLowerCase();
    const message = status >= 500 ? 'Internal error. The request was not charged.' : err.message;
    if (status >= 500) {
      req.log.error({ err, reqId: req.id }, 'unhandled error');
      recordError(ctx.db, { route: `${req.method} ${req.url}`, status, code, message: err.message });
    } else {
      req.log.warn({ err: err.message, status, reqId: req.id }, 'request error');
    }
    if (reply.sent) return;
    reply.code(status);
    if (req.url.startsWith('/v1')) {
      return reply.send({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code, param: null } });
    }
    return reply.send({ error: code, message, statusCode: status, requestId: req.id });
  };
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance & { ctx: AppContext }> {
  const ctx = createContext(opts);
  const trustedCidrs = trustedProxyCidrs(ctx.env);
  const trustedPeer = trustedCidrs === null ? () => true : cidrMatcher(trustedCidrs).has;
  const adminCidrs = adminIpAllowlist(ctx.env);
  const adminAllowed = adminCidrs.length ? cidrMatcher(adminCidrs) : null;
  const app = Fastify({
    logger: opts.logger ?? {
      level: ctx.env.LOG_LEVEL,
      // Never let a bearer (API key, node token, session) or admin token reach the log.
      redact: { paths: ['req.headers.authorization', 'req.headers["x-admin-token"]', 'headers.authorization', 'err.config.headers.authorization'], censor: '[redacted]' },
    },
    // X-Forwarded-For (and so req.ip, rate-limit keys, the admin allowlist) is believed only when the
    // TCP peer is in TRUSTED_PROXY_CIDRS; `*` keeps the old trust-everyone behaviour for dev.
    trustProxy: trustedCidrs === null ? true : trustedCidrs,
    bodyLimit: ctx.env.BODY_LIMIT_BYTES,
    // Request ids: honour an upstream `x-request-id` (the proxy's), else mint one; echoed on every
    // response and included in error bodies + logs so a user report can be matched to a log line.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  if (ctx.verifier) ctx.verifier.log = app.log;
  app.setErrorHandler(errorHandler(ctx));
  app.addHook('onSend', async (req, reply) => {
    if (!reply.hasHeader('x-request-id')) reply.header('x-request-id', req.id);
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404);
    if (req.url.startsWith('/v1')) {
      return reply.send({ error: { message: `Unknown route ${req.method} ${req.url}`, type: 'invalid_request_error', code: 'not_found', param: null } });
    }
    return reply.send({ error: 'not_found', message: `Unknown route ${req.method} ${req.url}`, statusCode: 404 });
  });

  app.addHook('onRequest', geoBlockHook({ enforce: ctx.env.GEO_BLOCK_ENFORCE, blocked: ctx.config.geoBlock, trustedPeer }));

  // ADMIN_IP_ALLOWLIST: /admin/* and /health/alerts only from the listed CIDRs (req.ip honours
  // X-Forwarded-For only from trusted proxies, see trustProxy above). Denials are audited.
  if (adminAllowed) {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (!isAdminPath(path)) return;
      if (adminAllowed.has(req.ip)) return;
      req.log.warn({ ip: req.ip, path, reqId: req.id }, 'admin request from outside ADMIN_IP_ALLOWLIST');
      recordAdminAction(ctx.db, 'admin-denied-ip', { ip: req.ip, path, method: req.method, requestId: req.id });
      reply.code(403).send({ error: 'forbidden', message: 'admin access is not allowed from this address', statusCode: 403, requestId: req.id });
      return reply;
    });
  }

  // CSRF (double submit): a state-changing request authenticated by a cookie (no bearer / admin
  // header) must carry X-Mesh-CSRF equal to the mesh_csrf cookie. Header-authenticated API clients
  // are immune by construction and skip the check; so do the routes that authenticate by signature.
  app.addHook('onRequest', async (req, reply) => {
    if (!csrfApplies(req)) return;
    if (csrfOk(cookiesOf(req), req.headers[CSRF_HEADER])) return;
    reply.code(403).send({ error: 'csrf_mismatch', message: `cookie-authenticated ${req.method} needs the ${CSRF_HEADER} header matching the mesh_csrf cookie`, statusCode: 403, requestId: req.id });
    return reply;
  });
  // /admin/dev-login mints sessions for any wallet; it does not exist in production unless ALLOW_DEV_LOGIN=true.
  if (!ctx.env.ALLOW_DEV_LOGIN) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.split('?')[0] === '/admin/dev-login') {
        reply.code(404).send({ error: 'not_found', message: 'dev-login is disabled (ALLOW_DEV_LOGIN)', statusCode: 404 });
        return reply;
      }
    });
  }

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false, // JSON/SSE API; no HTML is served
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // the web app is on another origin
    hsts: ctx.env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: false } : false,
  });
  await app.register(cors, {
    origin: corsOrigin(ctx.env),
    // Cookie sessions: the browser only sends/accepts cookies cross-origin when this is set and the
    // origin is explicit (CORS_ORIGINS); `*` cannot be combined with credentials by the browser.
    credentials: true,
    exposedHeaders: ['x-mesh-cost-usd', 'x-mesh-balance-usd', 'x-mesh-route', 'x-mesh-fallback', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after', 'x-request-id', 'x-guest-remaining', 'x-mesh-privacy', 'x-mesh-served-by'],
  });
  await app.register(rateLimit, { global: false });

  if (ctx.env.ALERTS_ENABLED && !ctx.alerts) {
    ctx.alerts = new AlertMonitor({
      db: ctx.db,
      config: ctx.config,
      env: ctx.env,
      sender: senderFromEnv(ctx.env, app.log),
      log: app.log,
      thresholds: { dbMaxBytes: ctx.env.ALERT_DB_MAX_MB * 1024 * 1024, diskMinFreePct: ctx.env.ALERT_DISK_MIN_FREE_PCT },
    });
  }
  await app.register(alertRoutes, ctx);

  await app.register(statsRoutes, ctx);
  await app.register(openapiRoutes, ctx);
  await app.register(async (inst) => installRoutes(inst, ctx, opts.install ?? {}));
  await app.register(reportRoutes, ctx);
  await app.register(authRoutes, ctx);
  await app.register(waitlistRoutes, ctx);
  await app.register(keyRoutes, ctx);
  await app.register(meRoutes, ctx);
  await app.register(stakeRoutes, ctx);
  await app.register(marketRoutes, ctx);
  await app.register(v1Routes, ctx);
  await app.register(guestRoutes, ctx);
  await app.register(adminRoutes, ctx);
  await app.register(nodeRoutes, ctx);
  await app.register(pointsRoutes, ctx);
  await app.register(referralRoutes, ctx);

  // Heartbeat prune + expired-job reap once a minute (docs/LOADTEST.md bottleneck 5), off the request path.
  ctx.broker.startMaintenance();

  app.addHook('onClose', async () => {
    ctx.alerts?.stop();
    ctx.broker.stop();
    ctx.db.close();
  });

  return Object.assign(app, { ctx }) as FastifyInstance & { ctx: AppContext };
}

export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path === '/health/alerts';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes authenticated by something other than a cookie (signature, admin token in the body/header). */
const CSRF_EXEMPT = new Set(['/auth/nonce', '/auth/verify', '/admin/login', '/nodes/register', '/nodes/register/challenge', '/waitlist']);

/** True when the request is a cookie-authenticated state change that must pass the CSRF check. */
export function csrfApplies(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  if (req.headers.authorization || req.headers['x-admin-token']) return false; // header auth: not CSRF-able
  const path = req.url.split('?')[0];
  if (CSRF_EXEMPT.has(path) || path.startsWith('/v1/')) return false;
  const cookies = cookiesOf(req);
  return Boolean(cookies[SESSION_COOKIE] || cookies[ADMIN_COOKIE]);
}
