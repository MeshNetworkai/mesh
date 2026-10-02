import type { ModelPolicy, TokenomicsConfig } from '@mesh/config';
import { networkTagFor } from '@mesh/config';
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
  busy: number;
  created_at: number;
  last_seen: number;
  token_hash: string | null;
  agent_version: string | null;
  load_avg: number | null;
}

export function onlineNodes(db: Db, now = nowSec()): NodeRow[] {
  return db
    .prepare(`SELECT * FROM nodes WHERE last_seen >= ? ORDER BY last_seen DESC`)
    .all(now - NODE_ONLINE_SEC) as NodeRow[];
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
  /** Jobs scored (done + node-fault failures) in the window. */
  jobs: number;
  done: number;
  failed: number;
  /** done / jobs; 1 when nothing scored yet. */
  successRate: number;
  /** Mean claim → first chunk latency over completed jobs, ms; null when none. */
  avgFirstTokenMs: number | null;
  /** False when the node has enough history and its success rate is below the threshold. */
  eligible: boolean;
}

export type RoutingConfig = TokenomicsConfig['routing'];

export function nodeReputation(db: Db, nodeId: string, routing: Partial<Pick<RoutingConfig, 'minSuccessRate' | 'reputationMinJobs'>> = {}): Reputation {
  const minSuccessRate = routing.minSuccessRate ?? 0.8;
  const minJobs = routing.reputationMinJobs ?? 5;
  const rows = db
    .prepare(
      `SELECT status, claimed_ms, first_chunk_ms FROM jobs
       WHERE node_id = ? AND (status = 'done' OR ((status = 'failed' OR status = 'fallback') AND node_fault = 1))
       ORDER BY created_ms DESC LIMIT ?`,
    )
    .all(nodeId, REPUTATION_WINDOW) as Array<{ status: string; claimed_ms: number | null; first_chunk_ms: number | null }>;
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
  const jobs = rows.length;
  const successRate = jobs === 0 ? 1 : done / jobs;
  return {
    jobs,
    done,
    failed: jobs - done,
    successRate: Math.round(successRate * 10_000) / 10_000,
    avgFirstTokenMs: latN ? Math.round(latSum / latN) : null,
    eligible: jobs < minJobs || successRate >= minSuccessRate,
  };
}

// ---------------- route decision ----------------

export interface RouteDecision {
  target: 'node' | 'openrouter';
  /** Ollama tag the job is queued under (network models only). */
  tag: string | null;
  /** Online, idle, reputable nodes advertising `tag`, best first. */
  candidates: string[];
  reason: 'network_disabled' | 'not_network_model' | 'no_online_node' | 'node';
}

/** Sync view of a wallet's stake tier (staking.ts `StakeResolver.peek`); absent → every node is on the base tier. */
export interface TierSource {
  peek(wallet: string): { tierIndex: number };
}

/**
 * Online, idle (not busy), reputable nodes advertising `tag`, excluding `exclude`. Best first:
 * higher stake tier of the reward wallet, then reputation (success rate, then faster first token),
 * then most recently seen.
 */
export function eligibleNodes(
  deps: { db: Db; config: { routing: Partial<RoutingConfig> }; stakes?: TierSource },
  tag: string,
  opts: { exclude?: string | null; now?: number } = {},
): NodeRow[] {
  const routing = deps.config.routing;
  const scored = onlineNodes(deps.db, opts.now)
    .filter((n) => n.busy === 0 && n.node_id !== opts.exclude && nodeModels(n).includes(tag))
    .map((n) => ({ n, rep: nodeReputation(deps.db, n.node_id, routing), tier: deps.stakes?.peek(n.wallet).tierIndex ?? 0 }))
    .filter((x) => x.rep.eligible);
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.rep.successRate - a.rep.successRate ||
      (a.rep.avgFirstTokenMs ?? Number.MAX_SAFE_INTEGER) - (b.rep.avgFirstTokenMs ?? Number.MAX_SAFE_INTEGER) ||
      b.n.last_seen - a.n.last_seen,
  );
  return scored.map((x) => x.n);
}

export function decideRoute(
  deps: { db: Db; config: { routing: Partial<RoutingConfig> }; policy: ModelPolicy; stakes?: TierSource },
  model: string,
  now = nowSec(),
): RouteDecision {
  if (!deps.config.routing?.preferNetwork) return { target: 'openrouter', tag: null, candidates: [], reason: 'network_disabled' };
  const tag = networkTagFor(deps.policy, model);
  if (!tag) return { target: 'openrouter', tag: null, candidates: [], reason: 'not_network_model' };
  const nodes = eligibleNodes(deps, tag, { now });
  if (nodes.length === 0) return { target: 'openrouter', tag, candidates: [], reason: 'no_online_node' };
  return { target: 'node', tag, candidates: nodes.map((n) => n.node_id), reason: 'node' };
}
