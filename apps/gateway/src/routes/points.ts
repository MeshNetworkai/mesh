import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearer, verifySession } from '../auth.js';
import { requireAdmin, requireSession, sessionOf, type AppContext, type Session } from '../context.js';
import { nowSec, recordAdminAction } from '../db.js';
import { jwtSecrets } from '../env.js';
import { ensureWallet } from '../ledger.js';
import {
  BOARDS,
  awardPoints,
  leaderboardRows,
  pointsBalance,
  pointsRules,
  pointsSummary,
  syncPoints,
  truncateWallet,
  type Board,
  type BoardRow,
} from '../points.js';

export const LEADERBOARD_CACHE_MS = 30_000;
export const LEADERBOARD_MAX_LIMIT = 100;

/** Session when a valid bearer is present, else null; never rejects (public routes with a personal extra). */
export async function optionalSession(ctx: AppContext, req: FastifyRequest): Promise<Session | null> {
  const token = bearer(req.headers.authorization);
  if (!token) return null;
  return verifySession(jwtSecrets(ctx.env), token);
}

const BOARD_META: Record<Board, { unit: string; label: string; secondaryLabel: string | null }> = {
  holders: { unit: 'usd', label: 'Credits earned', secondaryLabel: null },
  nodes: { unit: 'tokens', label: 'Tokens served', secondaryLabel: 'jobs' },
  points: { unit: 'points', label: 'Points', secondaryLabel: null },
  referrers: { unit: 'referrals', label: 'Wallets referred', secondaryLabel: 'points' },
};

/**
 * Status: built, disabled. With `points.enabled: false` (config/tokenomics.json) every points,
 * leaderboard and referral route answers 404 as if it did not exist, so the programme can be
 * switched back on without a deploy of new code. Nothing here is deleted; see docs/POINTS.md.
 */
/** onRequest hook: 404 when the programme is off. Runs before auth so a disabled route leaks nothing. */
export function requirePointsEnabled(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (ctx.config.points.enabled) return;
    reply.code(404).send({ error: 'not_found', message: `Unknown route ${req.method} ${req.url}`, statusCode: 404 });
    return reply;
  };
}

export async function pointsRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = () => ctx.config.points;
  const gate = requirePointsEnabled(ctx);

  /** Public: the rules a wallet earns under (drives the "how to earn" tooltip). */
  app.get('/points/rules', { onRequest: gate }, async () => ({ ...pointsRules(cfg()), generatedAt: nowSec() }));

  /** The signed-in wallet's points: balance, 24h delta, today vs cap, split by kind, recent rows. */
  app.get('/me/points', { onRequest: gate, preHandler: requireSession(ctx) }, async (req) => {
    const { wallet } = sessionOf(req);
    syncPoints(ctx.db, cfg());
    return pointsSummary(ctx.db, cfg(), wallet);
  });

  // ---- leaderboards: whole ordering cached per board for 30 s, sliced per request ----
  const cache = new Map<Board, { at: number; rows: BoardRow[]; index: Map<string, number> }>();
  const boardRows = (board: Board) => {
    const t = Date.now();
    const hit = cache.get(board);
    if (hit && t - hit.at < LEADERBOARD_CACHE_MS) return hit;
    syncPoints(ctx.db, cfg());
    const rows = leaderboardRows(ctx.db, board);
    const index = new Map<string, number>();
    rows.forEach((r, i) => index.set(r.wallet, i));
    const entry = { at: t, rows, index };
    cache.set(board, entry);
    return entry;
  };

  const BoardParams = z.object({ board: z.enum(['holders', 'nodes', 'points', 'referrers']) });
  const BoardQuery = z.object({ limit: z.coerce.number().int().min(1).max(LEADERBOARD_MAX_LIMIT).default(LEADERBOARD_MAX_LIMIT) });

  app.get('/leaderboard/:board', { onRequest: gate }, async (req, reply) => {
    const params = BoardParams.safeParse(req.params ?? {});
    if (!params.success) return reply.code(404).send({ error: 'not_found', message: `Unknown board. One of: ${BOARDS.join(', ')}`, statusCode: 404 });
    const query = BoardQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'bad_request', issues: query.error.issues });
    const board = params.data.board;
    const { at, rows, index } = boardRows(board);
    const session = await optionalSession(ctx, req);
    let me: { rank: number | null; wallet: string; value: number; secondary: number | null } | null = null;
    if (session) {
      const i = index.get(session.wallet);
      me = i === undefined ? { rank: null, wallet: session.wallet, value: 0, secondary: null } : { rank: i + 1, wallet: session.wallet, value: rows[i].value, secondary: rows[i].secondary };
    }
    reply.header('cache-control', `public, max-age=${Math.floor(LEADERBOARD_CACHE_MS / 1000)}`);
    reply.header('x-cache-age-ms', String(Date.now() - at));
    return {
      board,
      ...BOARD_META[board],
      limit: query.data.limit,
      total: rows.length,
      rows: rows.slice(0, query.data.limit).map((r, i) => ({ rank: i + 1, wallet: truncateWallet(r.wallet), value: r.value, secondary: r.secondary })),
      me,
      cachedAt: Math.floor(at / 1000),
      generatedAt: nowSec(),
    };
  });

  // ---- admin: manual adjustment, audited in admin_actions ----
  const AdjustBody = z.object({
    wallet: z.string().min(1).max(128),
    points: z.number().finite().refine((p) => p !== 0, 'points must be non-zero'),
    note: z.string().min(1).max(280),
    /** Optional idempotency key; a repeat with the same ref is a no-op. */
    ref: z.string().min(1).max(128).optional(),
  });
  // Admin adjustments stay reachable while disabled so a ledger can be corrected before a re-enable.
  app.post('/admin/points/adjust', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    const parsed = AdjustBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, points, note, ref } = parsed.data;
    ensureWallet(ctx.db, wallet, ctx.adapter.chain);
    const actionId = recordAdminAction(ctx.db, 'points-adjust', { wallet, points, note, ref: ref ?? null });
    const award = awardPoints(ctx.db, cfg(), { wallet, kind: 'adjustment', points, ref: ref ?? `admin:${actionId}` });
    cache.clear();
    return {
      actionId,
      wallet,
      points: award?.points ?? 0,
      applied: award !== null,
      balance: pointsBalance(ctx.db, wallet),
      note,
    };
  });
}
