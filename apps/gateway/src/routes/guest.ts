import { isModelAllowed, upstreamCostMicros } from '@mesh/config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { nowSec, type Db } from '../db.js';
import { guestModelAllowed } from '../catalogue.js';
import { addTreasuryEntry } from '../ledger.js';
import { openaiError, relayChat, type ChatAccount, type RecordInput } from '../relay.js';
import { savedMicros } from '../savings.js';
import { costMicros, tokenCount } from '../upstream.js';

/**
 * Guest chat: a few free messages a day for homepage visitors, no wallet needed.
 *
 *  - POST /v1/guest/chat   `{ messages, model? }` → OpenAI-shaped SSE, same wire shape as
 *                          /v1/chat/completions (relay.ts). Always streams.
 *  - GET  /v1/guest/quota  `{ remaining, limit, enabled }`.
 *
 * Quota is per client IP (req.ip honours X-Forwarded-For only from trusted proxies, see server.ts),
 * `config.guest.messagesPerDay` per rolling 24h, kept in sqlite (`guest_quota`, keyed by a peppered
 * hash of the IP so addresses are never stored in clear). Requests run under the `network` privacy
 * tier: Mesh nodes first, upstream with ZDR providers as the fallback. Nobody is billed: the
 * treasury pays (`guest_chat` treasury rows for upstream-served messages; node rewards accrue to the
 * serving node as for any job and are already a treasury liability).
 */

export const GUEST_WALLET = 'guest';
/** `requests_log.api_key_id` is NOT NULL; guests have no key. */
const GUEST_KEY_ID = 0;
const DAY_SEC = 86_400;

export type GuestConfig = AppContext['config']['guest'];

interface QuotaRow {
  ip_hash: string;
  window_start: number;
  used: number;
}

