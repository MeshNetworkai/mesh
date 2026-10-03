// Shapes returned by apps/gateway (see apps/gateway/src/routes/*.ts). Keep in sync with
// `computeStats`, `publicEpochView`, `publicKeyView` and the /keys/:id/usage handler.

/** One row of GET /epochs and /stats.lastEpoch. */
export interface EpochSummary {
  epochStart: number;
  epochEnd: number;
  eligibleHolders: number;
  feesUsd: number;
  /** 'complete' | 'empty' | 'failed' */
  status: string;
  holderPoolUsd?: number;
  treasuryUsd?: number;
  createdAt?: number;
}

export interface EpochsResponse {
  epochs: EpochSummary[];
  total: number;
  limit: number;
  epochSeconds: number;
  generatedAt: number;
}

/** One hourly bucket of /stats.series24h (24 buckets, oldest first, `hour` = unix seconds at the top of the hour). */
export interface HourPoint {
  hour: number;
  feesUsd: number;
  creditsDistributedUsd: number;
  requests: number;
  spendUsd: number;
}

export interface TokenMeta {
  name: string;
  ticker: string;
  chain: string;
  tradeFeeBps: number;
  holderShareBps: number;
  treasuryShareBps: number;
  minHoldTokens: number;
  epochSeconds: number;
  website?: string;
  description?: string;
  contractAddress?: string | null;
  totalSupply?: number;
}

export interface Stats {
  token: TokenMeta;
  totalFeesUsd: number;
  creditsDistributedUsd: number;
  creditsUsedUsd: number;
  epochsRun: number;
  lastEpoch: EpochSummary | null;
  holdersEligibleLastEpoch: number;
  /** Fees accrued since the last epoch. null when the adapter cannot report it cheaply (real chains). */
  feesThisEpochUsd: number | null;
  requestsLast24h: number;
  spendLast24hUsd: number;
  nodesOnline: number;
  servedByNetworkPercent: number;
  /** USD saved across all wallets in the last 24h by Mesh nodes serving at the network price. */
  networkSavingsUsd24h?: number;
  showSavings?: boolean;
  /** Points / leaderboard / referral programme is live. Built but disabled by default; every points surface is hidden when false. */
  pointsEnabled?: boolean;
  /** Public beta gating: pill in the nav/hero; with `inviteRequired` the landing CTA is the waitlist and sign-in may ask for a code. */
  beta?: BetaInfo;
  /** Spot-check verification of node work is on (docs/NODE_PROTOCOL.md §10). */
  verificationEnabled?: boolean;
  series24h: HourPoint[];
  epochSeconds: number;
  upstream: string;
  generatedAt: number;
}

/** `beta` block on GET /stats (and on 403 invite_required bodies). */
export interface BetaInfo {
  enabled: boolean;
  label: string;
  inviteRequired: boolean;
}

/** POST /waitlist response. */
export interface WaitlistJoin {
  ok: true;
  /** 1-based place among entries not yet invited; 0 once invited. */
  position: number;
  alreadyListed: boolean;
  beta: BetaInfo;
}

/** GET /nodes: public summary only (no URLs or wallets). */
export interface NodesSummary {
  online: number;
  total: number;
  busy: number;
  idle: number;
  totalRamGb: number;
  /** chip label -> count of online nodes */
  chips: Record<string, number>;
  /** model id -> count of online nodes offering it */
  models: Record<string, number>;
  offlineAfterSec: number;
}

export interface LedgerRow {
  id: number;
  kind: 'distribution' | 'usage' | 'starter' | string;
  deltaUsd: number;
  deltaUsdMicros: number;
  ref: string | null;
  created_at: number;
}

/** Request privacy tiers (docs/PRIVACY.md). */
export type PrivacyTier = 'trusted' | 'network' | 'upstream_zdr';
export const PRIVACY_TIERS: PrivacyTier[] = ['trusted', 'network', 'upstream_zdr'];

