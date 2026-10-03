import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import type { RoutingConfig } from './routing.js';
import { NODE_ONLINE_SEC, nodeModels, nodeReputation, type NodeRow } from './routing.js';

/**
 * Job broker for the Mesh node network (see docs/NODE_PROTOCOL.md).
 *
 * Jobs live in SQLite (`jobs` table) so state survives and stats can be computed; the
 * live relay (chunks flowing from the node's POSTs to the waiting client) is in-memory
 * and scoped to one gateway process. Claims are atomic: `UPDATE ... WHERE status='queued'`
 * succeeds for exactly one node.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'fallback';

export interface JobRow {
  job_id: string;
  model: string;
  tag: string;
  wallet: string;
  api_key_id: number | null;
  status: JobStatus;
  /** 'trusted' jobs are only claimable by trusted nodes, or by the requester's own nodes (docs/PRIVACY.md). */
  privacy: 'trusted' | 'network';
  /**
   * Wallet behind the request (owner rule: a node with this reward wallet may claim a trusted job).
   * INTERNAL — never part of the node-facing job view (`jobView` / `JOB_VIEW_FIELDS`).
   */
  requester_wallet: string | null;
  payload: string;
  max_tokens: number;
  deadline_ms: number;
  node_id: string | null;
  exclude_node_id: string | null;
  parent_job_id: string | null;
  attempt: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  finish_reason: string | null;
  error: string | null;
  node_fault: number;
  created_at: number;
  created_ms: number;
  claimed_ms: number | null;
  first_chunk_ms: number | null;
  finished_ms: number | null;
}

/** A message as a node receives it: role and content only (OpenAI `name` and anything else is dropped). */
export interface JobMessage {
  role: string;
  content: string | Array<{ type: 'text'; text: string }> | null;
}

export interface JobPayload {
  messages: JobMessage[];
  params: Record<string, unknown>;
}

/** Exactly the fields a node is sent (docs/NODE_PROTOCOL.md §3, docs/PRIVACY.md). Nothing else may be added. */
export const JOB_VIEW_FIELDS = ['jobId', 'model', 'messages', 'params', 'maxTokens', 'deadlineMs', 'attempt'] as const;

/**
 * Reduce client messages to what a model needs. Everything that could identify the caller or the
 * application (`name`, tool ids, provider-specific extras) is removed; multimodal parts other than
 * text are dropped because nodes only run text models.
 */
export function sanitizeMessages(messages: unknown[]): JobMessage[] {
  const out: JobMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof role !== 'string') continue;
    if (typeof content === 'string' || content === null || content === undefined) {
      out.push({ role, content: content ?? null });
    } else if (Array.isArray(content)) {
      const parts: Array<{ type: 'text'; text: string }> = [];
      for (const p of content) {
        if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') parts.push({ type: 'text', text: (p as { text: string }).text });
      }
      out.push({ role, content: parts });
    }
  }
  return out;
}

export interface JobUsage {
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
}

export type RelayEvent =
  | { type: 'claimed'; nodeId: string }
  | { type: 'chunk'; seq: number; delta: string }
  | { type: 'done'; usage: JobUsage }
  | { type: 'fail'; error: string }
  | { type: 'timeout' };

/** In-memory event queue between the node's POSTs and the client handler. */
export class JobRelay {
  private queue: RelayEvent[] = [];
  private waiter: ((ev: RelayEvent) => void) | null = null;
  private nextSeq = 0;
  private pending = new Map<number, string>();
  /** Set when the client handler gave up on this job (timeout / disconnect). */
  closed = false;
  nodeId: string | null = null;
  chunks = 0;

  push(ev: RelayEvent): void {
    if (this.closed) return;
    if (ev.type === 'claimed') this.nodeId = ev.nodeId;
    if (ev.type === 'chunk') {
      // Deliver in seq order; drop duplicates; buffer gaps.
      if (ev.seq < this.nextSeq || this.pending.has(ev.seq)) return;
      this.pending.set(ev.seq, ev.delta);
      while (this.pending.has(this.nextSeq)) {
        const delta = this.pending.get(this.nextSeq)!;
        this.pending.delete(this.nextSeq);
        this.emit({ type: 'chunk', seq: this.nextSeq, delta });
        this.nextSeq++;
      }
      return;
    }
    this.emit(ev);
  }

