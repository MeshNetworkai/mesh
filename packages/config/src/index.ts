import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bps = z.number().int().min(0).max(10_000);

export const StakeTierSchema = z.object({
  name: z.string().min(1),
  minStake: z.number().min(0),
  lockDays: z.number().int().min(0).optional(),
  multiplier: z.number().positive(),
});

export const TokenomicsSchema = z
  .object({
    name: z.string().min(1),
    ticker: z.string().min(1).max(10),
    chain: z.enum(['solana', 'evm']),
    tradeFeeBps: bps,
    holderShareBps: bps,
    treasuryShareBps: bps,
    minHoldTokens: z.number().min(0),
    epochSeconds: z.number().int().positive(),
    creditUsdPerFeeUsd: z.number().min(0),
    requestPricing: z.object({
      mode: z.enum(['passthrough', 'fixed']),
      markupBps: bps,
      /** USD per 1M total tokens charged to the user when a Mesh node serves the request. */
      networkPricePerMTokens: z.number().min(0).default(0.02),
      /**
       * "Network credits": when a Mesh node serves a request the user is billed the flat network
       * price above instead of the model's list price (config/model-prices.json). With showSavings
       * the gateway reports the list cost and the amount saved on every network-served reply
       * (`mesh.listCostUsd`, `mesh.savedUsd`), aggregates savings per wallet (GET /me) and
       * network-wide (GET /stats), and the web app surfaces an "effective multiplier"
       * (list cost ÷ network cost, e.g. "2.4× further").
       */
      showSavings: z.boolean().default(true),
    }),
    /** What a node earns per completed job, accrued in the node_rewards ledger. */
    nodeRewards: z
      .object({
        usdPerMTokens: z.number().min(0).default(0.06),
      })
      .default({ usdPerMTokens: 0.06 }),
    stakeTiers: z.array(StakeTierSchema).min(1),
    /** Distribution-time weighting knobs (all optional; defaults reproduce plain pro-rata). */
    distribution: z
      .object({
        /**
         * Holding-age weighting: weight = timeWeightedBalance × multiplier(age), where the multiplier
         * rises linearly from minMultiplier (age 0) to maxMultiplier (age >= maxDays). A transfer out
         * resets the age. Disabled → multiplier 1 for everyone (identical to plain pro-rata).
         */
        holdingAge: z
          .object({
            enabled: z.boolean().default(false),
            maxDays: z.number().positive().default(30),
            minMultiplier: z.number().positive().default(1.0),
            maxMultiplier: z.number().positive().default(2.0),
          })
          .refine((h) => h.maxMultiplier >= h.minMultiplier, { message: 'maxMultiplier must be >= minMultiplier', path: ['maxMultiplier'] })
          .default({}),
      })
      .default({}),
    geoBlock: z.array(z.string().length(2).toUpperCase()),
    routing: z
      .object({
        /** When true and an online idle node advertises the model's Ollama tag, the request is served by that node. */
        preferNetwork: z.boolean().default(false),
        /** No claim + first chunk within this → job failed, re-queued once or fallback to OpenRouter. */
        firstTokenTimeoutMs: z.number().int().positive().default(8000),
        /** Gap between chunks longer than this → job failed. */
        stallTimeoutMs: z.number().int().positive().default(6000),
        /** Whole job must finish within this (sent to the node as deadlineMs). */
        jobTimeoutMs: z.number().int().positive().default(120_000),
        /** max_tokens sent to the node when the client did not set one. */
        defaultMaxTokens: z.number().int().positive().default(1024),
        /** Nodes with a success rate (last 100 jobs) below this are not routed to. */
        minSuccessRate: z.number().min(0).max(1).default(0.8),
        /** Reputation only applies once a node has at least this many scored jobs. */
        reputationMinJobs: z.number().int().min(1).default(5),
      })
      .default({}),
    /** Node network registration policy. */
    nodes: z
      .object({
        /**
         * When true, POST /nodes/register must carry a wallet signature over the challenge from
         * POST /nodes/register/challenge (proves the reward wallet belongs to the operator).
         * The gateway env NODES_REQUIRE_SIGNATURE overrides this for dev/demo.
         */
        requireSignature: z.boolean().default(true),
        /** Hard cap on nodes a single wallet may register (0 = unlimited). */
        maxPerWallet: z.number().int().min(0).default(20),
      })
      .default({}),
    /**
     * Pre-launch points programme (apps/gateway/src/points.ts). Chain-agnostic: points accrue in the
     * gateway's points_ledger for credits received, credits spent, tokens served by a wallet's nodes
     * and referrals, and convert to MESH at TGE at a ratio set then. See docs/POINTS.md.
     */
    points: z
      .object({
        enabled: z.boolean().default(true),
        /** Points per $1 of credits received (distributions). */
        perUsdCredits: z.number().min(0).default(100),
        /** Points per $1 of credits spent on requests. */
        perUsdSpent: z.number().min(0).default(50),
        /** Points per 1,000 tokens served by the wallet's nodes. */
        perNodeTokenK: z.number().min(0).default(1),
        /** Flat points to the referrer when a referee claims their code. */
        perReferralSignup: z.number().int().min(0).default(500),
        /** Share of a referee's future points also credited to the referrer. */
        referralShareBps: bps.default(1000),
        /** Max points a wallet can earn per UTC day across all kinds (0 = no cap). Admin adjustments are exempt. */
        dailyCapPerWallet: z.number().int().min(0).default(50_000),
      })
      .default({}),
    meta: z
      .object({
        website: z.string().url().optional(),
        description: z.string().max(280).optional(),
        contractAddress: z.string().optional(),
        totalSupply: z.number().nonnegative().optional(),
      })
      .default({}),
  })
  .refine((c) => c.holderShareBps + c.treasuryShareBps === 10_000, {
    message: 'holderShareBps + treasuryShareBps must equal 10000',
    path: ['holderShareBps'],
  });

