import { isNetworkModel, listPriceForModel, upstreamBilledMicros, upstreamModelFor, type ModelPrice } from '@mesh/config';
import type { AppContext } from './context.js';
import { promptTokenBound } from './network.js';
import { networkCostMicros } from './relay.js';

/**
 * Balance reservation for paid requests. `/v1/chat/completions` used to check `balance > 0` and bill
 * afterwards, so N concurrent requests (or one very long one) could spend far more than the wallet
 * held. Now each request first works out the most it can cost, caps `max_tokens` to what the wallet can
 * still afford, and holds that amount until the request has been billed; the next request only sees
 * what is left.
 *
 * Holds live in memory: they belong to in-flight requests, which die with the process, and the gateway
 * is single-instance (docs/SECURITY.md #15). The ledger is untouched until the real cost is known.
 */
export class Reservations {
  private held = new Map<string, number>();

  /** Micro-USD currently held under `key` (see `walletHold` / `keyHold`). */
  reserved(key: string): number {
    return this.held.get(key) ?? 0;
  }

  /** Hold `micros` under every key; the returned release is idempotent. */
  hold(keys: string[], micros: number): () => void {
    if (!Number.isInteger(micros) || micros < 0) throw new Error('reservation must be a non-negative integer');
    for (const k of keys) this.held.set(k, this.reserved(k) + micros);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of keys) {
        const left = this.reserved(k) - micros;
        if (left > 0) this.held.set(k, left);
        else this.held.delete(k);
      }
    };
  }
}

export const walletHold = (wallet: string) => `w:${wallet}`;
export const keyHold = (apiKeyId: number) => `k:${apiKeyId}`;

/** Which OpenAI field the client used for the completion cap (the upstream cap is written back to the same one). */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

export interface SpendPlan {
  /** Micro-USD to hold: the most this request can be billed on either leg. */
  reserveMicros: number;
  /** Completion cap sent to the upstream, in `maxTokensField`. */
  upstreamMaxTokens: number;
  maxTokensField: MaxTokensField;
  /** Completion cap for a node-served job. */
  nodeMaxTokens: number;
}

/** Bytes per token assumed for the prompt bound: low on purpose, so the bound errs high. */
const PROMPT_BYTES_PER_TOKEN = 3;

const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(1, Math.floor(v)) : null);

/**
 * Price used for the bound. A model with no entry in config/model-prices.json is assumed to cost as
 * much as the dearest one listed: `prices.default` would let an unlisted expensive model reserve a
 * fraction of what it bills.
 */
export function reservePrice(ctx: Pick<AppContext, 'prices' | 'policy'>, model: string): ModelPrice {
  const known = ctx.prices.models[upstreamModelFor(ctx.policy, model)] ?? ctx.prices.models[model];
  if (known) return known;
  if (isNetworkModel(ctx.policy, model)) return listPriceForModel(ctx.prices, ctx.policy, model);
  const all = [ctx.prices.default, ...Object.values(ctx.prices.models)];
  return {
    ...ctx.prices.default,
    promptUsdPerM: Math.max(...all.map((p) => p.promptUsdPerM)),
    completionUsdPerM: Math.max(...all.map((p) => p.completionUsdPerM)),
  };
}

/**
 * Bound the cost of one chat request against `availableMicros` (spendable balance minus what other
 * in-flight requests hold). Returns null when the wallet cannot afford the prompt plus one completion
 * token. A `max_tokens` larger than the wallet affords is lowered, not refused.
 *
 * The bound covers tokens at the price table; what the table cannot see (upstream plugins, a price
 * that moved since scripts/refresh-model-prices.mjs last ran) can still overshoot it slightly.
 */
export function planSpend(ctx: Pick<AppContext, 'prices' | 'policy' | 'config'>, body: Record<string, unknown>, model: string, availableMicros: number): SpendPlan | null {
  const routing = ctx.config.routing;
  const pricing = ctx.config.requestPricing;
  const json = JSON.stringify(body);
  const choices = positiveInt(body.n) ?? 1;
  const maxTokensField: MaxTokensField = positiveInt(body.max_completion_tokens) !== null ? 'max_completion_tokens' : 'max_tokens';
  const requested = positiveInt(body.max_completion_tokens) ?? positiveInt(body.max_tokens);

  // ---- upstream leg: list price ± the configured markup/discount ----
  const price = reservePrice(ctx, model);
  const billed = (listMicros: number) => Math.max(listMicros, upstreamBilledMicros(listMicros, pricing));
  const promptMicros = billed(Math.ceil((Buffer.byteLength(json) / PROMPT_BYTES_PER_TOKEN) * price.promptUsdPerM));
  const perTokenMicros = (billed(Math.ceil(price.completionUsdPerM * 1_000_000)) / 1_000_000) * choices;
  const affordable = perTokenMicros > 0 ? Math.floor((availableMicros - promptMicros) / perTokenMicros) : availableMicros >= promptMicros ? Number.MAX_SAFE_INTEGER : 0;
  if (affordable < 1) return null;
  const upstreamMaxTokens = Math.min(requested ?? routing.upstreamDefaultMaxTokens, affordable);
  let reserveMicros = promptMicros + Math.ceil(upstreamMaxTokens * perTokenMicros);

  // ---- node leg: flat network price; the broker clamps a node's reported prompt to promptTokenBound (network.ts) ----
  let nodeMaxTokens = Math.min(positiveInt(body.max_tokens) ?? routing.defaultMaxTokens, routing.nodeMaxTokens);
  if (routing.preferNetwork && isNetworkModel(ctx.policy, model)) {
    const perM = pricing.networkPricePerMTokens;
    // The whole body is at least as long as the message text a node is sent.
    const promptCap = promptTokenBound(Buffer.byteLength(json), Array.isArray(body.messages) ? body.messages.length : 1);
    const nodeAffordable = perM > 0 ? Math.floor((availableMicros - networkCostMicros(promptCap, perM)) / perM) : Number.MAX_SAFE_INTEGER;
    if (nodeAffordable < 1) return null;
    nodeMaxTokens = Math.min(nodeMaxTokens, nodeAffordable);
    reserveMicros = Math.max(reserveMicros, networkCostMicros(promptCap + nodeMaxTokens, perM));
  }
  return { reserveMicros: Math.min(reserveMicros, Math.max(0, availableMicros)), upstreamMaxTokens, maxTokensField, nodeMaxTokens };
}
