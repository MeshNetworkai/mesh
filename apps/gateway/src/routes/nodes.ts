import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifierFor, type Chain } from '@mesh/chain-adapter';
import { bearer, registerMessage, safeEqual, verifySession } from '../auth.js';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { jwtSecrets } from '../env.js';
import { SMALL_BODY, fixedWindowLimiter } from './auth.js';
import { nodeRewardsTotal } from '../ledger.js';
import { microsToUsd } from '../money.js';
import { isOnline, jobStats24h, recordHeartbeat, uptimePct24h, type JobRow } from '../network.js';
import { HEARTBEAT_EVERY_SEC, NODE_ONLINE_SEC, REPUTATION_WINDOW, nodeModels, nodeReputation, type NodeRow } from '../routing.js';

export const NODE_TOKEN_PREFIX = 'mesh_nt_';
/** Longest a node may long-poll GET /nodes/:id/jobs/next. */
export const MAX_POLL_WAIT_MS = 25_000;

export function hashNodeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Link codes: 8 chars from an alphabet without 0/O/1/I, 15 minutes, single use, bound to the wallet that signed. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_TTL_SEC = 15 * 60;
/** Live (unused, unexpired) codes one wallet may hold at once. */
export const LINK_CODES_PER_WALLET = 5;

export function generateLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  return out;
}

/** Uppercases and strips separators so `abcd-efgh` and `ABCD EFGH` both match `ABCDEFGH`. */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(`link:${normalizeLinkCode(code)}`, 'utf8').digest('hex');
}

interface LinkCodeRow {
  code_hash: string;
  wallet: string;
  chain: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_node_id: string | null;
}

const RegisterBody = z.object({
  /** Reward wallet. Optional when `linkCode` is sent (the code carries the wallet). */
  wallet: z.string().min(1).max(128).optional(),
  /** One-time code from POST /nodes/link (the wallet signed in the browser); replaces nonce+signature. */
  linkCode: z.string().min(LINK_CODE_LENGTH).max(32).optional(),
  chip: z.string().min(1).max(64).optional(),
  ramGb: z.number().positive().optional(),
  models: z.array(z.string().min(1).max(128)).max(100).default([]),
  agentVersion: z.string().min(1).max(32).optional(),
  /** Optional stable id. Re-registering an existing id requires that node's bearer token. */
  nodeId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
  /** Legacy (node-agent 0.1); ignored, nodes pull jobs now. */
  url: z.string().optional(),
  /** Signed registration (config.nodes.requireSignature): wallet signature over the challenge message. */
  signature: z.string().min(1).max(2048).optional(),
  nonce: z.string().min(1).max(64).optional(),
  chain: z.enum(['solana', 'evm']).optional(),
});
const ChallengeBody = z.object({
  wallet: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
});
const LinkBody = z.object({
  nonce: z.string().min(1).max(64),
  signature: z.string().min(1).max(2048),
  chain: z.enum(['solana', 'evm']).optional(),
});
/** Nonce domain tag so a sign-in nonce and a registration nonce can never be swapped. */
const registerDomain = (domain: string) => `${domain}#node-register`;

export function nodesRequireSignature(ctx: Pick<AppContext, 'env' | 'config'>): boolean {
  return ctx.env.NODES_REQUIRE_SIGNATURE ?? ctx.config.nodes.requireSignature;
}
const HeartbeatBody = z
  .object({
    models: z.array(z.string().min(1).max(128)).max(100).optional(),
    busy: z.boolean().optional(),
    loadAvg: z.number().nonnegative().optional(),
    ramGb: z.number().positive().optional(),
    chip: z.string().min(1).max(64).optional(),
  })
  .default({});
const ChunkBody = z.object({ seq: z.number().int().nonnegative(), delta: z.string() });
const DoneBody = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  finishReason: z.string().min(1).max(32).default('stop'),
});
const FailBody = z.object({ error: z.string().min(1).max(500) });
const PollQuery = z.object({ wait: z.coerce.number().int().min(0).max(MAX_POLL_WAIT_MS).default(MAX_POLL_WAIT_MS) });

type NodeReq = FastifyRequest<{ Params: { id: string } }> & { node?: NodeRow };

export function getNode(ctx: AppContext, id: string): NodeRow | null {
  return (ctx.db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(id) as NodeRow | undefined) ?? null;
}

