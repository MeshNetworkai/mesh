import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bps = z.number().int().min(0).max(10_000);

/** Request privacy tiers, in order of strictness (docs/PRIVACY.md). */
export const PRIVACY_TIERS = ['trusted', 'network', 'upstream_zdr'] as const;
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];
export function isPrivacyTier(v: unknown): v is PrivacyTier {
  return typeof v === 'string' && (PRIVACY_TIERS as readonly string[]).includes(v);
}

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
    /**
     * Which `config/deploy.<network>.json` the live adapter loads (MESH_DEPLOY_NETWORK overrides).
     * `robinhood` = Robinhood Chain mainnet via Pons; `robinhood-testnet` for the rehearsal.
     */
    deployNetwork: z.string().min(1).optional(),
    tradeFeeBps: bps,
    holderShareBps: bps,
    treasuryShareBps: bps,
    minHoldTokens: z.number().min(0),
    epochSeconds: z.number().int().positive(),
    creditUsdPerFeeUsd: z.number().min(0),
    requestPricing: z
      .object({
        mode: z.enum(['passthrough', 'fixed']),
        /** @deprecated alias of `upstreamMarkupBps`; folded into it at parse time. */
        markupBps: bps.default(0),
        /**
         * Upstream-served requests (docs/PRICING.md): the user is billed the upstream list price plus this
         * markup, or minus `upstreamDiscountBps`. Exactly one of the two may be non-zero. Credits are USD,
         * so a 2000 bps discount bills list × 0.8 and the treasury funds the gap, like the network gap.
         */
        upstreamMarkupBps: bps.default(0),
        upstreamDiscountBps: bps.default(0),
        /**
         * What the upstream charges Mesh on top of list when Mesh buys its inference credits (a platform /
         * top-up fee, e.g. 550 = 5.5%). The real cost of an upstream-served request is list × (1 + this), so
         * the margin the usage share splits (usage-share.ts) is `billed − list × (1 + upstreamFeeBps)`: a
         * markup that only covers this fee is not a margin and pays nothing out. 0 = the upstream bills list.
         */
        upstreamFeeBps: bps.default(0),
        /** USD per 1M total tokens charged to the user when a Mesh node serves the request. */
        networkPricePerMTokens: z.number().min(0).default(0.08),
        /**
         * "Network credits": when a Mesh node serves a request the user is billed the flat network
         * price above instead of the model's list price (config/model-prices.json). With showSavings
         * the gateway reports the list cost and the amount saved on every network-served reply
         * (`mesh.listCostUsd`, `mesh.savedUsd`), aggregates savings per wallet (GET /me) and
         * network-wide (GET /stats), and the web app surfaces an "effective multiplier"
         * (list cost ÷ network cost, e.g. "2.4× further").
         */
        showSavings: z.boolean().default(true),
      })
      .transform((p) => (p.upstreamMarkupBps === 0 && p.markupBps > 0 ? { ...p, upstreamMarkupBps: p.markupBps } : p))
      .refine((p) => p.upstreamMarkupBps === 0 || p.upstreamDiscountBps === 0, {
        message: 'upstreamMarkupBps and upstreamDiscountBps are exclusive: set one of them, not both',
        path: ['upstreamDiscountBps'],
      }),
    /** What a node earns per completed job, accrued in the node_rewards ledger. */
    nodeRewards: z
      .object({
        usdPerMTokens: z.number().min(0).default(0.06),
        /**
         * Ceiling on what one job may pay its node, as a share of what the user was billed for it
         * (9000 = 90%). A stake multiplier can lift a reward up to this share and no further, so the
         * network leg always keeps a margin (which also pays for spot-check re-runs). 10000 = up to the
         * whole price (the old behaviour: a staked node left no margin).
         */
        maxShareOfPriceBps: bps.default(10_000),
        /**
         * How node rewards are paid (apps/gateway/src/node-payouts.ts). When enabled, every reward that has
         * been accrued for `holdSeconds` is paid to the operator's wallet as AI credits, off chain, by the
         * chores that follow each epoch: one `node_payout` row in `credits_ledger` per wallet per run. The
         * credits are ordinary ones: they spend on any model, can be listed on the marketplace and expire
         * like any other. Disabled, rewards stay a counter.
         */
        payout: z
          .object({
            enabled: z.boolean().default(false),
            /** A reward waits this long before it is paid, so a spot check can still withhold it. */
            holdSeconds: z.number().int().min(0).default(3600),
            /** Smallest payout written to a wallet's ledger, USD; less than this waits and accumulates. */
            minUsd: z.number().min(0).default(0.01),
          })
          .default({}),
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
        /** Most completion tokens one node job may be asked for, whatever the client sent (a local model's output window). */
        nodeMaxTokens: z.number().int().positive().default(8192),
        /**
         * max_tokens sent to the upstream when the client did not set one. The gateway reserves the
         * cost of the whole cap before the request starts (apps/gateway/src/reserve.ts), so there is
         * always one; a client that wants longer answers sets max_tokens itself.
         */
        upstreamDefaultMaxTokens: z.number().int().positive().default(8192),
        /** Nodes with a success rate (last 100 jobs) below this are not routed to. */
        minSuccessRate: z.number().min(0).max(1).default(0.8),
        /** Reputation only applies once a node has at least this many scored jobs. */
        reputationMinJobs: z.number().int().min(1).default(5),
        /**
         * When every eligible node advertising the tag is online but at capacity, the job is queued
         * and waits up to this long for a claim before falling back to the upstream (0 = never queue,
         * go straight upstream as before).
         */
        queueWaitMs: z.number().int().min(0).default(6000),
        /** Queued jobs allowed per online eligible node (queue depth cap = nodes × this); beyond it requests go upstream. */
        maxQueueDepthPerNode: z.number().int().min(0).default(3),
        /** Hard cap on the `maxParallel` a node may advertise on register/heartbeat (concurrent jobs per node). */
        maxParallelPerNode: z.number().int().min(1).default(4),
      })
      .default({}),
    /**
     * Request privacy tiers (docs/PRIVACY.md). `trusted` = nodes whose reward wallet is allowlisted,
     * or that hold at least `trustedMinStakeTier` AND signed the operator pledge; `network` = any
     * eligible node; `upstream_zdr` = OpenRouter with zero-data-retention providers only.
     */
    privacy: z
      .object({
        /** Tier used when neither the request nor the API key picks one. */
        default: z.enum(PRIVACY_TIERS).default('trusted'),
        /**
         * Where a `trusted` request goes when no trusted node is online. `network` is only honoured
         * when the tier came from this default; a request that asked for trusted explicitly (header,
         * body or key) never silently drops to `network` and goes to `upstream_zdr` instead.
         */
        fallback: z.enum(['upstream_zdr', 'network']).default('upstream_zdr'),
        /** Reward wallets whose nodes are trusted without staking or pledging. */
        trustedWallets: z.array(z.string().min(1)).default([]),
        /** Name of the stake tier (stakeTiers[].name) a wallet needs, together with the pledge, to be trusted. */
        trustedMinStakeTier: z.string().min(1).default('gold'),
        /** Which tiers clients may ask for. Disabling one makes requests for it a 400. */
        tiers: z
          .object({
            trusted: z.boolean().default(true),
            network: z.boolean().default(true),
            upstream_zdr: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    /**
     * Spot-check verification of node work (apps/gateway/src/verification.ts, docs/NODE_PROTOCOL.md §10).
     * A sampled fraction of network-served jobs is re-run on a second node (or the upstream) at
     * temperature 0 after the client has its answer; the two outputs are compared and a `mismatch`
     * costs the primary node reputation and that job's reward. Repeated mismatches quarantine the node.
     */
    verification: z
      .object({
        enabled: z.boolean().default(false),
        /** Fraction of eligible jobs re-checked (0..1). New nodes are sampled at 3× this rate. */
        sampleRate: z.number().min(0).max(1).default(0.05),
        /** A node with fewer scored jobs than this is "new" and sampled at 3× `sampleRate`. */
        minJobsBeforeTrust: z.number().int().min(0).default(20),
        /** One `mismatch` verdict counts as this many node-fault failures in the reputation window. */
        mismatchPenalty: z.number().int().min(1).default(3),
        /** Mismatches within the reputation window that quarantine the node until an admin clears it. */
        quarantineAfterMismatches: z.number().int().min(1).default(2),
      })
      .default({}),
    /**
     * Public beta gating (docs/RUNBOOK.md "Public beta rollout"). With `inviteRequired`, a wallet
     * signs in (and registers nodes) only once admitted: either with an invite code on /auth/verify
     * or because an admin admitted it from the waitlist. `label` is what the web app shows in the pill.
     */
    beta: z
      .object({
        enabled: z.boolean().default(false),
        label: z.string().min(1).max(24).default('Beta'),
        inviteRequired: z.boolean().default(false),
        /** Default number of waitlist entries POST /admin/waitlist/admit admits per call. */
        batchSize: z.number().int().min(1).max(5000).default(200),
      })
      .default({}),
    /**
     * Guest chat (apps/gateway/src/routes/guest.ts): homepage visitors get a few free messages a day
     * without signing in, keyed by client IP. Served under the `network` privacy tier (Mesh nodes
     * first, ZDR upstream fallback) and paid for by the treasury (`guest_chat` treasury rows).
     * Disabled → /v1/guest/* is a 404.
     */
    guest: z
      .object({
        enabled: z.boolean().default(false),
        /** Free messages per client IP per rolling 24h. */
        messagesPerDay: z.number().int().min(0).default(5),
        /** Hard cap on completion tokens per guest message. */
        maxTokens: z.number().int().positive().default(400),
        /** Hard cap on total prompt characters (all messages' content). */
        maxInputChars: z.number().int().positive().default(2000),
        /** Model used when the request does not name one. */
        model: z.string().min(1).default('llama-3.1-8b'),
        /** Catalogue tiers a guest may pick from (network models are always allowed). */
        allowedTiers: z.array(z.enum(['frontier', 'fast', 'open'])).default(['open', 'fast']),
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
     *
     * Status: built, disabled. The owner decided not to run the programme at launch, so `enabled`
     * defaults to false; when off the gateway 404s /points/*, /leaderboard/*, /referrals/*,
     * /me/points and /me/referral, awards nothing, and the web app hides every points surface.
     */
    points: z
      .object({
        enabled: z.boolean().default(false),
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
    /**
     * Credit marketplace (apps/gateway/src/market.ts, docs/MARKETPLACE.md): holders list unused credits
     * at a discount; buyers pay the discounted price from a prepaid USD balance and receive the credits
     * at face value. Mesh keeps `feeBps` of the price; `feeToHoldersBps` of that fee joins the next
     * hourly holder pool, the rest is booked to the treasury.
     */
    marketplace: z
      .object({
        enabled: z.boolean().default(true),
        /** Mesh fee on the discounted price (250 = 2.5%). */
        feeBps: bps.default(250),
        /** Share of the fee that joins the next epoch's holder pool (5000 = half); the rest is treasury. */
        feeToHoldersBps: bps.default(5000),
        /** Smallest listing a seller may create, USD of credit at face value. */
        minListingUsd: z.number().positive().default(1),
        /** Largest discount a seller may offer (7000 = 70% off face). */
        maxDiscountBps: bps.default(7000),
        /** Open listings expire (escrow returns to the seller) after this many hours. */
        listingTtlHours: z.number().int().positive().default(168),
        /**
         * The stablecoin the marketplace settles in: what buyers deposit into the prepaid balance and what
         * sellers are paid when they withdraw. Credits themselves never go on chain; only this side does.
         * A name for copy and operator messages; the token's address is in `deposits.tokens`.
         */
        settlementSymbol: z.string().min(1).max(12).default('USDC'),
        /**
         * Self-serve top-ups: a buyer sends a stablecoin on the EVM chain to `receiver`, pastes the tx hash,
         * the gateway verifies the ERC-20 Transfer on chain and credits the prepaid balance. Off while
         * `receiver` or `tokens` are empty (the admin tops balances up by hand).
         */
        deposits: z
          .object({
            enabled: z.boolean().default(true),
            chainId: z.number().int().positive().default(4663),
            /** Address that receives deposits (the treasury multisig or a dedicated deposit wallet). */
            receiver: z.string().nullable().default(null),
            tokens: z.array(z.object({ symbol: z.string().min(1), address: z.string().min(1), decimals: z.number().int().min(0).max(18).default(6) })).default([]),
            /** Smallest deposit credited, USD. */
            minUsd: z.number().positive().default(5),
            /** Blocks a deposit must be behind the head before it is credited. */
            confirmations: z.number().int().min(0).default(3),
          })
          .default({}),
      })
      .default({}),
    /**
     * Usage-revenue share (docs/PRICING.md "Engine 2"): holders earn from paid inference, not only from
     * trading fees. Whenever a paid request is recorded the gateway computes the margin Mesh made on it
     * (network: user price − node reward; upstream: billed − upstream cost, where the cost is list plus
     * `requestPricing.upstreamFeeBps`) and, when enabled and the margin is positive, books `holderBps` of it
     * into the next hourly holder pool (`pool_extra_micros`, source `usage`); the rest stays with the
     * treasury. Guest messages never contribute. Schema default off; on in config/tokenomics.json.
     */
    usageShare: z
      .object({
        enabled: z.boolean().default(false),
        /** Share of each positive margin that joins the holder pool. */
        holderBps: bps.default(3000),
        /** Share that stays with the treasury. holderBps + treasuryBps must equal 10000. */
        treasuryBps: bps.default(7000),
        /**
         * Which margins count. `network` and `upstream` gate the contribution itself. The marketplace fee's
         * holder share is always paid to the pool (marketplace.feeToHoldersBps, market.ts); `marketplaceFee`
         * only decides whether it is counted in the usage-share report (/report totals.usageShare).
         */
        sources: z
          .object({
            network: z.boolean().default(true),
            upstream: z.boolean().default(true),
            marketplaceFee: z.boolean().default(true),
          })
          .default({}),
      })
      .refine((u) => u.holderBps + u.treasuryBps === 10_000, { message: 'usageShare.holderBps + treasuryBps must equal 10000', path: ['holderBps'] })
      .default({}),
    /**
     * Starter credits on first connect (apps/gateway/src/starter.ts, docs/SWITCHING.md): the first time a wallet
     * ever signs in, the gateway credits `amountUsd` to it (ledger kind `starter`, ref `starter:auto`) so a
     * developer switching from another OpenAI-compatible gateway can make a key and send a request before
     * holding or buying anything. Once per wallet (`starter_grants`), at most `maxWallets` wallets in total,
     * and at most 3 grants per client-IP hash per day against sybil farming. Admins can pause it at runtime
     * (POST /admin/starter/toggle) without a redeploy.
     */
    starterCredits: z
      .object({
        enabled: z.boolean().default(false),
        /** USD credited to each newly connected wallet. */
        amountUsd: z.number().min(0).max(100).default(2),
        /** Total wallets that may ever receive the grant (0 = unlimited). */
        maxWallets: z.number().int().min(0).default(500),
        /** When true the wallet must also hold at least `minHoldTokens` to qualify. */
        requireMinHold: z.boolean().default(false),
        /** Grants allowed per client-IP hash per rolling 24h. */
        maxPerIpPerDay: z.number().int().min(1).default(3),
        /**
         * When false, starter credits can only be spent on inference: whatever is left of a wallet's
         * grant is held back from marketplace listings (apps/gateway/src/expiry.ts `nonTransferableMicros`).
         * Requests spend the grant first, so earned and bought credits stay listable.
         */
        transferable: z.boolean().default(true),
      })
      .default({}),
    /**
     * Credit expiry (apps/gateway/src/expiry.ts): every credit lapses `days` after it landed in the wallet,
     * whatever its source (distribution, starter, bought on the marketplace, bought directly). Requests and
     * listings spend the oldest credit first. Lapsed credit is debited with an `expiry` ledger row; it lowers
     * what the reserve has to cover, so its backing shows up as reserve surplus (reserve-report.ts). A listing
     * does not stop the clock: credit refunded from a cancelled or expired listing keeps its original date.
     */
    creditExpiry: z
      .object({
        enabled: z.boolean().default(false),
        days: z.number().int().positive().default(90),
      })
      .default({}),
    /**
     * Direct credit sales (apps/gateway/src/direct-sales.ts): a wallet buys credits from Mesh at face value
     * with its prepaid USD balance (funded by a stablecoin deposit), so usage does not depend on anyone
     * holding the token or on a seller being on the marketplace. The payment backs the credit 1:1; Mesh
     * earns the same margin when it is spent as on any other credit.
     */
    directSales: z
      .object({
        enabled: z.boolean().default(false),
        /** Smallest and largest single purchase, USD of credit. */
        minUsd: z.number().positive().default(1),
        maxUsd: z.number().positive().default(10_000),
      })
      .refine((d) => d.maxUsd >= d.minUsd, { message: 'directSales.maxUsd must be >= minUsd', path: ['maxUsd'] })
      .default({}),
    /**
     * Credit reserve (apps/gateway/src/reserve-report.ts): the holder share of every sweep is settled in a
     * stablecoin and kept in the credit-pool wallet, apart from the treasury. Each epoch the gateway reads
     * that balance and publishes it next to the credits outstanding (GET /report `totals.reserve`).
     * `minCoverageBps` is the level below which the report flags the reserve as short (10000 = fully backed).
     */
    reserve: z
      .object({
        minCoverageBps: z.number().int().min(0).default(10_000),
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

/** Catalogue tier (GET /v1/models, the web model picker): frontier closed models, fast/cheap closed models, open-weight models. */
export const MODEL_TIERS = ['frontier', 'fast', 'open'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const ModelPriceSchema = z.object({
  /** OpenRouter list price, USD per 1M prompt tokens. */
  promptUsdPerM: z.number().min(0),
  /** OpenRouter list price, USD per 1M completion tokens. */
  completionUsdPerM: z.number().min(0),
  /** Present on curated catalogue entries only; a price-only entry is a billing fallback and is not listed. */
  tier: z.enum(MODEL_TIERS).optional(),
  vendor: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  /** Free-text provenance for hand-set prices (network-only models without an upstream sibling). */
  note: z.string().optional(),
});

export const ModelPricesSchema = z.object({
  _comment: z.string().optional(),
  /** Set by scripts/refresh-model-prices.mjs. */
  _source: z.string().optional(),
  _refreshedAt: z.string().optional(),
  default: ModelPriceSchema,
  models: z.record(ModelPriceSchema),
});

export type ModelPrices = z.infer<typeof ModelPricesSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** A curated catalogue entry: a priced model with a tier (config/model-prices.json). */
export interface CatalogueEntry extends ModelPrice {
  id: string;
  tier: ModelTier;
  vendor: string;
  displayName: string;
}

/** The curated catalogue: every priced model that carries a tier, in file order. */
export function catalogueEntries(prices: ModelPrices): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const [id, p] of Object.entries(prices.models)) {
    if (!p.tier) continue;
    out.push({ ...p, id, tier: p.tier, vendor: p.vendor ?? id.split('/')[0], displayName: p.displayName ?? id.split('/').pop() ?? id });
  }
  return out;
}

export type UpstreamPricing = Pick<TokenomicsConfig['requestPricing'], 'upstreamMarkupBps' | 'upstreamDiscountBps'>;

/**
 * What the user is billed for an upstream-served request, from the upstream's own cost in micro-USD:
 * list × (1 + markup) or list × (1 − discount). Integer micros; the discount is floored so the user
 * is never under-billed by rounding, the markup is floored so they are never over-billed.
 */
export function upstreamBilledMicros(listMicros: number, pricing: UpstreamPricing): number {
  if (pricing.upstreamMarkupBps > 0) return listMicros + Math.floor((listMicros * pricing.upstreamMarkupBps) / 10_000);
  if (pricing.upstreamDiscountBps > 0) return listMicros - Math.floor((listMicros * pricing.upstreamDiscountBps) / 10_000);
  return listMicros;
}

/**
 * What an upstream-served request really costs Mesh, from the upstream's list cost in micro-USD:
 * list × (1 + upstreamFeeBps). Rounded up so a margin is never overstated.
 */
export function upstreamCostMicros(listMicros: number, pricing: Pick<TokenomicsConfig['requestPricing'], 'upstreamFeeBps'>): number {
  return pricing.upstreamFeeBps > 0 ? listMicros + Math.ceil((listMicros * pricing.upstreamFeeBps) / 10_000) : listMicros;
}

/** Per-1M-token price after the upstream markup/discount (what GET /v1/models reports as `meshPrice`). */
export function meshPricePerM(listUsdPerM: number, pricing: UpstreamPricing): number {
  const factor = pricing.upstreamMarkupBps > 0 ? 1 + pricing.upstreamMarkupBps / 10_000 : 1 - pricing.upstreamDiscountBps / 10_000;
  return Math.round(listUsdPerM * factor * 1e6) / 1e6;
}

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

/**
 * Id to send the upstream for a client-facing model name. Short aliases ("llama-3.1-8b") are not valid
 * OpenRouter ids; when the alias maps to a network tag, the sibling alias that looks like a full
 * upstream id ("meta-llama/llama-3.1-8b-instruct", i.e. contains a "/") is used. Anything else is
 * forwarded unchanged.
 */
export function upstreamModelFor(policy: ModelPolicy, model: string): string {
  if (model.includes('/')) return model;
  const tag = networkTagFor(policy, model);
  if (!tag) return model;
  for (const [name, t] of Object.entries(policy.networkModels)) {
    if (t === tag && name.includes('/') && !name.startsWith('mesh/')) return name;
  }
  return model;
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