export type TokenomicsConfig = z.infer<typeof TokenomicsSchema>;
export type StakeTier = z.infer<typeof StakeTierSchema>;

const ModelPriceSchema = z.object({
  promptUsdPerM: z.number().min(0),
  completionUsdPerM: z.number().min(0),
});

export const ModelPricesSchema = z.object({
  _comment: z.string().optional(),
  default: ModelPriceSchema,
  models: z.record(ModelPriceSchema),
});

export type ModelPrices = z.infer<typeof ModelPricesSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** Absolute path of the repo-level `config/` directory. */
export function configDir(): string {
  // dist/index.js -> packages/config -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config');
}

export function parseTokenomics(raw: unknown): TokenomicsConfig {
  return TokenomicsSchema.parse(raw);
}

export function loadTokenomics(path = resolve(configDir(), 'tokenomics.json')): TokenomicsConfig {
  return parseTokenomics(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadModelPrices(path = resolve(configDir(), 'model-prices.json')): ModelPrices {
  return ModelPricesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------- model policy ----------------

export const ModelPolicySchema = z.object({
  _comment: z.string().optional(),
  /** Empty = allow every model the upstream offers. Entries may end in `*` for a prefix match. */
  allow: z.array(z.string().min(1)).default([]),
  /** Always wins over allow. Same pattern rules. */
  deny: z.array(z.string().min(1)).default([]),
  /**
   * Models served by Mesh nodes: a map from the client-facing model name ("llama-3.1-8b") to the
   * Ollama tag nodes advertise ("llama3.1:8b"). A plain array is accepted too (name == tag).
   */
  networkModels: z
    .union([z.record(z.string().min(1), z.string().min(1)), z.array(z.string().min(1))])
    .default({})
    .transform((v) => (Array.isArray(v) ? Object.fromEntries(v.map((m) => [m, m])) : v)),
});

export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

export const DEFAULT_MODEL_POLICY: ModelPolicy = { allow: [], deny: [], networkModels: {} };

export function parseModelPolicy(raw: unknown): ModelPolicy {
  return ModelPolicySchema.parse(raw);
}

export function loadModelPolicy(path = resolve(configDir(), 'model-policy.json')): ModelPolicy {
  return parseModelPolicy(JSON.parse(readFileSync(path, 'utf8')));
}

function matchesPattern(pattern: string, model: string): boolean {
  if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
  return pattern === model;
}

/** deny wins; an empty allow list permits everything. */
export function isModelAllowed(policy: ModelPolicy, model: string): boolean {
  if (policy.deny.some((p) => matchesPattern(p, model))) return false;
  if (policy.allow.length === 0) return true;
  return policy.allow.some((p) => matchesPattern(p, model));
}

/** Ollama tag a Mesh node must advertise to serve `model`, or null when it is not a network model. */
export function networkTagFor(policy: ModelPolicy, model: string): string | null {
  const direct = policy.networkModels[model];
  if (direct) return direct;
  for (const [name, tag] of Object.entries(policy.networkModels)) {
    if (name.endsWith('*') && matchesPattern(name, model)) return tag;
    if (tag === model) return tag; // the node tag itself is also accepted as a model name
  }
  return null;
}

export function isNetworkModel(policy: ModelPolicy, model: string): boolean {
  return networkTagFor(policy, model) !== null;
}

/** Client-facing names of every network model (for /v1/models). */
export function networkModelNames(policy: ModelPolicy): string[] {
  return Object.keys(policy.networkModels).filter((n) => !n.endsWith('*'));
}

/** Resolve the fallback price for a model id (exact match, else default). */
export function priceForModel(prices: ModelPrices, model: string): ModelPrice {
  return prices.models[model] ?? prices.default;
}

/**
 * List price for a model as the upstream would charge it. Network models often have a short
 * client-facing alias ("llama-3.1-8b") next to the upstream id ("meta-llama/llama-3.1-8b-instruct");
 * both map to the same Ollama tag, so when the alias has no price entry the priced sibling with
 * the same tag is used before falling back to `prices.default`.
 */
export function listPriceForModel(prices: ModelPrices, policy: ModelPolicy, model: string): ModelPrice {
  const direct = prices.models[model];
  if (direct) return direct;
  const tag = networkTagFor(policy, model);
  if (tag) {
    for (const [name, t] of Object.entries(policy.networkModels)) {
      if (t === tag && name !== model && prices.models[name]) return prices.models[name];
    }
  }
  return prices.default;
}

/** Highest stake tier whose minStake <= stake. */
export function tierForStake(config: TokenomicsConfig, stake: number): StakeTier {
  return [...config.stakeTiers]
    .sort((a, b) => a.minStake - b.minStake)
    .reduce((best, t) => (stake >= t.minStake ? t : best), config.stakeTiers[0]);
}