  private emit(ev: RelayEvent): void {
    if (ev.type === 'chunk') this.chunks++;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
    } else this.queue.push(ev);
  }

  /** Next event, or `{type:'timeout'}` after `timeoutMs`. */
  next(timeoutMs: number): Promise<RelayEvent> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === done) this.waiter = null;
        resolve({ type: 'timeout' });
      }, timeoutMs);
      const done = (ev: RelayEvent) => {
        clearTimeout(timer);
        resolve(ev);
      };
      this.waiter = done;
    });
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ type: 'timeout' });
    }
  }
}

interface Waiter {
  nodeId: string;
  /** Reward wallet: a waiting node may take trusted jobs its own wallet requested (owner rule). */
  wallet: string;
  tags: Set<string>;
  /** Evaluated when the node started waiting: may it take any `trusted` job? */
  trusted: boolean;
  resolve: (job: JobRow | null) => void;
}

export interface CreateJobInput {
  model: string;
  tag: string;
  wallet: string;
  apiKeyId: number | null;
  /** Raw client messages + whitelisted params; `create` sanitises the messages before storing. */
  payload: { messages: unknown[]; params: Record<string, unknown> };
  maxTokens: number;
  deadlineMs: number;
  /** `trusted` restricts claiming to nodes the `isTrusted` callback approves, or to `requesterWallet`'s own nodes. Default `network`. */
  privacy?: 'trusted' | 'network';
  /** Wallet behind the request (stored in `jobs.requester_wallet`, never sent to a node). */
  requesterWallet?: string | null;
  excludeNodeId?: string | null;
  parentJobId?: string | null;
  attempt?: number;
}

export class JobBroker {
  private relays = new Map<string, JobRelay>();
  private waiters: Waiter[] = [];

  constructor(
    private db: Db,
    private routing: () => Pick<RoutingConfig, 'minSuccessRate' | 'reputationMinJobs'>,
    /** Whether a node may claim `trusted` jobs (routing.ts `isTrustedNode`). Absent → no node is trusted. */
    private isTrusted: (node: NodeRow) => boolean = () => false,
  ) {}

  relay(jobId: string): JobRelay | undefined {
    return this.relays.get(jobId);
  }

