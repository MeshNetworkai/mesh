import { isModelAllowed, upstreamBilledMicros } from '@mesh/config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearer, keySpendExhausted, lookupApiKey, type ApiKeyRow } from '../auth.js';
import type { AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { addLedgerEntry, balanceMicros } from '../ledger.js';
import { microsToUsd } from '../money.js';
import { syncPoints } from '../points.js';
import { openaiError, relayChat, upstreamFailure, upstreamThrow, type ChatAccount, type RecordInput } from '../relay.js';
import { resolvePrivacy } from '../routing.js';
import { catalogueView } from '../catalogue.js';
import { savedMicros } from '../savings.js';
import { costMicros, tokenCount } from '../upstream.js';

export { networkCostMicros, openaiError } from '../relay.js';

export async function v1Routes(app: FastifyInstance, ctx: AppContext) {
  const rateLimit = {
    max: ctx.env.V1_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => bearer(req.headers.authorization) ?? req.ip,
  };

  /** Resolve API key -> row, or send an OpenAI-shaped 401. */
  async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<ApiKeyRow | null> {
    const key = bearer(req.headers.authorization);
    const row = key ? lookupApiKey(ctx.db, key, ctx.env.KEY_PEPPER) : null;
    if (!row) {
      openaiError(reply, 401, 'Invalid API key. Create one with POST /keys.', 'invalid_request_error', 'invalid_api_key');
      return null;
    }
    return row;
  }

  /** Billing for an API-key request: requests_log row, `usage` ledger debit, key spend counter, points. */
  function keyAccount(key: ApiKeyRow): ChatAccount {
    return {
      wallet: key.wallet,
      apiKeyId: key.id,
      balanceMicros: () => balanceMicros(ctx.db, key.wallet),
      paid: true,
      record({ model, usage, upstream, latencyMs, stream, network }: RecordInput): number {
        // Upstream-served: list (what the upstream charged, or the fallback price) ± the configured
        // markup/discount (docs/PRICING.md). Network-served: the flat network price the relay computed.
        const listCost = network?.listCostMicros ?? costMicros(usage, model, ctx.prices);
        const cost = network?.costMicros ?? upstreamBilledMicros(listCost, ctx.config.requestPricing);
        const saved = savedMicros(listCost, cost);
        const tx = ctx.db.transaction(() => {
          const res = ctx.db
            .prepare(
              `INSERT INTO requests_log (api_key_id, wallet, model, prompt_tokens, completion_tokens, cost_usd_micros, upstream, latency_ms, stream, created_at, list_cost_usd_micros, saved_usd_micros)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(key.id, key.wallet, model, tokenCount(usage?.prompt_tokens), tokenCount(usage?.completion_tokens), cost, upstream, latencyMs, stream ? 1 : 0, nowSec(), listCost, saved);
          if (cost > 0) {
            addLedgerEntry(ctx.db, { wallet: key.wallet, deltaMicros: -cost, kind: 'usage', ref: `req:${Number(res.lastInsertRowid)}` });
            ctx.db.prepare(`UPDATE api_keys SET spent_usd_micros = spent_usd_micros + ? WHERE id = ?`).run(cost, key.id);
          }
        });
        tx();
        // Pre-launch points for the spend (and, when a node served it, the tokens it served).
        syncPoints(ctx.db, ctx.config.points);
        return cost;
      },
    };
  }

  /**
   * The curated catalogue (config/model-prices.json entries with a tier) plus every network model, with
   * list price, Mesh price, privacy tier and how many nodes advertise it (catalogue.ts). OpenAI shape
   * (`object: 'list'`, `data[].id/object/created/owned_by`) with the extra fields. Works without a key
   * (the web picker and guest chat read it); a bearer that is present must be a valid key. `?guest=1`
   * narrows it to what a guest may pick (network models + config guest.allowedTiers).
   */
  app.get<{ Querystring: { guest?: string } }>('/v1/models', { config: { rateLimit } }, async (req, reply) => {
    if (bearer(req.headers.authorization)) {
      const key = await requireApiKey(req, reply);
      if (!key) return reply;
    }
    const guest = req.query.guest === '1' || req.query.guest === 'true';
    reply.header('cache-control', 'no-store');
    return catalogueView(ctx, { guest });
  });

  app.post('/v1/chat/completions', { config: { rateLimit } }, async (req, reply) => {
    const key = await requireApiKey(req, reply);
    if (!key) return reply;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openaiError(reply, 400, "'messages' must be a non-empty array", 'invalid_request_error');
    }
    if (typeof body.model !== 'string' || !body.model) {
      return openaiError(reply, 400, "'model' is required", 'invalid_request_error', 'model_required');
    }
    const requestedModel = body.model;
    if (!isModelAllowed(ctx.policy, requestedModel)) {
      return openaiError(
        reply,
        403,
        `Model '${requestedModel}' is not available on Mesh. GET /v1/models lists what is.`,
        'invalid_request_error',
        'model_not_allowed',
      );
    }

    if (keySpendExhausted(key)) {
      return openaiError(
        reply,
        429,
        `This API key reached its spend limit ($${microsToUsd(key.spend_limit_usd_micros ?? 0)}). Raise it with PATCH /keys/${key.id}.`,
        'insufficient_quota',
        'key_spend_limit_reached',
      );
    }

    const balance = balanceMicros(ctx.db, key.wallet);
    if (balance <= 0) {
      return openaiError(
        reply,
        402,
        `Insufficient Mesh credits (balance $${microsToUsd(balance).toFixed(6)}). Hold $MESH to receive hourly credits.`,
        'insufficient_quota',
        'insufficient_quota',
      );
    }

    // ---- privacy tier: header > body.mesh.privacy > key default > config default (docs/PRIVACY.md) ----
    const privacy = resolvePrivacy({ header: req.headers['x-mesh-privacy'], body, keyDefault: key.privacy }, ctx.config.privacy);
    if ('error' in privacy) return openaiError(reply, 400, privacy.error, 'invalid_request_error', 'invalid_privacy_tier');

    await relayChat(ctx, req, reply, { account: keyAccount(key), body, model: requestedModel, privacy, stream: body.stream === true, started: Date.now() });
    return reply;
  });
}
