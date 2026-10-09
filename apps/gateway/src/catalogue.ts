// Model catalogue behind GET /v1/models (docs/PRICING.md).
//
// Two sources merge: the curated catalogue in config/model-prices.json (entries with a `tier`) and the
// network models in config/model-policy.json. Each row says where it can be served, what the upstream
// lists it at, what Mesh bills (the flat network price for a Mesh node, list ± markup/discount upstream),
// the privacy tier a request to it ends up under and how many online nodes advertise its Ollama tag.
import {
  catalogueEntries,
  isModelAllowed,
  listPriceForModel,
  meshPricePerM,
  networkModelNames,
  networkTagFor,
  upstreamModelFor,
  type ModelPrice,
  type ModelTier,
} from '@mesh/config';
import type { AppContext } from './context.js';
import { nowSec } from './db.js';
import { nodeModels, onlineNodes } from './routing.js';
import { sampleFleet } from './sample-data.js';

export interface PricePerM {
  promptUsdPerM: number;
  completionUsdPerM: number;
}

export interface CatalogueModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Human name (OpenAI clients show `name`; `displayName` is the same string). */
  name: string;
  displayName: string;
  vendor: string;
  tier: ModelTier | null;
  /** Where the request can land: Mesh nodes, the upstream, or either (network first). */
  served: 'network' | 'upstream' | 'both';
  /** OpenRouter list price, USD per 1M tokens. */
  listPrice: PricePerM;
  /** What Mesh bills: the flat network price per 1M tokens when a node serves it, else list ± markup/discount. */
  meshPrice: PricePerM;
  /** Where the prompt is processed: on a Mesh node (`network`) or at the upstream with ZDR providers only (`upstream_zdr`). */
  privacy: 'network' | 'upstream_zdr';
  /** Online nodes advertising the model's Ollama tag right now (0 for upstream-only models). */
  online: number;
  /** A guest (POST /v1/guest/chat) may pick it: network models and config guest.allowedTiers. */
  guestAllowed: boolean;
  /** Back-compat flag (pre-catalogue clients). */
  mesh_network: boolean;
}

const TIER_ORDER: Record<string, number> = { frontier: 1, fast: 2, open: 3 };

/** Does a guest get to pick this model? Network models always; upstream-only ones by tier. */
export function guestModelAllowed(ctx: Pick<AppContext, 'config' | 'prices' | 'policy'>, model: string): boolean {
  if (networkTagFor(ctx.policy, model)) return true;
  const entry = ctx.prices.models[model];
  const tier = entry?.tier;
  return tier !== undefined && ctx.config.guest.allowedTiers.includes(tier);
}

export function catalogueModels(
  ctx: Pick<AppContext, 'config' | 'prices' | 'policy' | 'db' | 'broker'> & { env?: { NODE_ENV?: string; MESH_SAMPLE_NODES?: number }; sampleViewer?: boolean },
  now = nowSec(),
): CatalogueModel[] {
  const { policy, prices, config } = ctx;
  // The offline mock model is a dev/test convenience; it never belongs in a production picker.
  const hideMock = ctx.env?.NODE_ENV === 'production';
  // A network model is listed once per Ollama tag: the short alias ("llama-3.1-8b") is the row, the
  // upstream-style sibling ("meta-llama/llama-3.1-8b-instruct") stays accepted as a model name for API
  // clients but would be a duplicate line in the picker.
  const listedTags = new Set<string>();
  const pricing = config.requestPricing;
  const online = ctx.broker ? ctx.broker.onlineNodes(now) : onlineNodes(ctx.db, now);
  // Test mode (MESH_SAMPLE_NODES, sample-data.ts): simulated Macs count towards the models they advertise.
  const simulated = sampleFleet(ctx, now).models;
  const onlineFor = (tag: string | null) => (tag ? online.filter((n) => nodeModels(n).includes(tag)).length + (simulated[tag] ?? 0) : 0);
  const flat: PricePerM = { promptUsdPerM: pricing.networkPricePerMTokens, completionUsdPerM: pricing.networkPricePerMTokens };
  const upstreamPrice = (p: ModelPrice): PricePerM => ({ promptUsdPerM: meshPricePerM(p.promptUsdPerM, pricing), completionUsdPerM: meshPricePerM(p.completionUsdPerM, pricing) });

  const rows = new Map<string, CatalogueModel>();
  const push = (id: string, entry: { tier?: ModelTier; vendor?: string; displayName?: string } | undefined) => {
    if (rows.has(id) || !isModelAllowed(policy, id)) return;
    if (hideMock && id.startsWith('mesh/')) return;
    const tag = networkTagFor(policy, id);
    if (tag) {
      if (listedTags.has(tag)) return;
      listedTags.add(tag);
    }
    const list = listPriceForModel(prices, policy, id);
    const upstreamId = upstreamModelFor(policy, id);
    // A network model can also go upstream when it resolves to a real upstream id (contains "/", not a mesh/* mock).
    const hasUpstream = upstreamId.includes('/') && !upstreamId.startsWith('mesh/');
    const served: CatalogueModel['served'] = tag ? (hasUpstream ? 'both' : 'network') : 'upstream';
    const sibling = prices.models[upstreamId];
    const tier = entry?.tier ?? sibling?.tier ?? (tag ? 'open' : null);
    const vendor = entry?.vendor ?? sibling?.vendor ?? (tag ? 'Mesh network' : id.split('/')[0]);
    const displayName = entry?.displayName ?? sibling?.displayName ?? (id.split('/').pop() ?? id);
    rows.set(id, {
      id,
      object: 'model',
      created: 0,
      owned_by: tag ? 'mesh' : vendor.toLowerCase(),
      name: displayName,
      displayName,
      vendor,
      tier,
      served,
      listPrice: { promptUsdPerM: list.promptUsdPerM, completionUsdPerM: list.completionUsdPerM },
      meshPrice: tag ? flat : upstreamPrice(list),
      privacy: tag ? 'network' : 'upstream_zdr',
      online: onlineFor(tag),
      guestAllowed: guestModelAllowed(ctx, id),
      mesh_network: tag !== null,
    });
  };
  for (const name of networkModelNames(policy)) push(name, prices.models[name]);
  for (const e of catalogueEntries(prices)) push(e.id, e);

  // Network models first (what Mesh is), then frontier, fast, open; stable within a group.
  return [...rows.values()].sort((a, b) => {
    const an = a.served === 'upstream' ? 1 : 0;
    const bn = b.served === 'upstream' ? 1 : 0;
    return an - bn || (an === 0 ? 0 : (TIER_ORDER[a.tier ?? 'open'] ?? 9) - (TIER_ORDER[b.tier ?? 'open'] ?? 9));
  });
}

/** GET /v1/models body. */
export function catalogueView(ctx: AppContext, opts: { guest?: boolean } = {}) {
  const all = catalogueModels(ctx);
  const data = opts.guest ? all.filter((m) => m.guestAllowed) : all;
  const p = ctx.config.requestPricing;
  return {
    object: 'list' as const,
    data,
    pricing: {
      networkPricePerMTokens: p.networkPricePerMTokens,
      upstreamDiscountBps: p.upstreamDiscountBps,
      upstreamMarkupBps: p.upstreamMarkupBps,
      /** Guests: network models plus these tiers. */
      guestTiers: ctx.config.guest.allowedTiers,
    },
  };
}