/** One line per tier, shown wherever a tier is picked. */
export const PRIVACY_TIER_INFO: Record<PrivacyTier, { label: string; blurb: string }> = {
  trusted: { label: 'Trusted nodes', blurb: 'Your own Macs, allowlisted operators, and gold-staked pledged operators. Falls back to ZDR upstream, never to other nodes.' },
  network: { label: 'Any network node', blurb: 'Any online Mesh node. Cheapest and fastest; the operator could in principle read the plaintext while serving it.' },
  upstream_zdr: { label: 'Upstream (ZDR)', blurb: 'Skip the network: OpenRouter with zero-data-retention providers only. Billed at list price.' },
};

/** `mesh.servedBy` label from the final chunk. */
export type ServedBy = 'your node' | 'trusted node' | 'network node' | 'upstream (ZDR)' | 'upstream';

export interface ApiKey {
  id: number;
  masked: string;
  name: string | null;
  /** legacy alias of `name` */
  label: string | null;
  /** lifetime cap in USD; null = none */
  spendLimitUsd: number | null;
  /** lifetime spend in USD */
  spentUsd: number;
  created_at: number;
  revoked: boolean;
  /** Default privacy tier for requests with this key; null = gateway default (trusted). */
  privacy?: PrivacyTier | null;
}

/** GET /me.savings — "network credits": what the wallet saved because Mesh nodes served its requests at the network price. */
export interface Savings {
  usd24h: number;
  usdTotal: number;
  /** Share of the wallet's requests served by Mesh nodes (all time), 0..100. */
  networkSharePercent: number;
  /** list cost ÷ network cost over network-served requests ("2.4× further"); 1 when nothing was saved. */
  multiplier: number;
  networkSpendUsdTotal: number;
  networkRequests: number;
  requests: number;
}

export interface Me {
  wallet: string;
  chain: string;
  balance: { usd: number; usdMicros: number };
  ledger: LedgerRow[];
  apiKeys: ApiKey[];
  savings?: Savings;
}

export interface CreatedKey {
  id: number;
  key: string;
  prefix: string;
  name: string | null;
  spendLimitUsd: number | null;
  privacy?: PrivacyTier | null;
  note?: string;
}

export interface UsageWindow {
  requests: number;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
}

/** GET /keys/:id/usage */
export interface KeyUsage {
  key: ApiKey;
  last24h: UsageWindow;
  last7d: UsageWindow;
  allTime: UsageWindow & { requestCount: number };
  requestCount: number;
  topModels: Array<{ model: string; requests: number; spendUsd: number }>;
}