  get(jobId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) as JobRow | undefined) ?? null;
  }

  /** Insert a queued job and hand it to a waiting node if one fits. */
  create(input: CreateJobInput): { job: JobRow; relay: JobRelay } {
    const jobId = `job_${randomBytes(9).toString('base64url')}`;
    const ms = Date.now();
    const privacy = input.privacy ?? 'network';
    const requesterWallet = input.requesterWallet ?? null;
    // The stored payload is exactly what the node will see: sanitised messages + whitelisted params.
    const payload: JobPayload = { messages: sanitizeMessages(input.payload.messages), params: input.payload.params };
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, model, tag, wallet, api_key_id, status, privacy, requester_wallet, payload, max_tokens, deadline_ms, exclude_node_id, parent_job_id, attempt, created_at, created_ms)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        input.model,
        input.tag,
        input.wallet,
        input.apiKeyId,
        privacy,
        requesterWallet,
        JSON.stringify(payload),
        input.maxTokens,
        input.deadlineMs,
        input.excludeNodeId ?? null,
        input.parentJobId ?? null,
        input.attempt ?? 1,
        Math.floor(ms / 1000),
        ms,
      );
    const relay = new JobRelay();
    this.relays.set(jobId, relay);
    const job = this.get(jobId)!;
    // Offer to long-polling nodes (first eligible waiter wins the atomic claim).
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (!w.tags.has(input.tag) || w.nodeId === input.excludeNodeId) continue;
      if (privacy === 'trusted' && !w.trusted && !(requesterWallet !== null && w.wallet === requesterWallet)) continue;
      const claimed = this.tryClaim(jobId, w.nodeId, w.trusted);
      if (claimed) {
        this.waiters.splice(i, 1);
        w.resolve(claimed);
        break;
      }
    }
    return { job, relay };
  }

  /**
   * Atomic claim: exactly one node can move a job queued→running. Marks the node busy. A `trusted`
   * job is only claimable when `trusted` is true for the claiming node OR the node's reward wallet is
   * the job's `requester_wallet` (owner rule). Both are enforced in the UPDATE (the wallet via a
   * subquery on `nodes`), so a race between a trusted and an untrusted poller can never hand
   * plaintext to the wrong machine.
   */
  tryClaim(jobId: string, nodeId: string, trusted = false): JobRow | null {
    const ms = Date.now();
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', node_id = ?, claimed_ms = ?
           WHERE job_id = ? AND status = 'queued' AND (exclude_node_id IS NULL OR exclude_node_id != ?)
             AND (privacy != 'trusted' OR ? = 1
                  OR (requester_wallet IS NOT NULL AND requester_wallet = (SELECT wallet FROM nodes WHERE node_id = ?)))`,
        )
        .run(nodeId, ms, jobId, nodeId, trusted ? 1 : 0, nodeId);
      if (res.changes !== 1) return null;
      this.db.prepare(`UPDATE nodes SET busy = 1, last_seen = ? WHERE node_id = ?`).run(Math.floor(ms / 1000), nodeId);
      return this.get(jobId);
    });
    const job = tx();
    if (job) this.relays.get(jobId)?.push({ type: 'claimed', nodeId });
    return job;
  }

  /**
   * Node side of GET /nodes/:id/jobs/next: claim the oldest queued job matching the node's
   * tags, or wait up to `waitMs` for one. Resolves null on timeout (→ 204).
   */
  async pull(node: NodeRow, waitMs: number): Promise<JobRow | null> {
    const tags = new Set(nodeModels(node));
    if (tags.size === 0) return null;
    if (!nodeReputation(this.db, node.node_id, this.routing()).eligible) return null;
    const trusted = this.isTrusted(node);
    const placeholders = [...tags].map(() => '?').join(',');
    const queued = this.db
      .prepare(
        `SELECT job_id FROM jobs WHERE status = 'queued' AND tag IN (${placeholders}) AND (exclude_node_id IS NULL OR exclude_node_id != ?)
           AND (privacy != 'trusted' OR ? = 1 OR (requester_wallet IS NOT NULL AND requester_wallet = ?))
         ORDER BY created_ms ASC`,
      )
      .all(...tags, node.node_id, trusted ? 1 : 0, node.wallet) as Array<{ job_id: string }>;
    for (const q of queued) {
      const job = this.tryClaim(q.job_id, node.node_id, trusted);
      if (job) return job;
    }
    if (waitMs <= 0) return null;
    return new Promise<JobRow | null>((resolve) => {
      const waiter: Waiter = { nodeId: node.node_id, wallet: node.wallet, tags, trusted, resolve: (j) => resolve(j) };
      // A node re-polling replaces its previous waiter (one long-poll per node).
      this.waiters = this.waiters.filter((w) => w.nodeId !== node.node_id);
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, waitMs);
      waiter.resolve = (j) => {
        clearTimeout(timer);
        resolve(j);
      };
    });
  }

  /** Node posted a chunk. Returns false when the job is not running for this node (node should stop). */
  chunk(jobId: string, nodeId: string, seq: number, delta: string): boolean {
    const job = this.get(jobId);
    if (!job || job.status !== 'running' || job.node_id !== nodeId) return false;
    const relay = this.relays.get(jobId);
    if (!relay || relay.closed) return false;
    if (job.first_chunk_ms === null) this.db.prepare(`UPDATE jobs SET first_chunk_ms = ? WHERE job_id = ? AND first_chunk_ms IS NULL`).run(Date.now(), jobId);
    relay.push({ type: 'chunk', seq, delta });
    return true;
  }

  /** Node finished the job. Returns false if the job was no longer running for this node. */
  done(jobId: string, nodeId: string, usage: JobUsage): boolean {
    const ms = Date.now();
    const res = this.db
      .prepare(
        `UPDATE jobs SET status = 'done', prompt_tokens = ?, completion_tokens = ?, finish_reason = ?, finished_ms = ?,
           first_chunk_ms = COALESCE(first_chunk_ms, ?)
         WHERE job_id = ? AND status = 'running' AND node_id = ?`,
      )
      .run(usage.promptTokens, usage.completionTokens, usage.finishReason, ms, ms, jobId, nodeId);
    if (res.changes !== 1) return false;
    this.freeNode(nodeId);
    const relay = this.relays.get(jobId);
    relay?.push({ type: 'done', usage });
    return true;
  }

  /** Node reported a failure. */
  nodeFail(jobId: string, nodeId: string, error: string): boolean {
    const ok = this.markFailed(jobId, 'failed', `node_error: ${error}`.slice(0, 300), true, nodeId);
    if (ok) this.relays.get(jobId)?.push({ type: 'fail', error });
    return ok;
  }

  /**
   * Gateway side gave up (timeout, client gone, fallback). `status` is 'fallback' when the
   * request was then served by OpenRouter. `nodeFault` decides whether it hurts reputation.
   */
  abandon(jobId: string, status: 'failed' | 'fallback', error: string, nodeFault: boolean): void {
    this.markFailed(jobId, status, error, nodeFault, null);
    const relay = this.relays.get(jobId);
    relay?.close();
    this.relays.delete(jobId);
  }

  /** Forget the relay once the client handler is finished with a completed job. */
  release(jobId: string): void {
    this.relays.get(jobId)?.close();
    this.relays.delete(jobId);
  }

  private markFailed(jobId: string, status: 'failed' | 'fallback', error: string, nodeFault: boolean, requireNode: string | null): boolean {
    const job = this.get(jobId);
    if (!job) return false;
    // A job the node already failed may still be upgraded to 'fallback' once the upstream served the client.
    const upgrade = job.status === 'failed' && status === 'fallback' && !requireNode;
    if (!upgrade && job.status !== 'queued' && job.status !== 'running') return false;
    if (requireNode && job.node_id !== requireNode) return false;
    if (upgrade) {
      this.db.prepare(`UPDATE jobs SET status = 'fallback' WHERE job_id = ? AND status = 'failed'`).run(jobId);
      return true;
    }
    this.db
      .prepare(`UPDATE jobs SET status = ?, error = ?, node_fault = ?, finished_ms = ? WHERE job_id = ? AND status IN ('queued','running')`)
      .run(status, error.slice(0, 300), nodeFault && job.node_id ? 1 : 0, Date.now(), jobId);
    if (job.node_id) this.freeNode(job.node_id);
    return true;
  }

  private freeNode(nodeId: string): void {
    // Only clear busy if no other running job is on this node.
    const running = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE node_id = ? AND status = 'running'`).get(nodeId) as { n: number };
    if (running.n === 0) this.db.prepare(`UPDATE nodes SET busy = 0 WHERE node_id = ?`).run(nodeId);
  }

  /** Sweep jobs whose deadline passed while nobody was watching (process restart etc). */
  reapExpired(now = Date.now()): number {
    const rows = this.db.prepare(`SELECT job_id FROM jobs WHERE status IN ('queued','running') AND deadline_ms < ?`).all(now) as Array<{ job_id: string }>;
    for (const r of rows) this.abandon(r.job_id, 'failed', 'deadline_exceeded', false);
    return rows.length;
  }
}