/** Public job view (what the node receives from GET /nodes/:id/jobs/next). */
export function jobView(job: JobRow) {
  const payload = JSON.parse(job.payload) as { messages: unknown[]; params: Record<string, unknown> };
  return {
    jobId: job.job_id,
    model: job.tag,
    requestedModel: job.model,
    messages: payload.messages,
    params: payload.params,
    maxTokens: job.max_tokens,
    deadlineMs: job.deadline_ms,
    attempt: job.attempt,
  };
}

export function nodeStatsView(ctx: AppContext, node: NodeRow) {
  const now = nowSec();
  const s24 = jobStats24h(ctx.db, node.node_id, now);
  const rep = nodeReputation(ctx.db, node.node_id, ctx.config.routing);
  const earned24 = nodeRewardsTotal(ctx.db, { nodeId: node.node_id }, now - 86_400);
  const earnedAll = nodeRewardsTotal(ctx.db, { nodeId: node.node_id });
  const online = isOnline(node, now);
  return {
    nodeId: node.node_id,
    wallet: node.wallet,
    status: !online ? 'offline' : node.busy ? 'busy' : 'idle',
    online,
    busy: node.busy === 1,
    chip: node.chip,
    ramGb: node.ram_gb,
    loadAvg: node.load_avg,
    agentVersion: node.agent_version,
    models: nodeModels(node),
    uptimePct24h: uptimePct24h(ctx.db, node, now),
    jobs24h: s24.jobs,
    jobsDone24h: s24.done,
    jobsFailed24h: s24.failed,
    tokens24h: s24.tokens,
    earnedUsd24h: microsToUsd(earned24.usdMicros),
    earnedUsdTotal: microsToUsd(earnedAll.usdMicros),
    reputation: {
      window: REPUTATION_WINDOW,
      jobs: rep.jobs,
      successRate: rep.successRate,
      avgFirstTokenMs: rep.avgFirstTokenMs,
      eligible: rep.eligible,
      minSuccessRate: ctx.config.routing.minSuccessRate,
    },
    lastSeen: node.last_seen,
    createdAt: node.created_at,
    offlineAfterSec: NODE_ONLINE_SEC,
  };
}

