import { MockAdapter } from '@mesh/chain-adapter';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_SESSION_TTL_SEC, WalletField, safeEqual, signAdminSession, signSession } from '../auth.js';
import { admit, admitOldest, betaView, createInviteCodes, listWaitlist, waitlistCounts } from '../beta.js';
import { adminAudited, adminHeaderToken, authViaOf, clearAdminCookies, markAdminAudited, requireAdmin, setAdminCookies, setSessionCookies, type AppContext } from '../context.js';
import { nowSec, recordAdminAction, recordError } from '../db.js';
import { runEpoch } from '../jobs/distribute.js';
import { runHousekeeping, type HousekeepingResult } from '../jobs/housekeeping.js';
import { addLedgerEntry, balanceMicros, ensureWallet, treasuryBalanceMicros } from '../ledger.js';
import { microsToUsd, usdToMicros } from '../money.js';
import { NODE_ONLINE_SEC, nodeModels, type NodeRow } from '../routing.js';
import { sampleNodeCount } from '../sample-data.js';
import { clearQuarantine, nodeVerificationStats, quarantineNode, verificationOverview } from '../verification.js';
import { starterAdminRoutes } from '../starter.js';
import { chainRoutes } from './chain.js';
import { getNode } from './nodes.js';

const FakeFeesBody = z.object({ amountUsd: z.number().positive() });
const StarterItem = z.object({ wallet: WalletField, amountUsd: z.number().positive().max(10_000) });
const StarterBatchBody = z.object({ items: z.array(StarterItem).min(1).max(500), note: z.string().max(200).optional() });
const RunEpochBody = z.object({ epochStart: z.number().int().nonnegative().optional() }).optional();
const DevLoginBody = z.object({ wallet: WalletField, chain: z.enum(['solana', 'evm']).optional() });
const InvitesBody = z.object({ count: z.number().int().min(1).max(1000).default(1), uses: z.number().int().min(1).max(10_000).default(1) });
const AdmitBody = z.object({ n: z.number().int().min(1).max(5000).optional() }).optional();
const AdmitWalletBody = z.object({ wallet: WalletField });
const WaitlistQuery = z.object({ limit: z.coerce.number().int().min(1).max(5000).default(500), status: z.enum(['waiting', 'invited', 'all']).default('all') });
const QuarantineBody = z.object({ reason: z.string().min(1).max(200).default('manual') }).optional();

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = requireAdmin(ctx);
  // Handlers audit with their own payload; the onResponse hook below covers everything else
  // (reads, denied attempts, login/logout) so every /admin call leaves a row.
  const audit = (req: FastifyRequest, action: string, payload: unknown) => {
    markAdminAudited(req);
    return recordAdminAction(ctx.db, action, payload);
  };
  app.addHook('onResponse', async (req, reply) => {
    if (adminAudited(req)) return;
    const ok = reply.statusCode < 300;
    req.log.info({ method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ip: req.ip, via: authViaOf(req) ?? null, reqId: req.id }, 'admin call');
    // Successful reads (the overview polls every 30 s) stay in the log; everything else is a row.
    if (ok && req.method === 'GET') return;
    recordAdminAction(ctx.db, ok ? 'admin-call' : 'admin-denied', {
      method: req.method,
      path: req.url.split('?')[0],
      status: reply.statusCode,
      ip: req.ip,
      via: authViaOf(req) ?? null,
      requestId: req.id,
    });
  });

  /**
   * Exchange the admin token (header) for an HttpOnly admin cookie (+ CSRF cookie) so the web
   * Admin page does not have to keep the token in memory. 12 h, re-login after.
   */
  app.post('/admin/login', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const token = adminHeaderToken(req) ?? (req.body as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !safeEqual(token, ctx.env.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'admin token required' });
    }
    const jwt = await signAdminSession(ctx.env.JWT_SECRET);
    const csrf = setAdminCookies(ctx.env, reply, jwt);
    audit(req, 'admin-login', { ip: req.ip, requestId: req.id });
    return { ok: true, expiresInSec: ADMIN_SESSION_TTL_SEC, csrf };
  });

  app.post('/admin/logout', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    clearAdminCookies(ctx.env, reply);
    audit(req, 'admin-logout', { ip: req.ip, requestId: req.id });
    return { ok: true };
  });

  /** Is the admin cookie (or header) still good? The web Admin page calls this on load. */
  app.get('/admin/session', { preHandler: guard }, async (req) => ({ ok: true, via: authViaOf(req) ?? null }));

  function grantStarter(wallet: string, amountUsd: number, ref: string) {
    ensureWallet(ctx.db, wallet, ctx.adapter.chain);
    const micros = usdToMicros(amountUsd);
    const id = addLedgerEntry(ctx.db, { wallet, deltaMicros: micros, kind: 'starter', ref });
    return { ledgerId: id, wallet, amountUsd: microsToUsd(micros), balanceUsd: microsToUsd(balanceMicros(ctx.db, wallet)) };
  }

  // Starter credits on first connect: GET /admin/starter, POST /admin/starter/toggle (starter.ts).
  starterAdminRoutes(app, ctx, guard, audit);
  // Admin → Token: GET/POST/DELETE /admin/chain, POST /admin/chain/check (routes/chain.ts).
  chainRoutes(app, ctx, guard as never, audit);

  app.post('/admin/run-epoch', { preHandler: guard }, async (req, reply) => {
    const parsed = RunEpochBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const result = await runEpoch(ctx, parsed.data?.epochStart);
    // Same chores the cron runs after an epoch: pay node rewards, lapse credit past its window, read the
    // reserve. The epoch above is already committed, so a chore that fails is logged and reported (as it is
    // for the cron, index.ts), not turned into a 500 that hides an epoch that did run.
    let chores: HousekeepingResult | null = null;
    try {
      chores = await runHousekeeping(ctx);
    } catch (err) {
      req.log.error({ err }, 'housekeeping failed');
      recordError(ctx.db, { route: 'admin run-epoch housekeeping', status: 500, code: 'housekeeping_failed', message: (err as Error).message ?? String(err) });
    }
    audit(req, 'run-epoch', { epochStart: result.epochStart, status: result.status, feesUsdMicros: result.feesUsdMicros, holders: result.eligibleHolders, expiredUsdMicros: chores?.expiredUsdMicros ?? null });
    return {
      ...result,
      /** Null when the chores failed after the epoch ran (logged as `housekeeping_failed`); they run again with the next epoch. */
      housekeeping: chores && { nodePayoutWallets: chores.nodePayoutWallets, nodePayoutUsd: microsToUsd(chores.nodePayoutUsdMicros), expiredWallets: chores.expiredWallets, expiredUsd: microsToUsd(chores.expiredUsdMicros), reserve: chores.reserveSource, reserveHeldUsd: chores.reserveHeldUsdMicros === null ? null : microsToUsd(chores.reserveHeldUsdMicros), sweepWarnings: chores.sweepWarnings },
      feesUsd: microsToUsd(result.feesUsdMicros),
      holderPoolUsd: microsToUsd(result.holderPoolUsdMicros),
      treasuryUsd: microsToUsd(result.treasuryUsdMicros),
      distributed: result.distributed.map((d) => ({ wallet: d.wallet, usd: microsToUsd(d.usdMicros), multiplier: d.multiplier })),
    };
  });

  /** Operator key revocation by id (owner-independent). Idempotent; 404 for an unknown id. */
  app.delete<{ Params: { id: string } }>('/admin/keys/:id', { preHandler: guard }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_request', message: 'key id must be a positive integer' });
    const row = ctx.db.prepare(`SELECT id, wallet, key_prefix, revoked FROM api_keys WHERE id = ?`).get(id) as
      | { id: number; wallet: string; key_prefix: string; revoked: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found', message: `no api key with id ${id}` });
    ctx.db.prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ?`).run(id);
    audit(req, 'revoke-key', { id, wallet: row.wallet, prefix: row.key_prefix, alreadyRevoked: row.revoked === 1 });
    return { id, wallet: row.wallet, prefix: row.key_prefix, revoked: true, alreadyRevoked: row.revoked === 1 };
  });

  /** Dev harness: push fees into the MockAdapter so an epoch has something to distribute. */
  app.post('/admin/fake-fees', { preHandler: guard }, async (req, reply) => {
    if (!(ctx.adapter instanceof MockAdapter)) {
      return reply.code(409).send({ error: 'not_mock', message: 'fake-fees only works with MESH_ADAPTER=mock' });
    }
    const parsed = FakeFeesBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const pending = ctx.adapter.pushFees(parsed.data.amountUsd);
    audit(req, 'fake-fees', parsed.data);
    return { pendingFeesUsd: pending };
  });

  app.post('/admin/starter-credit', { preHandler: guard }, async (req, reply) => {
    const parsed = StarterItem.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, amountUsd } = parsed.data;
    const out = ctx.db.transaction(() => {
      const r = grantStarter(wallet, amountUsd, 'admin');
      audit(req, 'starter-credit', { wallet, amountUsd, ledgerId: r.ledgerId });
      return r;
    })();
    return out;
  });

  /** Batch starter credits; all-or-nothing, one audit row. */
  app.post('/admin/starter-credits', { preHandler: guard }, async (req, reply) => {
    const parsed = StarterBatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { items, note } = parsed.data;
    const result = ctx.db.transaction(() => {
      const batchId = audit(req, 'starter-credits', { count: items.length, note: note ?? null, items });
      const granted = items.map((it) => grantStarter(it.wallet, it.amountUsd, `admin:batch:${batchId}`));
      return { batchId, granted };
    })();
    return {
      batchId: result.batchId,
      count: result.granted.length,
      totalUsd: microsToUsd(result.granted.reduce((a, g) => a + usdToMicros(g.amountUsd), 0)),
      granted: result.granted,
    };
  });

  /** Everything an operator wants on one screen. */
  app.get('/admin/overview', { preHandler: guard }, async () => {
    const db = ctx.db;
    const now = nowSec();
    const epochs = db
      .prepare(
        `SELECT epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, fee_tx_id, status, created_at
         FROM epochs ORDER BY epoch_start DESC LIMIT 48`,
      )
      .all() as Array<Record<string, number | string | null>>;
    const totals = {
      fees: (db.prepare(`SELECT COALESCE(SUM(fees_usd_micros),0) AS v FROM epochs`).get() as { v: number }).v,
      treasury: (db.prepare(`SELECT COALESCE(SUM(treasury_usd_micros),0) AS v FROM epochs`).get() as { v: number }).v,
      distributed: (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind='distribution'`).get() as { v: number }).v,
      starter: (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind='starter'`).get() as { v: number }).v,
      used: (db.prepare(`SELECT COALESCE(-SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE kind='usage'`).get() as { v: number }).v,
      outstanding: (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger`).get() as { v: number }).v,
      wallets: (db.prepare(`SELECT COUNT(*) AS v FROM wallets`).get() as { v: number }).v,
      apiKeys: (db.prepare(`SELECT COUNT(*) AS v FROM api_keys WHERE revoked = 0`).get() as { v: number }).v,
      requests: (db.prepare(`SELECT COUNT(*) AS v FROM requests_log`).get() as { v: number }).v,
      requests24h: (db.prepare(`SELECT COUNT(*) AS v FROM requests_log WHERE created_at >= ?`).get(now - 86_400) as { v: number }).v,
      nodeRewards: (db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM node_rewards WHERE kind='node_reward' AND status='accrued'`).get() as { v: number }).v,
      treasuryBalance: treasuryBalanceMicros(db),
    };
    const holders = db
      .prepare(
        `SELECT wallet, SUM(delta_usd_micros) AS balance,
                SUM(CASE WHEN kind='distribution' THEN delta_usd_micros ELSE 0 END) AS earned,
                SUM(CASE WHEN kind='usage' THEN -delta_usd_micros ELSE 0 END) AS used
         FROM credits_ledger GROUP BY wallet ORDER BY balance DESC LIMIT 20`,
      )
      .all() as Array<{ wallet: string; balance: number; earned: number; used: number }>;
    const nodes = db.prepare(`SELECT * FROM nodes ORDER BY last_seen DESC LIMIT 200`).all() as NodeRow[];
    const errors = db
      .prepare(`SELECT id, route, status, code, message, created_at FROM errors_log ORDER BY id DESC LIMIT 50`)
      .all() as Array<Record<string, unknown>>;
    const actions = db
      .prepare(`SELECT id, action, payload, created_at FROM admin_actions ORDER BY id DESC LIMIT 50`)
      .all() as Array<{ id: number; action: string; payload: string; created_at: number }>;

    return {
      time: now,
      upstream: ctx.upstream.name,
      adapter: ctx.adapterStatus ?? ctx.env.MESH_ADAPTER,
      chain: ctx.adapter.chain,
      sampleNodes: sampleNodeCount(ctx),
      epochs: epochs.map((e) => ({
        epochStart: e.epoch_start,
        epochEnd: e.epoch_end,
        feesUsd: microsToUsd(e.fees_usd_micros as number),
        holderPoolUsd: microsToUsd(e.holder_pool_usd_micros as number),
        treasuryUsd: microsToUsd(e.treasury_usd_micros as number),
        eligibleHolders: e.eligible_holders,
        feeTxId: e.fee_tx_id,
        status: e.status,
        createdAt: e.created_at,
      })),
      totals: {
        feesUsd: microsToUsd(totals.fees),
        treasuryUsd: microsToUsd(totals.treasury),
        creditsDistributedUsd: microsToUsd(totals.distributed),
        starterCreditsUsd: microsToUsd(totals.starter),
        creditsUsedUsd: microsToUsd(totals.used),
        creditsOutstandingUsd: microsToUsd(totals.outstanding),
        wallets: totals.wallets,
        activeApiKeys: totals.apiKeys,
        requests: totals.requests,
        requests24h: totals.requests24h,
        nodeRewardsUsd: microsToUsd(totals.nodeRewards),
        treasuryBalanceUsd: microsToUsd(totals.treasuryBalance),
      },
      holdingAge: ctx.config.distribution.holdingAge,
      topHolders: holders.map((h) => ({
        wallet: h.wallet,
        balanceUsd: microsToUsd(h.balance),
        earnedUsd: microsToUsd(h.earned),
        usedUsd: microsToUsd(h.used),
      })),
      nodes: nodes.map((n) => ({
        nodeId: n.node_id,
        wallet: n.wallet,
        url: n.url,
        models: nodeModels(n),
        chip: n.chip,
        ramGb: n.ram_gb,
        busy: n.busy >= Math.max(1, n.max_parallel),
        runningJobs: n.busy,
        maxParallel: Math.max(1, n.max_parallel),
        lastSeen: n.last_seen,
        online: n.last_seen >= now - NODE_ONLINE_SEC,
        quarantined: n.quarantined_at !== null,
        verification: nodeVerificationStats(db, n),
      })),
      /** Spot-check verification (verification.ts): network-wide counts and the latest verdicts. */
      verification: { ...verificationOverview(db), config: ctx.config.verification },
      /** Public beta: config + waitlist / admissions counters (routes below manage them). */
      beta: { ...betaView(ctx.config.beta), batchSize: ctx.config.beta.batchSize, ...waitlistCounts(db) },
      recentErrors: errors,
      recentAdminActions: actions.map((a) => ({ ...a, payload: safeJson(a.payload) })),
    };
  });

  // ---------------- spot-check verification: quarantine management ----------------

  /** Clear a quarantine set by repeated verification mismatches (or by hand). The node is routable again at once. */
  app.post<{ Params: { id: string } }>('/admin/nodes/:id/quarantine/clear', { preHandler: guard }, async (req, reply) => {
    const node = getNode(ctx, req.params.id);
    if (!node) return reply.code(404).send({ error: 'not_found', message: `no node ${req.params.id}` });
    const was = node.quarantined_at;
    clearQuarantine(ctx.db, node.node_id);
    ctx.broker.invalidateNodes();
    audit(req, 'quarantine-clear', { nodeId: node.node_id, wallet: node.wallet, wasQuarantinedAt: was, reason: node.quarantine_reason });
    return { nodeId: node.node_id, quarantined: false, wasQuarantinedAt: was, verification: nodeVerificationStats(ctx.db, getNode(ctx, node.node_id)!) };
  });

  /** Quarantine a node by hand (stops routing and pulls until cleared). */
  app.post<{ Params: { id: string } }>('/admin/nodes/:id/quarantine', { preHandler: guard }, async (req, reply) => {
    const parsed = QuarantineBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const node = getNode(ctx, req.params.id);
    if (!node) return reply.code(404).send({ error: 'not_found', message: `no node ${req.params.id}` });
    const reason = `admin: ${parsed.data?.reason ?? 'manual'}`;
    quarantineNode(ctx.db, node.node_id, reason);
    ctx.broker.invalidateNodes();
    audit(req, 'quarantine', { nodeId: node.node_id, wallet: node.wallet, reason });
    return { nodeId: node.node_id, quarantined: true, verification: nodeVerificationStats(ctx.db, getNode(ctx, node.node_id)!) };
  });

  // ---------------- public beta: invites + waitlist ----------------

  /** Mint invite codes: `count` codes with `uses` uses each (default 1 × 1). Codes are returned once here and listed nowhere else. */
  app.post('/admin/invites', { preHandler: guard }, async (req, reply) => {
    const parsed = InvitesBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const codes = createInviteCodes(ctx.db, parsed.data.count, parsed.data.uses, `admin:${req.ip}`);
    audit(req, 'invites', { count: codes.length, uses: parsed.data.uses });
    return { count: codes.length, uses: parsed.data.uses, codes, beta: betaView(ctx.config.beta) };
  });

  /** Admit a specific wallet without a code (support cases). */
  app.post('/admin/admit', { preHandler: guard }, async (req, reply) => {
    const parsed = AdmitWalletBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    admit(ctx.db, parsed.data.wallet, 'admin');
    audit(req, 'admit', { wallet: parsed.data.wallet });
    return { wallet: parsed.data.wallet, admitted: true };
  });

  /**
   * Admit the oldest `n` waiting entries (default `beta.batchSize`): each gets a one-use code, returned
   * here for the operator to send (e-mail delivery is out of scope). Wallet entries are admitted directly.
   */
  app.post('/admin/waitlist/admit', { preHandler: guard }, async (req, reply) => {
    const parsed = AdmitBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const n = parsed.data?.n ?? ctx.config.beta.batchSize;
    const rows = admitOldest(ctx.db, n, `admin:${req.ip}`);
    audit(req, 'waitlist-admit', { requested: n, admitted: rows.length });
    return {
      requested: n,
      admitted: rows.length,
      entries: rows.map((r) => ({ id: r.id, wallet: r.wallet, email: r.email, code: r.code, createdAt: r.created_at, invitedAt: r.invited_at })),
      counts: waitlistCounts(ctx.db),
    };
  });

  app.get('/admin/waitlist', { preHandler: guard }, async (req, reply) => {
    const parsed = WaitlistQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const rows = listWaitlist(ctx.db, parsed.data);
    return {
      counts: waitlistCounts(ctx.db),
      beta: { ...betaView(ctx.config.beta), batchSize: ctx.config.beta.batchSize },
      entries: rows.map((r) => ({ id: r.id, wallet: r.wallet, email: r.email, code: r.code, createdAt: r.created_at, invitedAt: r.invited_at })),
    };
  });

  /**
   * DEV ONLY. Mints a session JWT for any wallet without a signature.
   * Guarded by ADMIN_TOKEN; never expose ADMIN_TOKEN in production.
   */
  app.post('/admin/dev-login', { preHandler: guard }, async (req, reply) => {
    const parsed = DevLoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const chain = parsed.data.chain ?? ctx.adapter.chain;
    ensureWallet(ctx.db, parsed.data.wallet, chain);
    // A dev session is an admitted wallet (so demo/e2e flows can register nodes under beta gating).
    admit(ctx.db, parsed.data.wallet, 'dev');
    const token = await signSession(ctx.env.JWT_SECRET, parsed.data.wallet, chain);
    // Same cookie pair as /auth/verify so browser e2e / demo flows get a cookie session too.
    const csrf = setSessionCookies(ctx.env, reply, token);
    audit(req, 'dev-login', { wallet: parsed.data.wallet, chain });
    return { token, wallet: parsed.data.wallet, chain, devOnly: true, csrf };
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
