import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifierFor, type Chain } from '@mesh/chain-adapter';
import { WalletField, bearer, pledgeMessage, registerMessage, safeEqual, verifySession } from '../auth.js';
import { inviteRequired, isAdmitted } from '../beta.js';
import { nodeVerificationStats } from '../verification.js';
import { requireSession, resolveSession, sessionOf, type AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { jwtSecrets } from '../env.js';
import { SMALL_BODY, fixedWindowLimiter } from './auth.js';
import { nodeRewardsTotal } from '../ledger.js';
import { microsToUsd } from '../money.js';
import { JOB_VIEW_FIELDS, isOnline, jobStats24h, recordHeartbeat, uptimePct24h, type JobPayload, type JobRow } from '../network.js';
import { HEARTBEAT_EVERY_SEC, NODE_ONLINE_SEC, REPUTATION_WINDOW, nodeModels, reputationConfig, trustedTierIndex, trustedVia, type NodeRow } from '../routing.js';
import { sampleActivity, sampleConfigured, sampleFleet, sampleInfo, sampleViewFor } from '../sample-data.js';

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
  wallet: WalletField.optional(),
  /** One-time code from POST /nodes/link (the wallet signed in the browser); replaces nonce+signature. */
  linkCode: z.string().min(LINK_CODE_LENGTH).max(32).optional(),
  chip: z.string().min(1).max(64).optional(),
  ramGb: z.number().positive().optional(),
  models: z.array(z.string().min(1).max(128)).max(100).default([]),
  agentVersion: z.string().min(1).max(32).optional(),
  /** Concurrent jobs the node can run (Ollama OLLAMA_NUM_PARALLEL); capped by config routing.maxParallelPerNode. Default 1. */
  maxParallel: z.number().int().min(1).max(64).optional(),
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
  wallet: WalletField,
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
    maxParallel: z.number().int().min(1).max(64).optional(),
  })
  .default({});