export interface Model {
  id: string;
  name?: string;
  owned_by?: string;
  mesh_network?: boolean;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

/** `mesh` object on the final chunk / JSON body of a chat completion served by a Mesh node. */
export interface MeshRoute {
  /** `node` when a Mesh node served it, else the upstream's name. */
  route: 'node' | 'openrouter' | 'mock' | string;
  nodeId?: string;
  chip?: string | null;
  jobId?: string;
  attempt?: number;
  /** Tier the reply was actually served under, and the human label for it (docs/PRIVACY.md). */
  privacy?: PrivacyTier | string;
  servedBy?: ServedBy | string;
  /** What the upstream would have charged at list price (USD). Present when requestPricing.showSavings. */
  listCostUsd?: number;
  savedUsd?: number;
}

export interface Session {
  /** Bearer JWT for API clients. In the web app this is `COOKIE_SESSION`: the JWT lives in the HttpOnly cookie. */
  token: string;
  wallet: string;
  chain: string;
}

/** POST /nodes/register/challenge — the text the reward wallet signs to prove ownership. */
export interface RegisterChallenge {
  wallet: string;
  nonce: string;
  nodeId: string | null;
  domain: string;
  expiresAt: string;
  message: string;
  requireSignature: boolean;
}

/** POST /nodes/link — a one-time code the Mac uses instead of a wallet key (`mesh-node setup --link <code>`). */
export interface LinkCode {
  code: string;
  wallet: string;
  chain: string;
  expiresAt: string;
  expiresInSec: number;
}

/** POST /auth/nonce */
export interface NonceResponse {
  wallet: string;
  nonce: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  expiresInSec: number;
  /** The exact text the wallet must sign; echoed back to /auth/verify. */
  message: string;
}

/** One of the signed-in wallet's nodes (GET /me/nodes). Stats fields may be inlined by the gateway or come from GET /nodes/:id. */
export interface MyNode {
  nodeId: string;
  chip: string | null;
  ramGb: number | null;
  models: string[];
  /** 'online' | 'busy' | 'offline' */
  status: string;
  lastSeen: number | null;
  agentVersion?: string | null;
  createdAt?: number | null;
}

/** Operator pledge status for a node (GET /nodes/:id → pledge, GET/POST /nodes/:id/pledge). */
export interface NodePledge {
  signed: boolean;
  signedAt: number | null;
  chain?: string | null;
  trusted: boolean;
  trustedVia: 'allowlist' | 'stake+pledge' | null;
  allowlisted: boolean;
  /** Stake tier name needed (with the pledge) to be trusted; null when the gateway has no such tier. */
  requiredStakeTier: string | null;
  stakeTier: string | null;
  stakeOk: boolean;
}

/** GET /nodes/:id/pledge — the exact text the owner signs plus the current status. */
export interface PledgeText extends NodePledge {
  nodeId: string;
  wallet: string;
  message: string;
}

/** Spot-check verification counters for one node (GET /nodes/:id → verification; docs/NODE_PROTOCOL.md §10). */
export interface NodeVerification {
  checked: number;
  ok: number;
  suspect: number;
  mismatch: number;
  inconclusive: number;
  lastVerdict: 'ok' | 'suspect' | 'mismatch' | 'inconclusive' | null;
  lastAt: number | null;
  quarantined: boolean;
  quarantinedAt: number | null;
  quarantineReason: string | null;
  enabled?: boolean;
  sampleRate?: number;
}

/** GET /nodes/:id — per-node stats, node token or session bearer. */
export interface NodeStats {
  nodeId?: string;
  status: string;
  quarantined?: boolean;
  uptimePct24h: number;
  jobs24h: number;
  tokens24h: number;
  earnedUsd24h: number;
  earnedUsdTotal: number;
  lastSeen: number | null;
  chip?: string | null;
  ramGb?: number | null;
  models?: string[];
  pledge?: NodePledge;
  verification?: NodeVerification;
}

/** What the Node page renders: /me/nodes row merged with its /nodes/:id stats (null while loading or when unavailable). */
export interface NodeView extends MyNode {
  stats: NodeStats | null;
}

// ---------- public treasury report (GET /report, GET /report/weekly/:isoWeek) ----------

/** Totals for one period (all time, 7d, 30d, a week, a day). */
export interface PeriodTotals {
  feesInUsd: number;
  creditsOutUsd: number;
  starterCreditsUsd: number;
  creditsUsedUsd: number;
  nodeRewardsUsd: number;
  treasuryInUsd: number;
  requests: number;
  servedByNetwork: number;
  servedByOpenRouter: number;
  servedByNetworkPercent: number;
  epochs: number;
  completeEpochs: number;
}

export interface WeekReport extends PeriodTotals {
  /** `YYYY-Www` (ISO 8601, UTC) */
  isoWeek: string;
  start: number;
  end: number;
  current: boolean;
}

export interface ReportMethod {
  credits: string;
  attribution: string;
  treasury: string;
  network: string;
}

export interface Report {
  token: { name: string; ticker: string; chain: string; holderShareBps: number; treasuryShareBps: number };
  totals: PeriodTotals & {
    creditsOutstandingUsd: number;
    walletsWithCredits: number;
    treasury: { feeShareUsd: number; nodeRewardAccrualUsd: number; buybackUsd: number; opsUsd: number; otherUsd: number; balanceUsd: number };
  };
  last7d: PeriodTotals;
  last30d: PeriodTotals;
  /** oldest first, 12 weeks including the current one */
  byWeek: WeekReport[];
  feesIn: number;
  creditsOut: number;
  nodeRewards: number;
  treasuryBalanceUsd: number;
  servedByNetworkPercent: number;
  epochsRun: number;
  holdingAge: { enabled: boolean; maxDays: number; minMultiplier: number; maxMultiplier: number };
  method: ReportMethod;
  lastUpdated: number | null;
  generatedAt: number;
}

export interface WeekDetail extends WeekReport {
  days: Array<PeriodTotals & { day: string; start: number; end: number }>;
  epochDetails: EpochSummary[];
  previous: string;
  next: string | null;
  method: ReportMethod;
  generatedAt: number;
}

// ---------- operator surface (GET /admin/overview etc, ADMIN_TOKEN) ----------

export interface AdminEpoch extends EpochSummary {
  feeTxId: string | null;
}

export interface AdminNode {
  nodeId: string;
  wallet: string;
  url: string;
  models: string[];
  chip: string | null;
  ramGb: number | null;
  busy: boolean;
  lastSeen: number;
  online: boolean;
  quarantined?: boolean;
  verification?: NodeVerification;
}

/** Admin overview → verification: network-wide spot-check counters and the latest verdicts. */
export interface AdminVerification {
  checked: number;
  ok: number;
  suspect: number;
  mismatch: number;
  inconclusive: number;
  quarantinedNodes: number;
  recent: Array<{ id: number; jobId: string; checkJobId: string | null; primaryNode: string; checkNode: string; score: number | null; verdict: string; reasons: string[]; createdAt: number }>;
  config: { enabled: boolean; sampleRate: number; minJobsBeforeTrust: number; mismatchPenalty: number; quarantineAfterMismatches: number };
}

/** Admin overview → beta: config + waitlist counters. */
export interface AdminBeta extends BetaInfo {
  batchSize: number;
  total: number;
  waiting: number;
  invited: number;
  admitted: number;
  liveCodes: number;
  liveUses: number;
}

export interface WaitlistEntry {
  id: number;
  wallet: string | null;
  email: string | null;
  code: string | null;
  createdAt: number;
  invitedAt: number | null;
}

export interface AdminWaitlist {
  counts: Omit<AdminBeta, keyof BetaInfo | 'batchSize'>;
  beta: BetaInfo & { batchSize: number };
  entries: WaitlistEntry[];
}

export interface AdmitResult {
  requested: number;
  admitted: number;
  entries: WaitlistEntry[];
  counts: AdminWaitlist['counts'];
}

export interface InvitesResult {
  count: number;
  uses: number;
  codes: string[];
}

export interface AdminError {
  id: number;
  route: string;
  status: number;
  code: string;
  message: string;
  created_at: number;
}

export interface AdminAction {
  id: number;
  action: string;
  payload: unknown;
  created_at: number;
}

export interface AdminOverview {
  time: number;
  upstream: string;
  adapter: string;
  chain: string;
  epochs: AdminEpoch[];
  totals: {
    feesUsd: number;
    treasuryUsd: number;
    creditsDistributedUsd: number;
    starterCreditsUsd: number;
    creditsUsedUsd: number;
    creditsOutstandingUsd: number;
    wallets: number;
    activeApiKeys: number;
    requests: number;
    requests24h: number;
    nodeRewardsUsd: number;
    treasuryBalanceUsd: number;
  };
  holdingAge: { enabled: boolean; maxDays: number; minMultiplier: number; maxMultiplier: number };
  topHolders: Array<{ wallet: string; balanceUsd: number; earnedUsd: number; usedUsd: number }>;
  nodes: AdminNode[];
  verification?: AdminVerification;
  beta?: AdminBeta;
  recentErrors: AdminError[];
  recentAdminActions: AdminAction[];
}

export interface RunEpochResult {
  epochStart: number;
  epochEnd: number;
  status: 'complete' | 'empty' | 'skipped';
  feesUsd: number;
  holderPoolUsd: number;
  treasuryUsd: number;
  eligibleHolders: number;
  holdingAgeApplied: boolean;
  distributed: Array<{ wallet: string; usd: number; multiplier: number }>;
}

export interface StarterBatchResult {
  batchId: number;
  count: number;
  totalUsd: number;
  granted: Array<{ ledgerId: number; wallet: string; amountUsd: number; balanceUsd: number }>;
}

export interface RevokeKeyResult {
  id: number;
  wallet: string;
  prefix: string;
  revoked: true;
  alreadyRevoked: boolean;
}

// ---------- pre-launch points + referrals (GET /me/points, /me/referral, /points/rules, /leaderboard/:board) ----------

export type PointsKind = 'credits' | 'usage' | 'node' | 'referral_signup' | 'referral_share' | 'adjustment';

export interface PointsRules {
  enabled: boolean;
  perUsdCredits: number;
  perUsdSpent: number;
  perNodeTokenK: number;
  perReferralSignup: number;
  referralSharePercent: number;
  dailyCapPerWallet: number;
  /** "conversion ratio set at TGE; points are not a promise" */
  conversion: string;
}

export interface PointsRow {
  id: number;
  kind: PointsKind;
  points: number;
  ref: string | null;
  created_at: number;
}

/** GET /me/points */
export interface MyPoints {
  wallet: string;
  points: number;
  /** earned in the last 24h */
  delta24h: number;
  /** earned so far this UTC day (cap-relevant kinds) */
  today: number;
  dailyCap: number;
  byKind: Record<PointsKind, number>;
  rank: number | null;
  recent: PointsRow[];
  rules: PointsRules;
}

/** GET /me/referral */
export interface MyReferral {
  wallet: string;
  code: string;
  link: string;
  referred: number;
  pointsEarned: number;
  pointsFromSignups: number;
  pointsFromShare: number;
  /** truncated wallet of whoever referred this wallet, or null */
  referredBy: string | null;
  perReferralSignup: number;
  referralSharePercent: number;
}

/** POST /referrals/claim */
export interface ClaimResult {
  wallet: string;
  referrer: string;
  referrerPointsAwarded: number;
  sharePercent: number;
}

export type Board = 'holders' | 'nodes' | 'points' | 'referrers';

export interface LeaderboardRow {
  rank: number;
  /** truncated for everyone but the caller's own `me` entry */
  wallet: string;
  value: number;
  secondary: number | null;
}

/** GET /leaderboard/:board */
export interface Leaderboard {
  board: Board;
  unit: 'usd' | 'tokens' | 'points' | 'referrals' | string;
  label: string;
  secondaryLabel: string | null;
  limit: number;
  total: number;
  rows: LeaderboardRow[];
  /** present when the request carried a session; rank is null when the wallet is not on the board */
  me: { rank: number | null; wallet: string; value: number; secondary: number | null } | null;
  cachedAt: number;
  generatedAt: number;
}

// ---------- staking ----------

export interface StakeTierView {
  name: string;
  minStake: number;
  lockDays: number;
  multiplier: number;
}

/** GET /stake/tiers */
export interface StakeTiers {
  chain: string;
  ticker: string;
  tiers: StakeTierView[];
  /** The gateway can read positions (contract deployed + configured). */
  available: boolean;
  /** Staking contract address the gateway reads, when known. */
  contract: string | null;
  epochSeconds: number;
}

/** GET /me/stake */
export interface MyStake {
  wallet: string;
  staked: number;
  tier: StakeTierView;
  tierIndex: number;
  multiplier: number;
  lockDays: number;
  lockEndsAt: number;
  nextTier: (StakeTierView & { needStake: number }) | null;
  available: boolean;
  contract: string | null;
  epoch: number;
}
