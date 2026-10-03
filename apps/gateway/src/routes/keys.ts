import { PRIVACY_TIERS } from '@mesh/config';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createApiKey, getApiKey, listApiKeys, publicKeyView, revokeApiKey, updateApiKey } from '../auth.js';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { microsToUsd, usdToMicros } from '../money.js';

const name = z.string().trim().min(1).max(64);
/** Default privacy tier for the key (docs/PRIVACY.md); null = use the gateway default. */
const privacy = z.enum(PRIVACY_TIERS).nullable().optional();
const CreateBody = z
  .object({
    name: name.optional(),
    /** legacy alias for name */
    label: name.optional(),
    spendLimitUsd: z.number().positive().nullable().optional(),
    privacy,
  })
  .optional();
const PatchBody = z
  .object({
    name: name.nullable().optional(),
    spendLimitUsd: z.number().positive().nullable().optional(),
    privacy,
  })
  .refine((b) => 'name' in b || 'spendLimitUsd' in b || 'privacy' in b, { message: 'nothing to update' });

export async function keyRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = requireSession(ctx);

  app.post('/keys', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet } = sessionOf(req);
    const b = parsed.data ?? {};
    const limit = b.spendLimitUsd == null ? null : usdToMicros(b.spendLimitUsd);
    const { id, key, prefix, name } = createApiKey(ctx.db, wallet, { name: b.name ?? b.label ?? null, spendLimitUsdMicros: limit, pepper: ctx.env.KEY_PEPPER, privacy: b.privacy ?? null });
    return reply.code(201).send({
      id,
      key,
      prefix,
      name,
      spendLimitUsd: limit === null ? null : microsToUsd(limit),
      privacy: b.privacy ?? null,
      note: 'Store this key now; it is not shown again.',
    });
  });

  app.get('/keys', { preHandler: auth }, async (req) => {
    const { wallet } = sessionOf(req);
    return { keys: listApiKeys(ctx.db, wallet).map(publicKeyView) };
  });

  app.patch<{ Params: { id: string } }>('/keys/:id', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_request' });
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet } = sessionOf(req);
    if (!getApiKey(ctx.db, wallet, id)) return reply.code(404).send({ error: 'not_found' });
    const patch: { name?: string | null; spendLimitUsdMicros?: number | null; privacy?: string | null } = {};
    if ('name' in parsed.data) patch.name = parsed.data.name ?? null;
    if ('privacy' in parsed.data) patch.privacy = parsed.data.privacy ?? null;
    if ('spendLimitUsd' in parsed.data) {
      patch.spendLimitUsdMicros = parsed.data.spendLimitUsd == null ? null : usdToMicros(parsed.data.spendLimitUsd);
    }
    const row = updateApiKey(ctx.db, wallet, id, patch);
    return publicKeyView(row!);
  });

  app.get<{ Params: { id: string } }>('/keys/:id/usage', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_request' });
    const { wallet } = sessionOf(req);
    const row = getApiKey(ctx.db, wallet, id);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const now = nowSec();
    const window = (since: number) =>
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd_micros),0) AS cost,
                  COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct
           FROM requests_log WHERE api_key_id = ? AND created_at >= ?`,
        )
        .get(id, since) as { n: number; cost: number; pt: number; ct: number };
    const fmt = (w: ReturnType<typeof window>) => ({
      requests: w.n,
      spendUsd: microsToUsd(w.cost),
      promptTokens: w.pt,
      completionTokens: w.ct,
    });
    const all = window(0);
    const topModels = ctx.db
      .prepare(
        `SELECT model, COUNT(*) AS n, COALESCE(SUM(cost_usd_micros),0) AS cost
         FROM requests_log WHERE api_key_id = ? AND created_at >= ?
         GROUP BY model ORDER BY n DESC, cost DESC LIMIT 10`,
      )
      .all(id, now - 7 * 86_400) as Array<{ model: string; n: number; cost: number }>;

    return {
      key: publicKeyView(row),
      last24h: fmt(window(now - 86_400)),
      last7d: fmt(window(now - 7 * 86_400)),
      allTime: { ...fmt(all), requestCount: all.n },
      requestCount: all.n,
      topModels: topModels.map((m) => ({ model: m.model, requests: m.n, spendUsd: microsToUsd(m.cost) })),
    };
  });

  app.delete<{ Params: { id: string } }>('/keys/:id', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_request' });
    const ok = revokeApiKey(ctx.db, sessionOf(req).wallet, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { id, revoked: true };
  });
}