/** `seq` is bounded so a node cannot park megabytes in the relay's gap buffer (network.ts caps it too). */
const ChunkBody = z.object({ seq: z.number().int().min(0).max(1_000_000), delta: z.string().max(256 * 1024) });
/** Token counts are what the client is billed and the node is paid for: bounded here and clamped to the job in the broker. */
const DoneBody = z.object({
  promptTokens: z.number().int().min(0).max(10_000_000).default(0),
  completionTokens: z.number().int().min(0).max(10_000_000).default(0),
  finishReason: z.string().min(1).max(32).default('stop'),
});
/** The node's error text ends up in a response header (`x-mesh-fallback`) and the jobs table: control characters are stripped so a node cannot break the client's response with a CR/LF. */
const FailBody = z.object({
  error: z
    .string()
    .min(1)
    .max(500)
    .transform((e) => e.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .pipe(z.string().min(1)),
});
const PledgeBody = z.object({ signature: z.string().min(1).max(2048), chain: z.enum(['solana', 'evm']).optional() });
const PollQuery = z.object({ wait: z.coerce.number().int().min(0).max(MAX_POLL_WAIT_MS).default(MAX_POLL_WAIT_MS) });

type NodeReq = FastifyRequest<{ Params: { id: string } }> & { node?: NodeRow };

export function getNode(ctx: AppContext, id: string): NodeRow | null {
  return (ctx.db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(id) as NodeRow | undefined) ?? null;
}

/**
 * What the node receives from GET /nodes/:id/jobs/next: exactly `JOB_VIEW_FIELDS`, nothing that
 * identifies the caller (no wallet, API key, request id, IP, user agent, client-facing model name).
 * See docs/PRIVACY.md; privacy.test.ts asserts the shape.
 */
export function jobView(job: JobRow): Record<(typeof JOB_VIEW_FIELDS)[number], unknown> {
  const payload = JSON.parse(job.payload) as JobPayload;
  return {
    jobId: job.job_id,
    model: job.tag,
    messages: payload.messages,
    params: payload.params,
    maxTokens: job.max_tokens,
    deadlineMs: job.deadline_ms,
    attempt: job.attempt,
  };
}

/** Operator pledge status + whether the node currently counts as trusted (docs/PRIVACY.md). */
export function pledgeView(ctx: Pick<AppContext, 'config' | 'stakes'>, node: NodeRow) {
  const via = trustedVia(ctx, node);
  const needIdx = trustedTierIndex(ctx.config);
  const stake = ctx.stakes?.peek(node.wallet);
  return {
    signed: node.pledge_at !== null,
    signedAt: node.pledge_at,
    chain: node.pledge_chain,
    trusted: via !== null,
    trustedVia: via,
    allowlisted: ctx.config.privacy.trustedWallets.includes(node.wallet),
    /** Stake tier the wallet needs (with the pledge) to be trusted, and the tier it has. */
    requiredStakeTier: needIdx === null ? null : ctx.config.privacy.trustedMinStakeTier,
    stakeTier: stake?.tier.name ?? null,
    stakeOk: needIdx !== null && (stake?.tierIndex ?? 0) >= needIdx,
  };
}

export function nodeStatsView(ctx: AppContext, node: NodeRow) {
  const now = nowSec();
  const s24 = jobStats24h(ctx.db, node.node_id, now);
  const rep = ctx.broker.reputation(node.node_id, reputationConfig(ctx.config));
  const earned24 = nodeRewardsTotal(ctx.db, { nodeId: node.node_id }, now - 86_400);
  const earnedAll = nodeRewardsTotal(ctx.db, { nodeId: node.node_id });
  const online = isOnline(node, now);
  return {
    nodeId: node.node_id,
    wallet: node.wallet,
    status: !online ? 'offline' : node.busy >= Math.max(1, node.max_parallel) ? 'busy' : 'idle',
    online,
    busy: node.busy >= Math.max(1, node.max_parallel),
    /** Jobs running on the node right now and how many it said it can run at once. */
    runningJobs: ctx.broker.runningOn(node.node_id),
    maxParallel: Math.max(1, node.max_parallel),
    chip: node.chip,
    ramGb: node.ram_gb,
    loadAvg: node.load_avg,
    agentVersion: node.agent_version,
    models: nodeModels(node),
    uptimePct24h: uptimePct24h(ctx.db, node, now),
    quarantined: node.quarantined_at !== null,
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
      mismatches: rep.mismatches,
      eligible: rep.eligible && node.quarantined_at === null,
      minSuccessRate: ctx.config.routing.minSuccessRate,
    },
    /** Spot-check verification (docs/NODE_PROTOCOL.md §10): how often this node's work was re-checked and what came of it. */
    verification: { ...nodeVerificationStats(ctx.db, node), enabled: ctx.config.verification.enabled, sampleRate: ctx.config.verification.sampleRate },
    lastSeen: node.last_seen,
    createdAt: node.created_at,
    offlineAfterSec: NODE_ONLINE_SEC,
    pledge: pledgeView(ctx, node),
  };
}

/** IP backstop for registration: explicit env, else six times the strict budget and at least 60/hour. */
export function nodeRegisterIpLimit(env: Pick<AppContext['env'], 'NODE_REGISTER_RATE_LIMIT' | 'NODE_REGISTER_IP_RATE_LIMIT'>): number {
  return env.NODE_REGISTER_IP_RATE_LIMIT ?? Math.max(60, env.NODE_REGISTER_RATE_LIMIT * 6);
}