/** Node registry + job protocol for the P2P inference network (docs/NODE_PROTOCOL.md). */
export async function nodeRoutes(app: FastifyInstance, ctx: AppContext) {
  /** preHandler: bearer node token must match nodes.token_hash for :id. */
  async function requireNodeToken(req: NodeReq, reply: FastifyReply) {
    const token = bearer(req.headers.authorization);
    const node = getNode(ctx, req.params.id);
    if (!node) {
      reply.code(404).send({ error: 'unknown_node', message: 'register first' });
      return reply;
    }
    if (!token || !node.token_hash || !safeEqual(hashNodeToken(token), node.token_hash)) {
      reply.code(401).send({ error: 'unauthorized', message: 'node token required' });
      return reply;
    }
    req.node = node;
  }

  /** preHandler: node token OR a wallet session owning the node. */
  async function requireNodeOrOwner(req: NodeReq, reply: FastifyReply) {
    const token = bearer(req.headers.authorization);
    const node = getNode(ctx, req.params.id);
    if (!node) {
      reply.code(404).send({ error: 'unknown_node', message: 'no such node' });
      return reply;
    }
    if (token && node.token_hash && safeEqual(hashNodeToken(token), node.token_hash)) {
      req.node = node;
      return;
    }
    const session = token ? await verifySession(jwtSecrets(ctx.env), token) : null;
    if (session && session.wallet === node.wallet) {
      req.node = node;
      return;
    }
    reply.code(401).send({ error: 'unauthorized', message: 'node token or owning wallet session required' });
    return reply;
  }

  // One shared per-IP bucket for /nodes/register + /challenge (spam registrations).
  const regLimiter = fixedWindowLimiter(ctx.env.NODE_REGISTER_RATE_LIMIT, 3_600_000);
  const regLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = regLimiter.hit(req.ip);
    reply.header('x-ratelimit-limit', String(ctx.env.NODE_REGISTER_RATE_LIMIT));
    reply.header('x-ratelimit-remaining', String(r.remaining));
    if (!r.allowed) {
      reply.header('retry-after', String(Math.ceil(r.resetMs / 1000)));
      reply.code(429).send({ error: 'rate_limited', message: 'Too many node registrations from this address; retry later.', statusCode: 429 });
      return reply;
    }
  };
  const domain = ctx.env.AUTH_DOMAIN;
  const uri = ctx.env.AUTH_URI;

  /**
   * Step 1 of signed registration: a challenge the operator signs with the reward wallet.
   * Same nonce store as /auth (single use, 5 min) under a registration-specific domain tag.
   */
  app.post('/nodes/register/challenge', { preHandler: regLimit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const issued = ctx.nonces.issue(parsed.data.wallet, registerDomain(domain));
    const message = registerMessage({ domain, uri, wallet: issued.wallet, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, nodeId: parsed.data.nodeId ?? null });
    return {
      wallet: issued.wallet,
      nonce: issued.nonce,
      nodeId: parsed.data.nodeId ?? null,
      domain,
      expiresAt: new Date(issued.expiresAt * 1000).toISOString(),
      message,
      requireSignature: nodesRequireSignature(ctx),
      hint: 'Sign `message` with the wallet, then POST /nodes/register with {wallet, nonce, signature, chain?, ...}.',
    };
  });

  /**
   * Link-code flow: the wallet signs the registration challenge in the browser (session JWT + signature)
   * and gets a short one-time code; the Mac then registers with `{linkCode}` and never needs a key.
   */
  app.post('/nodes/link', { preHandler: [regLimit, requireSession(ctx)], bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const session = sessionOf(req);
    const wallet = session.wallet;
    const issued = ctx.nonces.consume(wallet, parsed.data.nonce);
    if (!issued || issued.domain !== registerDomain(domain)) {
      return reply.code(400).send({ error: 'nonce_missing', message: 'challenge missing, expired (5 min), already used, or issued for another wallet/purpose' });
    }
    const chain: Chain = parsed.data.chain ?? (session.chain === 'evm' ? 'evm' : session.chain === 'solana' ? 'solana' : ctx.adapter.chain);
    const expected = registerMessage({ domain, uri, wallet, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, nodeId: null });
    const verify = chain === ctx.adapter.chain ? ctx.adapter.verifyWalletSignature.bind(ctx.adapter) : verifierFor(chain);
    if (!verify(wallet, expected, parsed.data.signature)) {
      return reply.code(401).send({ error: 'bad_signature', message: 'signature does not match the registration challenge for the signed-in wallet' });
    }
    const now = nowSec();
    // Housekeeping + per-wallet cap on live codes (a stolen session cannot mint an unbounded supply).
    ctx.db.prepare(`DELETE FROM node_link_codes WHERE expires_at < ?`).run(now - 86_400);
    const live = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM node_link_codes WHERE wallet = ? AND used_at IS NULL AND expires_at > ?`).get(wallet, now) as { n: number }).n;
    if (live >= LINK_CODES_PER_WALLET) {
      return reply.code(429).send({ error: 'too_many_link_codes', message: `this wallet already has ${live} unused link codes; use one or wait for them to expire (15 min)` });
    }
    const code = generateLinkCode();
    const expiresAt = now + LINK_CODE_TTL_SEC;
    ctx.db
      .prepare(`INSERT INTO node_link_codes (code_hash, wallet, chain, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(hashLinkCode(code), wallet, chain, now, expiresAt);
    req.log.info({ wallet, chain, expiresAt }, 'node link code issued');
    return {
      code,
      wallet,
      chain,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      expiresInSec: LINK_CODE_TTL_SEC,
      hint: `On the Mac: mesh-node setup --link ${code} --gateway <gateway-url>`,
    };
  });

  app.post('/nodes/register', { preHandler: regLimit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { chip, ramGb, models, agentVersion } = parsed.data;
    let nodeId = parsed.data.nodeId;
    let wallet = parsed.data.wallet;
    let walletVerified = false;

    // ---- link code (wallet signed in the browser): validate now, consume right before the insert ----
    let link: LinkCodeRow | null = null;
    if (parsed.data.linkCode) {
      const now = nowSec();
      const row = (ctx.db.prepare(`SELECT * FROM node_link_codes WHERE code_hash = ?`).get(hashLinkCode(parsed.data.linkCode)) as LinkCodeRow | undefined) ?? null;
      if (!row) return reply.code(400).send({ error: 'link_code_invalid', message: 'unknown link code; create a new one from the web app (Run a node → Link a Mac)' });
      if (row.used_at) return reply.code(400).send({ error: 'link_code_used', message: 'this link code was already used; create a new one from the web app' });
      if (row.expires_at <= now) return reply.code(400).send({ error: 'link_code_expired', message: 'this link code expired (15 min); create a new one from the web app' });
      if (wallet && wallet !== row.wallet) {
        return reply.code(400).send({ error: 'link_code_wallet_mismatch', message: 'link code was issued for a different wallet; omit --wallet or use a code from that wallet' });
      }
      link = row;
      wallet = row.wallet;
      walletVerified = true;
    }
    if (!wallet) return reply.code(400).send({ error: 'bad_request', message: 'wallet or linkCode is required' });

    // ---- wallet ownership: signature over the challenge (required unless linked or config/env disable it) ----
    const mustSign = nodesRequireSignature(ctx);
    if (!link && (parsed.data.signature || mustSign)) {
      if (!parsed.data.signature || !parsed.data.nonce) {
        return reply.code(401).send({
          error: 'signature_required',
          message: 'Registration must be signed by the reward wallet: POST /nodes/register/challenge {wallet}, sign `message`, then retry with {nonce, signature}.',
        });
      }
      const issued = ctx.nonces.consume(wallet, parsed.data.nonce);
      if (!issued || issued.domain !== registerDomain(domain)) {
        return reply.code(400).send({ error: 'nonce_missing', message: 'challenge missing, expired (5 min), already used, or issued for another purpose' });
      }
      const chain: Chain = parsed.data.chain ?? ctx.adapter.chain;
      const expected = registerMessage({ domain, uri, wallet, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, nodeId: nodeId ?? null });
      const verify = chain === ctx.adapter.chain ? ctx.adapter.verifyWalletSignature.bind(ctx.adapter) : verifierFor(chain);
      if (!verify(wallet, expected, parsed.data.signature)) {
        return reply.code(401).send({ error: 'bad_signature', message: 'signature does not match the registration challenge for this wallet/nodeId' });
      }
      walletVerified = true;
    }

    if (nodeId) {
      const existing = getNode(ctx, nodeId);
      if (existing?.token_hash) {
        const token = bearer(req.headers.authorization);
        if (!token || !safeEqual(hashNodeToken(token), existing.token_hash)) {
          return reply.code(409).send({ error: 'node_exists', message: 're-registering an existing nodeId requires its node token' });
        }
      }
    } else {
      nodeId = `node_${randomBytes(6).toString('hex')}`;
    }
    const cap = ctx.config.nodes.maxPerWallet;
    if (cap > 0) {
      const owned = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE wallet = ? AND node_id != ?`).get(wallet, nodeId) as { n: number }).n;
      if (owned >= cap) return reply.code(429).send({ error: 'too_many_nodes', message: `this wallet already has ${owned} nodes (max ${cap})` });
    }
    const nodeToken = `${NODE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const ts = nowSec();
    if (link) {
      // Single use, atomically: a concurrent register with the same code loses here.
      const consumed = ctx.db
        .prepare(`UPDATE node_link_codes SET used_at = ?, used_node_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
        .run(ts, nodeId, link.code_hash, ts);
      if (consumed.changes !== 1) return reply.code(400).send({ error: 'link_code_used', message: 'this link code was just used or expired; create a new one from the web app' });
    }
    ctx.db
      .prepare(
        `INSERT INTO nodes (node_id, wallet, url, models, ram_gb, chip, busy, created_at, last_seen, token_hash, agent_version)
         VALUES (?, ?, '', ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET wallet=excluded.wallet, models=excluded.models,
           ram_gb=COALESCE(excluded.ram_gb, nodes.ram_gb), chip=COALESCE(excluded.chip, nodes.chip),
           agent_version=COALESCE(excluded.agent_version, nodes.agent_version),
           token_hash=excluded.token_hash, busy=0, last_seen=excluded.last_seen`,
      )
      .run(nodeId, wallet, JSON.stringify(models), ramGb ?? null, chip ?? null, ts, ts, hashNodeToken(nodeToken), agentVersion ?? null);
    recordHeartbeat(ctx.db, nodeId, false, ts);
    req.log.info({ nodeId, wallet, chip, models, signed: Boolean(parsed.data.signature), linked: Boolean(link) }, 'node registered');
    return {
      nodeId,
      nodeToken,
      wallet,
      registered: true,
      walletVerified,
      linked: Boolean(link),
      heartbeatEverySec: HEARTBEAT_EVERY_SEC,
      offlineAfterSec: NODE_ONLINE_SEC,
      pollMaxWaitMs: MAX_POLL_WAIT_MS,
    };
  });

  app.post<{ Params: { id: string } }>('/nodes/:id/heartbeat', { preHandler: requireNodeToken, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = HeartbeatBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const hb = parsed.data;
    const ts = nowSec();
    const sets = ['last_seen = ?'];
    const args: unknown[] = [ts];
    if (hb.models) {
      sets.push('models = ?');
      args.push(JSON.stringify(hb.models));
    }
    if (hb.ramGb !== undefined) {
      sets.push('ram_gb = ?');
      args.push(hb.ramGb);
    }
    if (hb.chip !== undefined) {
      sets.push('chip = ?');
      args.push(hb.chip);
    }
    if (hb.loadAvg !== undefined) {
      sets.push('load_avg = ?');
      args.push(hb.loadAvg);
    }
    if (hb.busy !== undefined) {
      sets.push('busy = ?');
      args.push(hb.busy ? 1 : 0);
    }
    ctx.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE node_id = ?`).run(...args, req.params.id);
    recordHeartbeat(ctx.db, req.params.id, hb.busy ?? (req as NodeReq).node!.busy === 1, ts);
    const queued = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`).get() as { n: number }).n;
    return { nodeId: req.params.id, ok: true, heartbeatEverySec: HEARTBEAT_EVERY_SEC, offlineAfterSec: NODE_ONLINE_SEC, queuedJobs: queued };
  });

  /** Long-poll for the next job (204 when none within `wait` ms). */
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>('/nodes/:id/jobs/next', { preHandler: requireNodeToken }, async (req, reply) => {
    const q = PollQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_request', issues: q.error.issues });
    const node = (req as NodeReq).node!;
    ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = ?`).run(nowSec(), node.node_id);
    const job = await ctx.broker.pull(node, q.data.wait);
    if (!job) return reply.code(204).send();
    req.log.info({ nodeId: node.node_id, jobId: job.job_id, tag: job.tag }, 'job claimed');
    return jobView(job);
  });

  app.post<{ Params: { id: string; jobId: string } }>('/nodes/:id/jobs/:jobId/chunk', { preHandler: requireNodeToken, bodyLimit: 256 * 1024 }, async (req, reply) => {
    const parsed = ChunkBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const ok = ctx.broker.chunk(req.params.jobId, req.params.id, parsed.data.seq, parsed.data.delta);
    if (!ok) return reply.code(409).send({ error: 'job_not_running', message: 'job is not running on this node; stop generating' });
    return { ok: true };
  });

  app.post<{ Params: { id: string; jobId: string } }>('/nodes/:id/jobs/:jobId/done', { preHandler: requireNodeToken, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = DoneBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const ok = ctx.broker.done(req.params.jobId, req.params.id, parsed.data);
    if (!ok) return reply.code(409).send({ error: 'job_not_running', message: 'job is not running on this node' });
    return { ok: true };
  });

  app.post<{ Params: { id: string; jobId: string } }>('/nodes/:id/jobs/:jobId/fail', { preHandler: requireNodeToken, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = FailBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const ok = ctx.broker.nodeFail(req.params.jobId, req.params.id, parsed.data.error);
    if (!ok) return reply.code(409).send({ error: 'job_not_running', message: 'job is not running on this node' });
    return { ok: true };
  });

  /** Public summary: no wallets or tokens. */
  app.get('/nodes', async () => {
    const rows = ctx.db.prepare(`SELECT * FROM nodes ORDER BY last_seen DESC LIMIT 500`).all() as NodeRow[];
    const now = nowSec();
    const online = rows.filter((r) => isOnline(r, now));
    const chips: Record<string, number> = {};
    const models: Record<string, number> = {};
    let ramGb = 0;
    let busy = 0;
    for (const n of online) {
      const chip = n.chip ?? 'unknown';
      chips[chip] = (chips[chip] ?? 0) + 1;
      for (const m of nodeModels(n)) models[m] = (models[m] ?? 0) + 1;
      ramGb += n.ram_gb ?? 0;
      if (n.busy) busy += 1;
    }
    const s24 = jobStats24h(ctx.db, undefined, now);
    const requests24h = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log WHERE created_at >= ?`).get(now - 86_400) as { n: number }).n;
    return {
      online: online.length,
      total: rows.length,
      busy,
      idle: online.length - busy,
      totalRamGb: ramGb,
      chips,
      models,
      jobs24h: s24.jobs,
      servedByNetwork24h: s24.done,
      tokens24h: s24.tokens,
      servedByNetworkPercent: requests24h === 0 ? 0 : Math.round((s24.done / requests24h) * 10_000) / 100,
      offlineAfterSec: NODE_ONLINE_SEC,
      heartbeatEverySec: HEARTBEAT_EVERY_SEC,
    };
  });

  /** Per-node stats: node token or the owning wallet's session. */
  app.get<{ Params: { id: string } }>('/nodes/:id', { preHandler: requireNodeOrOwner }, async (req) => {
    return nodeStatsView(ctx, (req as NodeReq).node!);
  });
}
