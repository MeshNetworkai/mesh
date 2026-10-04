import type { ModelPolicy, PrivacyTier, TokenomicsConfig } from '@mesh/config';
import { isPrivacyTier, networkTagFor } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';

/** A node is online if it heartbeated (or pulled a job) within this many seconds. */
export const NODE_ONLINE_SEC = 90;
/** Interval the node agent should heartbeat at. */
export const HEARTBEAT_EVERY_SEC = 20;
/** Reputation window: last N scored jobs. */
export const REPUTATION_WINDOW = 100;

export interface NodeRow {
  node_id: string;
  wallet: string;
  url: string;
  models: string;
  ram_gb: number | null;
  chip: string | null;
  /** Running jobs on the node (count); a heartbeat `busy: true` pins it at `max_parallel` until the next heartbeat. */
  busy: number;
  /** Concurrent jobs the node advertised it can run (register/heartbeat `maxParallel`, capped by routing.maxParallelPerNode). */
  max_parallel: number;
  created_at: number;
  last_seen: number;
  token_hash: string | null;
  agent_version: string | null;
  load_avg: number | null;
  /** Operator pledge (docs/PRIVACY.md): when signed, by which chain's verifier. */
  pledge_at: number | null;
  pledge_signature: string | null;
  pledge_chain: string | null;
  /** Set when spot-check verification (verification.ts) quarantined the node; cleared by an admin. */
  quarantined_at: number | null;
  quarantine_reason: string | null;
}

export const isQuarantined = (node: Pick<NodeRow, 'quarantined_at'>): boolean => node.quarantined_at !== null && node.quarantined_at !== undefined;

export function onlineNodes(db: Db, now = nowSec()): NodeRow[] {
  return db
    .prepare(`SELECT * FROM nodes WHERE last_seen >= ? ORDER BY last_seen DESC`)
    .all(now - NODE_ONLINE_SEC) as NodeRow[];
}

/**
 * In-memory view of the fleet the router may use instead of the DB (network.ts `JobBroker` implements
 * it): a short-lived snapshot of online nodes, live running-job counts and a reputation cache. Absent →
 * every call queries SQLite (the legacy behaviour, still used by unit tests that build bare deps).
 */
export interface NodeSource {
  onlineNodes(now: number): NodeRow[];
  /** Jobs running on the node right now (authoritative within this process). */
  runningOn(nodeId: string): number;
  /** The node's last heartbeat said `busy: true` (paused / full by its own account): no capacity until the next one. */
  isPinnedBusy(nodeId: string): boolean;
  reputation(nodeId: string, cfg: ReputationConfig): Reputation;
}

/**
 * Free job slots on a node: advertised parallelism minus what is running. With a live count (the broker's,
 * authoritative for this process) the DB `busy` column is ignored — it may come from a snapshot taken up
 * to NODE_SNAPSHOT_MS ago; without one the column is all there is.
 */
export function nodeCapacity(node: Pick<NodeRow, 'busy' | 'max_parallel'>, running?: number): number {
  const max = Math.max(1, node.max_parallel ?? 1);
  return Math.max(0, max - (running ?? node.busy ?? 0));
}