// ---------------- stats helpers ----------------

const HEARTBEAT_GRACE_SEC = 30;

export function jobStats24h(db: Db, nodeId?: string, now = nowSec()) {
  const since = now - 86_400;
  const where = nodeId ? 'node_id = ? AND created_at >= ?' : 'created_at >= ?';
  const args = nodeId ? [nodeId, since] : [since];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS jobs,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) AS fallback,
              COALESCE(SUM(CASE WHEN status = 'done' THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS tokens
       FROM jobs WHERE ${where}`,
    )
    .get(...args) as { jobs: number; done: number | null; failed: number | null; fallback: number | null; tokens: number };
  return { jobs: row.jobs, done: row.done ?? 0, failed: row.failed ?? 0, fallback: row.fallback ?? 0, tokens: row.tokens };
}

/**
 * Share of the last 24h (capped at the node's age) in which the node heartbeated at least once per
 * minute-bucket. Heartbeats are every 20s so an always-on node scores 100.
 */
export function uptimePct24h(db: Db, node: Pick<NodeRow, 'node_id' | 'created_at'>, now = nowSec()): number {
  const windowSec = Math.min(86_400, Math.max(60, now - node.created_at + HEARTBEAT_GRACE_SEC));
  const since = now - windowSec;
  const row = db
    .prepare(`SELECT COUNT(DISTINCT ts / 60) AS buckets FROM heartbeats WHERE node_id = ? AND ts >= ?`)
    .get(node.node_id, since) as { buckets: number };
  const total = Math.max(1, Math.ceil(windowSec / 60));
  return Math.min(100, Math.round((row.buckets / total) * 10_000) / 100);
}
export const HEARTBEAT_RETENTION_SEC = 48 * 3600;

export function recordHeartbeat(db: Db, nodeId: string, busy: boolean, now = nowSec()): void {
  db.prepare(`INSERT INTO heartbeats (node_id, ts, busy) VALUES (?, ?, ?)`).run(nodeId, now, busy ? 1 : 0);
  db.prepare(`DELETE FROM heartbeats WHERE ts < ?`).run(now - HEARTBEAT_RETENTION_SEC);
}

export function isOnline(node: Pick<NodeRow, 'last_seen'>, now = nowSec()): boolean {
  return node.last_seen >= now - NODE_ONLINE_SEC;
}