export function hashIp(ip: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${ip}`).digest('hex').slice(0, 32);
}

/** Current window for `ipHash`: a fresh one when none exists or the last one is older than 24h. */
function windowFor(db: Db, ipHash: string, now: number): QuotaRow {
  const row = db.prepare(`SELECT ip_hash, window_start, used FROM guest_quota WHERE ip_hash = ?`).get(ipHash) as QuotaRow | undefined;
  if (!row || now - row.window_start >= DAY_SEC) return { ip_hash: ipHash, window_start: now, used: 0 };
  return row;
}

export function guestRemaining(db: Db, ipHash: string, limit: number, now = nowSec()): { remaining: number; resetAt: number } {
  const w = windowFor(db, ipHash, now);
  return { remaining: Math.max(0, limit - w.used), resetAt: w.window_start + DAY_SEC };
}

/** Take one message from the quota. Returns the remaining count after the take, or null when exhausted. */
export function consumeGuestMessage(db: Db, ipHash: string, limit: number, now = nowSec()): { remaining: number; resetAt: number } | null {
  const tx = db.transaction(() => {
    const w = windowFor(db, ipHash, now);
    if (w.used >= limit) return null;
    db.prepare(
      `INSERT INTO guest_quota (ip_hash, window_start, used, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ip_hash) DO UPDATE SET window_start = excluded.window_start, used = excluded.used, updated_at = excluded.updated_at`,
    ).run(ipHash, w.window_start, w.used + 1, now);
    return { remaining: limit - (w.used + 1), resetAt: w.window_start + DAY_SEC };
  });
  return tx();
}

/** Give one message back (the request failed before anything was served). */
export function refundGuestMessage(db: Db, ipHash: string): void {
  db.prepare(`UPDATE guest_quota SET used = MAX(0, used - 1), updated_at = ? WHERE ip_hash = ?`).run(nowSec(), ipHash);
}

/** Total characters of `content` across the messages (string content only; anything else is rejected upstream). */
export function inputChars(messages: Array<{ content?: unknown }>): number {
  let n = 0;
  for (const m of messages) if (typeof m.content === 'string') n += m.content.length;
  return n;
}

/** Validate a guest body into the OpenAI-shaped request the relay forwards, or return an error message. */
export function guestBody(body: Record<string, unknown>, cfg: GuestConfig): { body: Record<string, unknown>; model: string } | { error: string; code: string } {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { error: "'messages' must be a non-empty array", code: 'invalid_messages' };
  if (messages.length > 40) return { error: 'too many messages (max 40)', code: 'too_many_messages' };
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { error: 'each message must be an object', code: 'invalid_messages' };
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return { error: "message role must be 'user', 'assistant' or 'system'", code: 'invalid_messages' };
    if (typeof content !== 'string') return { error: 'message content must be a string', code: 'invalid_messages' };
  }
  const chars = inputChars(messages as Array<{ content?: unknown }>);
  if (chars > cfg.maxInputChars) return { error: `input too long: ${chars} characters, guest limit is ${cfg.maxInputChars}`, code: 'input_too_long' };
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model)) return { error: "'model' must be a string", code: 'invalid_model' };
  const model = (body.model as string | undefined) ?? cfg.model;
  const requested = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : cfg.maxTokens;
  // Only what the relay needs crosses over: no client-supplied params beyond messages/model/max_tokens.
  const out: Record<string, unknown> = {
    model,
    messages: (messages as Array<{ role: string; content: string }>).map((m) => ({ role: m.role, content: m.content })),
    max_tokens: Math.min(requested, cfg.maxTokens),
    stream: true,
  };
  return { body: out, model };
}

export async function guestRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = () => ctx.config.guest;
  const rateLimit = { max: ctx.env.V1_RATE_LIMIT, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.ip };
  const ipHashOf = (req: FastifyRequest) => hashIp(req.ip, ctx.env.KEY_PEPPER);

  /** 404 when the feature is off, so the surface does not exist at all. */
  function requireEnabled(reply: FastifyReply): boolean {
    if (cfg().enabled) return true;
    reply.code(404).send({ error: 'not_found', message: 'guest chat is disabled on this gateway', statusCode: 404 });
    return false;
  }

  /** The treasury pays: requests_log row under the guest sentinel wallet + a `guest_chat` treasury debit for upstream cost. */
  const guestAccount: ChatAccount = {
    wallet: GUEST_WALLET,
    apiKeyId: null,
    record({ model, usage, upstream, latencyMs, stream, network }: RecordInput): number {
      // What a paying user would have been billed; for node-served messages the treasury's real cost
      // is the node reward, which addNodeReward accrues separately (node_reward_accrual).
      const cost = network?.costMicros ?? costMicros(usage, model, ctx.prices, ctx.config.requestPricing.markupBps);
      const listCost = network?.listCostMicros ?? cost;
      const saved = network ? savedMicros(listCost, cost) : 0;
      ctx.db.transaction(() => {
        const res = ctx.db
          .prepare(
            `INSERT INTO requests_log (api_key_id, wallet, model, prompt_tokens, completion_tokens, cost_usd_micros, upstream, latency_ms, stream, created_at, list_cost_usd_micros, saved_usd_micros)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(GUEST_KEY_ID, GUEST_WALLET, model, tokenCount(usage?.prompt_tokens), tokenCount(usage?.completion_tokens), cost, upstream, latencyMs, stream ? 1 : 0, nowSec(), listCost, saved);
        // What the upstream really cost the treasury: list plus the upstream's own fee (requestPricing.upstreamFeeBps).
        if (!network && cost > 0) addTreasuryEntry(ctx.db, { kind: 'guest_chat', usdMicros: -upstreamCostMicros(cost, ctx.config.requestPricing), ref: `guest:req:${Number(res.lastInsertRowid)}` });
      })();
      // Nothing is charged to anyone: the relay reports $0 to the guest.
      return 0;
    },
  };

  app.get('/v1/guest/quota', { config: { rateLimit } }, async (req, reply) => {
    if (!requireEnabled(reply)) return reply;
    const c = cfg();
    const { remaining, resetAt } = guestRemaining(ctx.db, ipHashOf(req), c.messagesPerDay);
    reply.header('x-guest-remaining', String(remaining));
    reply.header('cache-control', 'no-store');
    return { remaining, limit: c.messagesPerDay, enabled: true, resetAt, maxTokens: c.maxTokens, maxInputChars: c.maxInputChars, model: c.model };
  });

  app.post('/v1/guest/chat', { config: { rateLimit } }, async (req, reply) => {
    if (!requireEnabled(reply)) return reply;
    const c = cfg();
    const parsed = guestBody((req.body ?? {}) as Record<string, unknown>, c);
    if ('error' in parsed) return openaiError(reply, 400, parsed.error, 'invalid_request_error', parsed.code);
    if (!isModelAllowed(ctx.policy, parsed.model)) return openaiError(reply, 403, `Model '${parsed.model}' is not available on Mesh.`, 'invalid_request_error', 'model_not_allowed');
    // Guests get the network models and the cheaper catalogue tiers (config guest.allowedTiers); frontier models need a wallet.
    if (!guestModelAllowed(ctx, parsed.model)) return openaiError(reply, 403, `Model '${parsed.model}' is not available to guests. Connect a wallet to use it.`, 'invalid_request_error', 'model_not_allowed_for_guests');

    const ipHash = ipHashOf(req);
    const taken = consumeGuestMessage(ctx.db, ipHash, c.messagesPerDay);
    if (!taken) {
      const { resetAt } = guestRemaining(ctx.db, ipHash, c.messagesPerDay);
      reply.header('x-guest-remaining', '0');
      reply.header('retry-after', String(Math.max(1, resetAt - nowSec())));
      return reply.code(429).send({ error: 'guest_quota_exhausted', message: 'Connect a wallet to keep chatting', remaining: 0, limit: c.messagesPerDay, resetAt });
    }
    // Set before the relay so the header rides along on the hijacked SSE response too.
    reply.header('x-guest-remaining', String(taken.remaining));
    reply.header('cache-control', 'no-store');

    const served = await relayChat(ctx, req, reply, {
      account: guestAccount,
      body: parsed.body,
      model: parsed.model,
      privacy: { tier: 'network', source: 'default' },
      stream: true,
      started: Date.now(),
      zdr: true, // upstream fallback only via zero-data-retention providers (docs/PRIVACY.md)
    });
    // An error response (upstream down, model missing) should not eat one of the visitor's messages.
    if (!served) refundGuestMessage(ctx.db, ipHash);
    return reply;
  });
}