export function nodeModels(row: Pick<NodeRow, 'models'>): string[] {
  try {
    const m = JSON.parse(row.models) as unknown;
    return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------- reputation ----------------

export interface Reputation {
  /** Jobs scored (done + node-fault failures + mismatch penalties) in the window. */
  jobs: number;
  done: number;
  failed: number;
  /** Verification mismatches among the window's jobs; each counts as `mismatchPenalty` failures. */
  mismatches: number;
  /** done / jobs; 1 when nothing scored yet. */
  successRate: number;
  /** Mean claim → first chunk latency over completed jobs, ms; null when none. */
  avgFirstTokenMs: number | null;
  /** False when the node has enough history and its success rate is below the threshold. */
  eligible: boolean;
}

export type RoutingConfig = TokenomicsConfig['routing'];
export type VerificationConfig = TokenomicsConfig['verification'];

/** What reputation needs from config: the routing thresholds plus the verification mismatch penalty. */
export type ReputationConfig = Partial<Pick<RoutingConfig, 'minSuccessRate' | 'reputationMinJobs'>> & { mismatchPenalty?: number };

/** `mismatchPenalty` folded into the routing thresholds (what `JobBroker` and `eligibleNodes` pass to `nodeReputation`). */
export function reputationConfig(config: { routing: Partial<RoutingConfig>; verification?: Pick<VerificationConfig, 'mismatchPenalty'> }): ReputationConfig {
  return { ...config.routing, mismatchPenalty: config.verification?.mismatchPenalty };
}

export function nodeReputation(db: Db, nodeId: string, routing: ReputationConfig = {}): Reputation {
  const minSuccessRate = routing.minSuccessRate ?? 0.8;
  const minJobs = routing.reputationMinJobs ?? 5;
  const penalty = routing.mismatchPenalty ?? 3;
  const rows = db
    .prepare(
      `SELECT job_id, status, claimed_ms, first_chunk_ms FROM jobs
       WHERE node_id = ? AND (status = 'done' OR ((status = 'failed' OR status = 'fallback') AND node_fault = 1))
       ORDER BY created_ms DESC LIMIT ?`,
    )
    .all(nodeId, REPUTATION_WINDOW) as Array<{ job_id: string; status: string; claimed_ms: number | null; first_chunk_ms: number | null }>;
  let done = 0;
  let latSum = 0;
  let latN = 0;
  for (const r of rows) {
    if (r.status === 'done') {
      done++;
      if (r.claimed_ms && r.first_chunk_ms) {
        latSum += r.first_chunk_ms - r.claimed_ms;
        latN++;
      }
    }
  }
  // Spot-check mismatches on the window's jobs (verification.ts): each one is `penalty` extra failures.
  const mismatches = rows.length
    ? (
        db
          .prepare(`SELECT COUNT(*) AS n FROM verifications WHERE primary_node = ? AND verdict = 'mismatch' AND job_id IN (${rows.map(() => '?').join(',')})`)
          .get(nodeId, ...rows.map((r) => r.job_id)) as { n: number }
      ).n
    : 0;
  const jobs = rows.length + mismatches * penalty;
  const successRate = jobs === 0 ? 1 : done / jobs;
  return {
    jobs,
    done,
    failed: jobs - done,
    mismatches,
    successRate: Math.round(successRate * 10_000) / 10_000,
    avgFirstTokenMs: latN ? Math.round(latSum / latN) : null,
    eligible: jobs < minJobs || successRate >= minSuccessRate,
  };
}

// ---------------- privacy tiers (docs/PRIVACY.md) ----------------

export type PrivacyConfig = TokenomicsConfig['privacy'];
export type PrivacySource = 'header' | 'body' | 'key' | 'default';

export interface PrivacyChoice {
  tier: PrivacyTier;
  /** Where the tier came from. `default` means nobody asked: config.privacy.fallback may apply. */
  source: PrivacySource;
}

/** Human label the client sees in `mesh.servedBy`. */
export type ServedBy = 'your node' | 'trusted node' | 'network node' | 'upstream (ZDR)' | 'upstream';

/**
 * Per-request tier: `X-Mesh-Privacy` header, then `mesh.privacy` in the body, then the API key's
 * default, then config.privacy.default. Returns `{error}` for an unknown or disabled value instead
 * of guessing (a privacy request must never be silently downgraded).
 */
export function resolvePrivacy(
  input: { header?: string | string[] | undefined; body?: unknown; keyDefault?: string | null | undefined },
  privacy: Pick<PrivacyConfig, 'default' | 'tiers'>,
): PrivacyChoice | { error: string } {
  const check = (raw: unknown, source: PrivacySource): PrivacyChoice | { error: string } | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (!isPrivacyTier(v)) return { error: `unknown privacy tier '${String(raw)}' (${source}); use trusted | network | upstream_zdr` };
    if (!privacy.tiers[v]) return { error: `privacy tier '${v}' is disabled on this gateway` };
    return { tier: v, source };
  };
  const header = Array.isArray(input.header) ? input.header[0] : input.header;
  const bodyTier = input.body && typeof input.body === 'object' ? (input.body as { mesh?: { privacy?: unknown } }).mesh?.privacy : undefined;
  return check(header, 'header') ?? check(bodyTier, 'body') ?? check(input.keyDefault, 'key') ?? (check(privacy.default, 'default') as PrivacyChoice);
}

/** Index of the stake tier named `privacy.trustedMinStakeTier` in ascending minStake order; null when no such tier. */
export function trustedTierIndex(config: Pick<TokenomicsConfig, 'stakeTiers'> & { privacy: Pick<PrivacyConfig, 'trustedMinStakeTier'> }): number | null {
  const sorted = [...config.stakeTiers].sort((a, b) => a.minStake - b.minStake);
  const idx = sorted.findIndex((t) => t.name === config.privacy.trustedMinStakeTier);
  return idx === -1 ? null : idx;
}

export type TrustedVia = 'owner' | 'allowlist' | 'stake+pledge';

/**
 * Whether a node may serve `trusted` jobs: its reward wallet is the requesting wallet (`owner`: your
 * own Macs are trusted for your own requests), its reward wallet is in `privacy.trustedWallets`, or
 * the wallet holds at least the `trustedMinStakeTier` stake tier AND the node's operator signed the
 * pledge (POST /nodes/:id/pledge). Stake is read from the per-epoch cache (`stakes.peek`).
 * `requesterWallet` is per request; without one only the wallet-wide rules apply.
 */
export function trustedVia(
  deps: { config: Pick<TokenomicsConfig, 'stakeTiers'> & { privacy: Pick<PrivacyConfig, 'trustedWallets' | 'trustedMinStakeTier'> }; stakes?: TierSource },
  node: Pick<NodeRow, 'wallet' | 'pledge_at'>,
  requesterWallet?: string | null,
): TrustedVia | null {
  if (requesterWallet && node.wallet === requesterWallet) return 'owner';
  if (deps.config.privacy.trustedWallets.includes(node.wallet)) return 'allowlist';
  if (!node.pledge_at) return null;
  const need = trustedTierIndex(deps.config);
  if (need === null) return null;
  const have = deps.stakes?.peek(node.wallet).tierIndex ?? 0;
  return have >= need ? 'stake+pledge' : null;
}

export const isTrustedNode = (deps: Parameters<typeof trustedVia>[0], node: Pick<NodeRow, 'wallet' | 'pledge_at'>, requesterWallet?: string | null): boolean =>
  trustedVia(deps, node, requesterWallet) !== null;

// ---------------- route decision ----------------

export interface RouteDecision {
  target: 'node' | 'openrouter';
  /** Ollama tag the job is queued under (network models only). */
  tag: string | null;
  /** Online, idle, reputable nodes advertising `tag`, best first. */
  candidates: string[];
  /**
   * `node`: an idle node is available. `queued`: every eligible node is at capacity, the job is queued
   * behind them for up to routing.queueWaitMs. `queue_full`: nodes exist but the per-node queue depth
   * cap is reached, so the request goes upstream at once.
   */
  reason: 'network_disabled' | 'not_network_model' | 'no_online_node' | 'no_trusted_node' | 'upstream_requested' | 'node' | 'queued' | 'queue_full';
  /** Tier the request is actually served under (`trusted` → `network` only via the default fallback). */
  privacy: PrivacyTier;
  /** What the client asked for (or the default). */
  requested: PrivacyChoice;
  /** Only nodes that pass `isTrustedNode` (for `requesterWallet`) may claim the job. */
  trustedOnly: boolean;
  /** Wallet behind the request; its own nodes count as trusted (owner rule). Never sent to a node. */
  requesterWallet: string | null;
  /** Upstream calls carry the ZDR-only provider preference. */
  zdr: boolean;
  servedBy: ServedBy;
}

/** Sync view of a wallet's stake tier (staking.ts `StakeResolver.peek`); absent → every node is on the base tier. */
export interface TierSource {
  peek(wallet: string): { tierIndex: number };
}

export interface RouteDeps {
  db: Db;
  config: { routing: Partial<RoutingConfig>; stakeTiers: TokenomicsConfig['stakeTiers']; privacy: PrivacyConfig; verification?: Pick<VerificationConfig, 'mismatchPenalty'> };
  stakes?: TierSource;
  /** Fleet view with caches (the `JobBroker`); when absent the DB is queried directly. */
  broker?: NodeSource;
}

export interface EligibleOptions {
  exclude?: string | null;
  now?: number;
  trustedOnly?: boolean;
  requesterWallet?: string | null;
  /** Also return nodes that are online and eligible but currently at capacity (for queueing). */
  includeBusy?: boolean;
}

/**
 * Online, idle (free capacity), reputable nodes advertising `tag`, excluding `exclude`. Best first:
 * higher stake tier of the reward wallet, then reputation (success rate, then faster first token),
 * then most recently seen. `trustedOnly` keeps only nodes that may serve `trusted` jobs for
 * `requesterWallet` (allowlisted, gold + pledged, or owned by that wallet). Quarantined nodes
 * (verification.ts) are never candidates. With `includeBusy` nodes at capacity are kept too (the
 * caller decides whether to queue behind them); use `eligibleNodesDetailed` to tell them apart.
 */
export function eligibleNodes(deps: RouteDeps, tag: string, opts: EligibleOptions = {}): NodeRow[] {
  return eligibleNodesDetailed(deps, tag, opts).map((x) => x.node);
}

export interface EligibleNode {
  node: NodeRow;
  /** Free job slots right now (0 = at capacity). */
  capacity: number;
}

export function eligibleNodesDetailed(deps: RouteDeps, tag: string, opts: EligibleOptions = {}): EligibleNode[] {
  const routing = reputationConfig(deps.config);
  const now = opts.now ?? nowSec();
  const online = deps.broker ? deps.broker.onlineNodes(now) : onlineNodes(deps.db, now);
  const rep = (id: string) => (deps.broker ? deps.broker.reputation(id, routing) : nodeReputation(deps.db, id, routing));
  const scored = online
    .filter((n) => !isQuarantined(n) && n.node_id !== opts.exclude && nodeModels(n).includes(tag))
    // A node pinned busy by its own heartbeat (paused, or full by its own account) is not worth queueing
    // behind: nothing in this process will free it. Nodes at capacity because of jobs we are relaying are.
    .filter((n) => !(opts.includeBusy && deps.broker?.isPinnedBusy(n.node_id)))
    .map((n) => ({ n, capacity: deps.broker ? (deps.broker.isPinnedBusy(n.node_id) ? 0 : nodeCapacity(n, deps.broker.runningOn(n.node_id))) : nodeCapacity(n) }))
    .filter((x) => opts.includeBusy || x.capacity > 0)
    .filter((x) => !opts.trustedOnly || isTrustedNode(deps, x.n, opts.requesterWallet))
    .map((x) => ({ ...x, rep: rep(x.n.node_id), tier: deps.stakes?.peek(x.n.wallet).tierIndex ?? 0 }))
    .filter((x) => x.rep.eligible);
  scored.sort(
    (a, b) =>
      (b.capacity > 0 ? 1 : 0) - (a.capacity > 0 ? 1 : 0) ||
      b.tier - a.tier ||
      b.rep.successRate - a.rep.successRate ||
      (a.rep.avgFirstTokenMs ?? Number.MAX_SAFE_INTEGER) - (b.rep.avgFirstTokenMs ?? Number.MAX_SAFE_INTEGER) ||
      b.n.last_seen - a.n.last_seen,
  );
  return scored.map((x) => ({ node: x.n, capacity: x.capacity }));
}

/** Upstream leg of a decision: ZDR unless the caller explicitly settled for `network`. */
function upstreamDecision(reason: RouteDecision['reason'], tag: string | null, requested: PrivacyChoice, requesterWallet: string | null): RouteDecision {
  const zdr = requested.tier !== 'network';
  return {
    target: 'openrouter',
    tag,
    candidates: [],
    reason,
    privacy: zdr ? 'upstream_zdr' : 'network',
    requested,
    trustedOnly: false,
    requesterWallet,
    zdr,
    servedBy: zdr ? 'upstream (ZDR)' : 'upstream',
  };
}

export interface RouteOptions {
  now?: number;
  /** Wallet behind the request (the API key's wallet): its own nodes may serve its `trusted` requests. */
  requesterWallet?: string | null;
}

/**
 * Where a request goes. With the default `trusted` choice: a trusted node when one is online, else
 * `config.privacy.fallback` — but `network` is only taken when nobody asked for trusted explicitly
 * (source `default`); an explicit trusted request that cannot be honoured goes upstream with ZDR.
 * `opts` may be a bare `now` timestamp (legacy positional form) or `{ now, requesterWallet }`.
 */
export function decideRoute(
  deps: RouteDeps & { policy: ModelPolicy },
  model: string,
  requested: PrivacyChoice = { tier: deps.config.privacy.default, source: 'default' },
  opts: number | RouteOptions = {},
): RouteDecision {
  const o: RouteOptions = typeof opts === 'number' ? { now: opts } : opts;
  const now = o.now ?? nowSec();
  const requesterWallet = o.requesterWallet ?? null;
  const tag = deps.config.routing?.preferNetwork ? networkTagFor(deps.policy, model) : null;
  if (!deps.config.routing?.preferNetwork) return upstreamDecision('network_disabled', null, requested, requesterWallet);
  if (!tag) return upstreamDecision('not_network_model', null, requested, requesterWallet);
  if (requested.tier === 'upstream_zdr') return upstreamDecision('upstream_requested', tag, requested, requesterWallet);

  const nodeDecision = (nodes: NodeRow[], privacy: 'trusted' | 'network', reason: 'node' | 'queued' = 'node'): RouteDecision => ({
    target: 'node',
    tag,
    candidates: nodes.map((n) => n.node_id),
    reason,
    privacy,
    requested,
    trustedOnly: privacy === 'trusted',
    requesterWallet,
    // If every node fails and the request falls through to the upstream, keep ZDR unless the
    // caller explicitly settled for `network`.
    zdr: requested.tier !== 'network',
    servedBy: privacy === 'trusted' ? 'trusted node' : 'network node',
  });

  /**
   * Pick for one tier: idle nodes win; otherwise, when nodes advertising the tag are online but at
   * capacity and queueing is on, queue behind them unless the per-node depth cap is already reached.
   */
  const pick = (opts: { trustedOnly: boolean }): { kind: 'idle' | 'queued' | 'full' | 'none'; nodes: NodeRow[] } => {
    const all = eligibleNodesDetailed(deps, tag, { now, includeBusy: true, trustedOnly: opts.trustedOnly, requesterWallet });
    if (all.length === 0) return { kind: 'none', nodes: [] };
    const idle = all.filter((x) => x.capacity > 0).map((x) => x.node);
    if (idle.length > 0) return { kind: 'idle', nodes: idle };
    const queueWaitMs = deps.config.routing?.queueWaitMs ?? 6000;
    const depthPerNode = deps.config.routing?.maxQueueDepthPerNode ?? 3;
    if (queueWaitMs <= 0 || depthPerNode <= 0) return { kind: 'none', nodes: [] }; // queueing off: legacy "no idle node" answer
    const queued = queuedJobsForTag(deps, tag, { trustedOnly: opts.trustedOnly, requesterWallet });
    if (queued >= all.length * depthPerNode) return { kind: 'full', nodes: [] };
    return { kind: 'queued', nodes: all.map((x) => x.node) };
  };

  if (requested.tier === 'trusted') {
    const trusted = pick({ trustedOnly: true });
    if (trusted.kind === 'idle') return nodeDecision(trusted.nodes, 'trusted');
    if (trusted.kind === 'queued') return nodeDecision(trusted.nodes, 'trusted', 'queued');
    if (deps.config.privacy.fallback === 'network' && requested.source === 'default') {
      const any = pick({ trustedOnly: false });
      if (any.kind === 'idle') return nodeDecision(any.nodes, 'network');
      if (any.kind === 'queued') return nodeDecision(any.nodes, 'network', 'queued');
    }
    return upstreamDecision(trusted.kind === 'full' ? 'queue_full' : 'no_trusted_node', tag, requested, requesterWallet);
  }
  const any = pick({ trustedOnly: false });
  if (any.kind === 'idle') return nodeDecision(any.nodes, 'network');
  if (any.kind === 'queued') return nodeDecision(any.nodes, 'network', 'queued');
  return upstreamDecision(any.kind === 'full' ? 'queue_full' : 'no_online_node', tag, requested, requesterWallet);
}

/**
 * Jobs currently queued under `tag`. For a trusted pick only trusted jobs count (they are the ones
 * competing for trusted capacity); a `network` pick counts every queued job for the tag. Uses the
 * `jobs_queue` index, so it is one cheap lookup per decision.
 */
export function queuedJobsForTag(deps: Pick<RouteDeps, 'db'>, tag: string, opts: { trustedOnly?: boolean; requesterWallet?: string | null } = {}): number {
  if (opts.trustedOnly) {
    return (deps.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND tag = ? AND privacy = 'trusted'`).get(tag) as { n: number }).n;
  }
  return (deps.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND tag = ?`).get(tag) as { n: number }).n;
}