/** Fleet summary for GET /nodes: counts, chips, models, 24h jobs. No wallets, tokens or node ids. */
export function nodesSummary(ctx: AppContext) {
  const rows = ctx.db.prepare(`SELECT * FROM nodes ORDER BY last_seen DESC LIMIT 500`).all() as NodeRow[];
  const now = nowSec();
  const online = rows.filter((r) => isOnline(r, now));
  const chips: Record<string, number> = {};
  const models: Record<string, number> = {};
  let ramGb = 0;
  let busy = 0;
  let slots = 0;
  let running = 0;
  for (const n of online) {
    const chip = n.chip ?? 'unknown';
    chips[chip] = (chips[chip] ?? 0) + 1;
    for (const m of nodeModels(n)) models[m] = (models[m] ?? 0) + 1;
    ramGb += n.ram_gb ?? 0;
    const max = Math.max(1, n.max_parallel);
    slots += max;
    running += Math.min(max, n.busy);
    if (n.busy >= max) busy += 1;
  }
  const s24 = jobStats24h(ctx.db, undefined, now);
  const real24h = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log WHERE created_at >= ?`).get(now - 86_400) as { n: number }).n;
  const queued = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`).get() as { n: number }).n;
  // Test mode (MESH_SAMPLE_NODES, sample-data.ts): the simulated Macs join the counts. Empty when off.
  const sample = sampleInfo(ctx);
  const sim = sampleFleet(ctx, now);
  const simActivity = sampleActivity(ctx, now - 86_400, now, now);
  for (const [chip, n] of Object.entries(sim.chips)) chips[chip] = (chips[chip] ?? 0) + n;
  for (const [model, n] of Object.entries(sim.models)) models[model] = (models[model] ?? 0) + n;
  const onlineCount = online.length + sim.nodes;
  const busyCount = busy + sim.busy;
  const served24h = s24.done + simActivity.networkRequests;
  const requests24h = real24h + simActivity.requests;
  return {
    /** Set while the counts include simulated Macs (test mode before the token launch); null otherwise. */
    sample,
    online: onlineCount,
    total: rows.length + sim.nodes,
    busy: busyCount,
    idle: onlineCount - busyCount,
    /** Job slots across online nodes (Σ maxParallel) and how many are in use. */
    slots: slots + sim.slots,
    runningJobs: running + sim.running,
    queuedJobs: queued,
    totalRamGb: ramGb + sim.ramGb,
    chips,
    models,
    jobs24h: s24.jobs + simActivity.networkRequests,
    servedByNetwork24h: served24h,
    tokens24h: s24.tokens + simActivity.networkTokens,
    servedByNetworkPercent: requests24h === 0 ? 0 : Math.round((served24h / requests24h) * 10_000) / 100,
    offlineAfterSec: NODE_ONLINE_SEC,
    heartbeatEverySec: HEARTBEAT_EVERY_SEC,
    generatedAt: now,
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

  // Registration abuse limits (docs/LOADTEST.md bottleneck 8). Two buckets:
  //  - strict (`NODE_REGISTER_RATE_LIMIT`, 10/h): keyed on the *wallet* once the signed or link flow has
  //    proved the operator owns it (so ten Macs behind one NAT are fine), else on the IP (challenges,
  //    unsigned dev registrations);
  //  - IP backstop (`NODE_REGISTER_IP_RATE_LIMIT`, default max(60, 6 × strict)/h) on every call to
  //    /nodes/register, /challenge and /link, so a wallet farm from one address is still bounded.
  const strictLimit = ctx.env.NODE_REGISTER_RATE_LIMIT;
  const ipLimit = nodeRegisterIpLimit(ctx.env);
  const strictLimiter = fixedWindowLimiter(strictLimit, 3_600_000);
  const ipLimiter = fixedWindowLimiter(ipLimit, 3_600_000);
  const tooMany = (reply: FastifyReply, resetMs: number, what: string) => {
    reply.header('retry-after', String(Math.ceil(resetMs / 1000)));
    const mins = Math.max(1, Math.ceil(resetMs / 60_000));
    reply.code(429).send({ error: 'rate_limited', message: `Too many node registration attempts ${what}; try again in about ${mins} min.`, statusCode: 429 });
    return reply;
  };
  /** preHandler: the per-IP backstop. */
  const regLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = ipLimiter.hit(req.ip);
    reply.header('x-ratelimit-limit', String(ipLimit));
    reply.header('x-ratelimit-remaining', String(r.remaining));
    if (!r.allowed) return tooMany(reply, r.resetMs, 'from this address');
  };
  /** Strict bucket, keyed on the proven wallet or (unproven) the IP. Returns the 429 reply when exhausted. */
  const strictHit = (req: FastifyRequest, reply: FastifyReply, wallet: string | null) => {
    const r = strictLimiter.hit(wallet ? `wallet:${wallet}` : `ip:${req.ip}`);
    reply.header('x-ratelimit-limit', String(strictLimit));
    reply.header('x-ratelimit-remaining', String(r.remaining));
    if (!r.allowed) return tooMany(reply, r.resetMs, wallet ? 'for this wallet' : 'from this address');
    return null;
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
    // A signed-in browser asking for a challenge for its own wallet has already proved ownership, so the
    // strict bucket is keyed on the wallet (retrying "Link a Mac" a dozen times must not lock out the
    // whole NAT); anonymous callers (the CLI's signed flow) stay on the IP key.
    const session = await resolveSession(ctx, req);
    const proven = session && session.wallet === parsed.data.wallet ? session.wallet : null;
    if (strictHit(req, reply, proven)) return reply;
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
    if (strictHit(req, reply, wallet)) return reply;
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
    const maxParallel = Math.min(parsed.data.maxParallel ?? 1, ctx.config.routing.maxParallelPerNode);
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
    // Strict registration budget: per wallet once ownership is proven, per IP otherwise.
    if (strictHit(req, reply, walletVerified ? wallet : null)) return reply;

    // ---- beta gate: node operators must be admitted wallets too (docs/RUNBOOK.md "Public beta rollout") ----
    if (inviteRequired(ctx.config.beta) && !isAdmitted(ctx.db, wallet)) {
      return reply.code(403).send({
        error: 'invite_required',
        message: `Mesh is in ${ctx.config.beta.label.toLowerCase()}: the reward wallet must sign in to the web app with an invite code before it can register a node.`,
      });
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
    // Link-code consumption, the node row and its first heartbeat land together or not at all.
    const registered = ctx.db.transaction((): boolean => {
      if (link) {
        // Single use, atomically: a concurrent register with the same code loses here.
        const consumed = ctx.db
          .prepare(`UPDATE node_link_codes SET used_at = ?, used_node_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
          .run(ts, nodeId, link.code_hash, ts);
        if (consumed.changes !== 1) return false;
      }
      ctx.db
        .prepare(
          `INSERT INTO nodes (node_id, wallet, url, models, ram_gb, chip, busy, max_parallel, created_at, last_seen, token_hash, agent_version)
           VALUES (?, ?, '', ?, ?, ?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET wallet=excluded.wallet, models=excluded.models,
             ram_gb=COALESCE(excluded.ram_gb, nodes.ram_gb), chip=COALESCE(excluded.chip, nodes.chip),
             agent_version=COALESCE(excluded.agent_version, nodes.agent_version), max_parallel=excluded.max_parallel,
             token_hash=excluded.token_hash, last_seen=excluded.last_seen`,
        )
        .run(nodeId, wallet, JSON.stringify(models), ramGb ?? null, chip ?? null, maxParallel, ts, ts, hashNodeToken(nodeToken), agentVersion ?? null);
      recordHeartbeat(ctx.db, nodeId!, false, ts);
      return true;
    })();
    if (!registered) return reply.code(400).send({ error: 'link_code_used', message: 'this link code was just used or expired; create a new one from the web app' });
    ctx.broker.invalidateNodes();
    req.log.info({ nodeId, wallet, chip, models, maxParallel, signed: Boolean(parsed.data.signature), linked: Boolean(link) }, 'node registered');
    return {
      nodeId,
      nodeToken,
      wallet,
      registered: true,
      walletVerified,
      linked: Boolean(link),
      maxParallel,
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
    let maxParallel: number | undefined;
    if (hb.maxParallel !== undefined) {
      maxParallel = Math.min(hb.maxParallel, ctx.config.routing.maxParallelPerNode);
      sets.push('max_parallel = ?');
      args.push(maxParallel);
    }
    ctx.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE node_id = ?`).run(...args, req.params.id);
    const node = (req as NodeReq).node!;
    // `busy` from the node is advisory on top of the broker's running count: `true` (paused / full by its
    // own account) pins the node at no capacity until the next heartbeat; `false` just releases that pin.
    // It never resets the running count, so a heartbeat can no longer double-book a node mid-job.
    if (hb.busy !== undefined) ctx.broker.setPinnedBusy(req.params.id, hb.busy);
    else if (hb.models || maxParallel !== undefined) ctx.broker.invalidateNodes();
    recordHeartbeat(ctx.db, req.params.id, hb.busy ?? (ctx.broker.isPinnedBusy(req.params.id) || ctx.broker.runningOn(req.params.id) > 0), ts);
    return {
      nodeId: req.params.id,
      ok: true,
      heartbeatEverySec: HEARTBEAT_EVERY_SEC,
      offlineAfterSec: NODE_ONLINE_SEC,
      queuedJobs: ctx.broker.queuedJobs(),
      maxParallel: maxParallel ?? Math.max(1, node.max_parallel),
    };
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
    const r = ctx.broker.done(req.params.jobId, req.params.id, parsed.data);
    if (!r.ok && r.reason === 'empty_output') return reply.code(409).send({ error: 'empty_output', message: 'done without any chunk delivered: the job is marked failed and nothing is paid' });
    if (!r.ok) return reply.code(409).send({ error: 'job_not_running', message: 'job is not running on this node' });
    return { ok: true, usage: r.usage };
  });

  app.post<{ Params: { id: string; jobId: string } }>('/nodes/:id/jobs/:jobId/fail', { preHandler: requireNodeToken, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = FailBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const ok = ctx.broker.nodeFail(req.params.jobId, req.params.id, parsed.data.error);
    if (!ok) return reply.code(409).send({ error: 'job_not_running', message: 'job is not running on this node' });
    return { ok: true };
  });

  /**
   * Operator pledge (docs/PRIVACY.md). GET returns the exact text to sign and the current status;
   * POST stores the owning wallet's signature over it. Only the owning wallet session may call
   * either: a node token cannot pledge on the operator's behalf (the Mac never holds a key).
   */
  app.get<{ Params: { id: string } }>('/nodes/:id/pledge', { preHandler: requireSession(ctx) }, async (req, reply) => {
    const node = getNode(ctx, req.params.id);
    if (!node) return reply.code(404).send({ error: 'unknown_node', message: 'no such node' });
    if (sessionOf(req).wallet !== node.wallet) return reply.code(401).send({ error: 'unauthorized', message: 'only the reward wallet that owns this node may pledge' });
    return { nodeId: node.node_id, wallet: node.wallet, message: pledgeMessage({ domain, uri, wallet: node.wallet, nodeId: node.node_id }), ...pledgeView(ctx, node) };
  });

  app.post<{ Params: { id: string } }>('/nodes/:id/pledge', { preHandler: requireSession(ctx), bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = PledgeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const node = getNode(ctx, req.params.id);
    if (!node) return reply.code(404).send({ error: 'unknown_node', message: 'no such node' });
    const session = sessionOf(req);
    if (session.wallet !== node.wallet) return reply.code(401).send({ error: 'unauthorized', message: 'only the reward wallet that owns this node may pledge' });
    const chain: Chain = parsed.data.chain ?? (session.chain === 'evm' ? 'evm' : session.chain === 'solana' ? 'solana' : ctx.adapter.chain);
    const expected = pledgeMessage({ domain, uri, wallet: node.wallet, nodeId: node.node_id });
    const verify = chain === ctx.adapter.chain ? ctx.adapter.verifyWalletSignature.bind(ctx.adapter) : verifierFor(chain);
    if (!verify(node.wallet, expected, parsed.data.signature)) {
      return reply.code(401).send({ error: 'bad_signature', message: 'signature does not match the operator pledge for this node and wallet' });
    }
    const ts = nowSec();
    ctx.db.prepare(`UPDATE nodes SET pledge_at = ?, pledge_signature = ?, pledge_chain = ? WHERE node_id = ?`).run(ts, parsed.data.signature, chain, node.node_id);
    ctx.broker.invalidateNodes();
    const updated = getNode(ctx, node.node_id)!;
    req.log.info({ nodeId: node.node_id, wallet: node.wallet, chain }, 'operator pledge signed');
    return { nodeId: node.node_id, wallet: node.wallet, ...pledgeView(ctx, updated) };
  });

  /** Public summary: no wallets or tokens. Cached like /stats (STATS_CACHE_MS; 0 disables). */
  let nodesCache: { at: number; body: ReturnType<typeof nodesSummary> } | null = null;
  app.get('/nodes', async (req, reply) => {
    // Test mode: a signed-in operator gets the view with the simulated Macs, uncached and never shared.
    const view = await sampleViewFor(ctx, req);
    if (view !== ctx) return reply.header('cache-control', 'private, no-store').send(nodesSummary(view));
    if (sampleConfigured(ctx) > 0) reply.header('vary', 'cookie');
    const ttl = ctx.env.STATS_CACHE_MS;
    const t = Date.now();
    if (!nodesCache || ttl === 0 || t - nodesCache.at >= ttl) nodesCache = { at: t, body: nodesSummary(ctx) };
    reply.header('cache-control', `public, max-age=${Math.floor(ttl / 1000)}`);
    reply.header('x-cache-age-ms', String(t - nodesCache.at));
    return nodesCache.body;
  });

  /** Per-node stats: node token or the owning wallet's session. */
  app.get<{ Params: { id: string } }>('/nodes/:id', { preHandler: requireNodeOrOwner }, async (req) => {
    return nodeStatsView(ctx, (req as NodeReq).node!);
  });
}
