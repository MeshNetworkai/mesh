import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import type { NodeSource, Reputation, ReputationConfig } from './routing.js';
import { NODE_ONLINE_SEC, isQuarantined, nodeModels, nodeReputation, type NodeRow } from './routing.js';

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
  /**
   * Set on a spot-check re-run (verification.ts): the job id this one verifies. INTERNAL — never part
   * of the node-facing job view; a node cannot tell a check from a client request.
   */
  check_of: string | null;
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

/** Most out-of-order chunks a relay buffers while waiting for a gap to fill (a node that skips seqs is misbehaving). */
export const RELAY_MAX_PENDING = 2048;
/** Most delta bytes a relay holds (gap buffer + events the client has not consumed yet) before it refuses chunks. */
export const RELAY_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** In-memory event queue between the node's POSTs and the client handler. */
export class JobRelay {
  private queue: RelayEvent[] = [];
  private waiter: ((ev: RelayEvent) => void) | null = null;
  private nextSeq = 0;
  private pending = new Map<number, string>();
  /** Delta bytes currently held in `pending` + `queue` (bounded by RELAY_MAX_BUFFERED_BYTES). */
  private buffered = 0;
  /** Set when the client handler gave up on this job (timeout / disconnect). */
  closed = false;
  /** Set once the node reported done/fail: later chunks are refused. */
  finished = false;
  nodeId: string | null = null;
  chunks = 0;
  /** Delta characters delivered to the client so far. */
  chars = 0;
  /** UTF-8 bytes of those deltas: what `completionTokenBound` measures a node's reported usage against. */
  bytes = 0;

  /**
   * Queue an event. Returns false when it was refused: the relay is closed or finished, or a chunk
   * would exceed the buffering caps (the node is told to stop via the 409 the caller sends).
   */
  push(ev: RelayEvent): boolean {
    if (this.closed) return false;
    if (ev.type === 'claimed') {
      this.nodeId = ev.nodeId;
      this.emit(ev);
      return true;
    }
    if (this.finished) return false;
    if (ev.type === 'chunk') {
      // Deliver in seq order; drop duplicates; buffer gaps (bounded).
      if (ev.seq < this.nextSeq || this.pending.has(ev.seq)) return true;
      if (ev.seq !== this.nextSeq && this.pending.size >= RELAY_MAX_PENDING) return false;
      if (this.buffered + ev.delta.length > RELAY_MAX_BUFFERED_BYTES) return false;
      this.pending.set(ev.seq, ev.delta);
      this.buffered += ev.delta.length;
      while (this.pending.has(this.nextSeq)) {
        const delta = this.pending.get(this.nextSeq)!;
        this.pending.delete(this.nextSeq);
        this.emit({ type: 'chunk', seq: this.nextSeq, delta });
        this.nextSeq++;
      }
      return true;
    }
    if (ev.type === 'done' || ev.type === 'fail') this.finished = true;
    this.emit(ev);
    return true;
  }

  /** Buffered events the client handler has not consumed yet (a slow client); exposed for observability. */
  get depth(): number {
    return this.queue.length;
  }

  private emit(ev: RelayEvent): void {
    if (ev.type === 'chunk') {
      this.chunks++;
      this.chars += ev.delta.length;
      this.bytes += Buffer.byteLength(ev.delta);
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (ev.type === 'chunk') this.buffered -= ev.delta.length;
      w(ev);
    } else this.queue.push(ev);
  }

  /** Next event, or `{type:'timeout'}` after `timeoutMs`. */
  next(timeoutMs: number): Promise<RelayEvent> {
    if (this.queue.length) {
      const ev = this.queue.shift()!;
      if (ev.type === 'chunk') this.buffered -= ev.delta.length;
      return Promise.resolve(ev);
    }
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
    this.queue.length = 0;
    this.pending.clear();
    this.buffered = 0;
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
  /** Verification re-run of this job id (stored in `jobs.check_of`, never sent to a node). */
  checkOf?: string | null;
  attempt?: number;
}

export type DoneResult = { ok: true; usage: JobUsage } | { ok: false; reason: 'not_running' | 'empty_output' };

/** How long the online-node snapshot is reused before re-reading the `nodes` table. */
export const NODE_SNAPSHOT_MS = 1000;
/** How long a node's reputation is cached (also invalidated on done / node-fault failure / mismatch). */
export const REPUTATION_CACHE_MS = 60_000;
/** How long the queued-jobs count returned to heartbeats is cached. */
export const QUEUE_DEPTH_CACHE_MS = 2000;
/** Heartbeat prune + expired-job reap interval. */
export const MAINTENANCE_INTERVAL_MS = 60_000;

export class JobBroker implements NodeSource {
  private relays = new Map<string, JobRelay>();
  private waiters: Waiter[] = [];
  /** Running jobs per node, authoritative for this process (mirrored to `nodes.busy`). */
  private running = new Map<string, number>();
  /** Nodes whose last heartbeat said `busy: true` (paused / full by their own account): no capacity until the next heartbeat. */
  private pinnedBusy = new Set<string>();
  private snapshot: { at: number; rows: NodeRow[] } | null = null;
  private repCache = new Map<string, { at: number; rep: Reputation }>();
  private queueDepth: { at: number; n: number } | null = null;
  private maintenance: NodeJS.Timeout | null = null;
  /** Injectable clock (ms) for tests. */
  now: () => number = () => Date.now();

  constructor(
    private db: Db,
    private routing: () => ReputationConfig,
    /** Whether a node may claim `trusted` jobs (routing.ts `isTrustedNode`). Absent → no node is trusted. */
    private isTrusted: (node: NodeRow) => boolean = () => false,
  ) {
    const rows = this.db.prepare(`SELECT node_id, COUNT(*) AS n FROM jobs WHERE status = 'running' AND node_id IS NOT NULL GROUP BY node_id`).all() as Array<{ node_id: string; n: number }>;
    for (const r of rows) this.running.set(r.node_id, r.n);
  }

  relay(jobId: string): JobRelay | undefined {
    return this.relays.get(jobId);
  }

  /** Live relays (jobs with a client handler attached) — for /health observability. */
  get liveRelays(): number {
    return this.relays.size;
  }

  get(jobId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) as JobRow | undefined) ?? null;
  }

  // ---------------- fleet view (NodeSource) ----------------

  /** Online nodes from a snapshot refreshed at most every NODE_SNAPSHOT_MS (and on `invalidateNodes`). */
  onlineNodes(now = nowSec()): NodeRow[] {
    const t = this.now();
    if (!this.snapshot || t - this.snapshot.at >= NODE_SNAPSHOT_MS) {
      // Fetch a little wider than the online window so a snapshot taken up to NODE_SNAPSHOT_MS ago still covers it.
      this.snapshot = { at: t, rows: this.db.prepare(`SELECT * FROM nodes WHERE last_seen >= ? ORDER BY last_seen DESC`).all(now - NODE_ONLINE_SEC - 5) as NodeRow[] };
    }
    const cutoff = now - NODE_ONLINE_SEC;
    return this.snapshot.rows.filter((n) => n.last_seen >= cutoff);
  }

  /** Drop the online-node snapshot (a node registered, heartbeated with new models, pledged, was quarantined…). */
  invalidateNodes(): void {
    this.snapshot = null;
  }

  runningOn(nodeId: string): number {
    return this.running.get(nodeId) ?? 0;
  }

  isPinnedBusy(nodeId: string): boolean {
    return this.pinnedBusy.has(nodeId);
  }

  /** Heartbeat said `busy: true|false`: pin the node as full (no routing) or release the pin. */
  setPinnedBusy(nodeId: string, pinned: boolean): void {
    if (pinned) this.pinnedBusy.add(nodeId);
    else this.pinnedBusy.delete(nodeId);
    this.syncBusy(nodeId);
    this.invalidateNodes();
  }

  reputation(nodeId: string, cfg: ReputationConfig = this.routing()): Reputation {
    const t = this.now();
    const hit = this.repCache.get(nodeId);
    if (hit && t - hit.at < REPUTATION_CACHE_MS) return hit.rep;
    const rep = nodeReputation(this.db, nodeId, cfg);
    this.repCache.set(nodeId, { at: t, rep });
    return rep;
  }

  invalidateReputation(nodeId: string): void {
    this.repCache.delete(nodeId);
  }

  /** Jobs queued across every tag, cached QUEUE_DEPTH_CACHE_MS (returned to nodes on heartbeat). */
  queuedJobs(): number {
    const t = this.now();
    if (!this.queueDepth || t - this.queueDepth.at >= QUEUE_DEPTH_CACHE_MS) {
      this.queueDepth = { at: t, n: (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`).get() as { n: number }).n };
    }
    return this.queueDepth.n;
  }

  /** Mirror the running count (or the heartbeat pin) into `nodes.busy` for the public views. */
  private syncBusy(nodeId: string): void {
    const running = this.running.get(nodeId) ?? 0;
    if (this.pinnedBusy.has(nodeId)) this.db.prepare(`UPDATE nodes SET busy = MAX(max_parallel, ?) WHERE node_id = ?`).run(running, nodeId);
    else this.db.prepare(`UPDATE nodes SET busy = ? WHERE node_id = ?`).run(running, nodeId);
  }

  // ---------------- maintenance ----------------

  /** Prune heartbeat history and reap expired jobs on a timer (production); tests call `maintain()` by hand. */
  startMaintenance(intervalMs = MAINTENANCE_INTERVAL_MS): void {
    if (this.maintenance) return;
    this.maintenance = setInterval(() => this.maintain(), intervalMs);
    this.maintenance.unref?.();
  }

  stop(): void {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
  }

  maintain(now = this.now()): { heartbeatsPruned: number; jobsReaped: number } {
    const heartbeatsPruned = pruneHeartbeats(this.db, Math.floor(now / 1000));
    const jobsReaped = this.reapExpired(now);
    const t = this.now();
    for (const [id, e] of this.repCache) if (t - e.at >= REPUTATION_CACHE_MS) this.repCache.delete(id);
    return { heartbeatsPruned, jobsReaped };
  }

  // ---------------- jobs ----------------

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
        `INSERT INTO jobs (job_id, model, tag, wallet, api_key_id, status, privacy, requester_wallet, payload, max_tokens, deadline_ms, exclude_node_id, parent_job_id, check_of, attempt, created_at, created_ms)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.checkOf ?? null,
        input.attempt ?? 1,
        Math.floor(ms / 1000),
        ms,
      );
    this.queueDepth = null;
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
   * Atomic claim: exactly one node can move a job queued→running. Bumps the node's running count. A
   * `trusted` job is only claimable when `trusted` is true for the claiming node OR the node's reward
   * wallet is the job's `requester_wallet` (owner rule). Both are enforced in the UPDATE (the wallet via
   * a subquery on `nodes`), so a race between a trusted and an untrusted poller can never hand
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
      this.running.set(nodeId, (this.running.get(nodeId) ?? 0) + 1);
      this.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = ?`).run(Math.floor(ms / 1000), nodeId);
      this.syncBusy(nodeId);
      return this.get(jobId);
    });
    const job = tx();
    if (job) {
      this.queueDepth = null;
      this.relays.get(jobId)?.push({ type: 'claimed', nodeId });
    }
    return job;
  }

  /**
   * Node side of GET /nodes/:id/jobs/next: claim the oldest queued job matching the node's
   * tags, or wait up to `waitMs` for one. Resolves null on timeout (→ 204). A node may keep up to
   * `max_parallel` long-polls parked at once; an older one beyond that is answered 204 at once.
   */
  async pull(node: NodeRow, waitMs: number): Promise<JobRow | null> {
    const tags = new Set(nodeModels(node));
    if (tags.size === 0) return null;
    // Quarantined (verification.ts) or below the reputation threshold: nothing, even when jobs are queued.
    if (isQuarantined(node)) return null;
    if (!this.reputation(node.node_id, this.routing()).eligible) return null;
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
      // At most max_parallel parked long-polls per node: the oldest surplus one is released (204) now, not when its timer fires.
      const mine = this.waiters.filter((w) => w.nodeId === node.node_id);
      const cap = Math.max(1, node.max_parallel ?? 1);
      for (let i = 0; i <= mine.length - cap; i++) {
        const old = mine[i];
        this.waiters.splice(this.waiters.indexOf(old), 1);
        old.resolve(null);
      }
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

  /** Parked long-polls right now (for /health observability). */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Node posted a chunk. Returns false when the job is not running for this node (node should stop).
   * Hot path: the in-memory relay answers when it knows the job; the DB is only read when it does not.
   */
  chunk(jobId: string, nodeId: string, seq: number, delta: string): boolean {
    const relay = this.relays.get(jobId);
    if (!relay || relay.closed || relay.finished) return false;
    if (relay.nodeId !== nodeId) {
      // The relay has no claim recorded (e.g. a job claimed before this process knew the relay): check the DB once.
      const job = this.get(jobId);
      if (!job || job.status !== 'running' || job.node_id !== nodeId) return false;
      relay.nodeId = nodeId;
    }
    const first = relay.chunks === 0;
    if (!relay.push({ type: 'chunk', seq, delta })) return false;
    if (first && relay.chunks > 0) this.db.prepare(`UPDATE jobs SET first_chunk_ms = ? WHERE job_id = ? AND first_chunk_ms IS NULL`).run(Date.now(), jobId);
    return true;
  }

  /**
   * Node finished the job. `not_running` when the job is no longer running for this node. The usage a
   * node reports is what the client is billed and the node is rewarded for, so it is never taken on
   * trust: it is clamped to what the text the gateway itself saw can amount to (`completionTokenBound`
   * of the bytes relayed, and never above max_tokens; `promptTokenBound` of the messages sent), and a
   * "done" with no delivered output at all is a node failure (`empty_output`), never a paid reply.
   */
  done(jobId: string, nodeId: string, usage: JobUsage): DoneResult {
    const ms = Date.now();
    const relay = this.relays.get(jobId);
    if (relay && relay.chunks === 0 && !relay.closed) {
      const row = this.db.prepare(`SELECT status, node_id FROM jobs WHERE job_id = ?`).get(jobId) as { status: string; node_id: string | null } | undefined;
      if (!row || row.status !== 'running' || row.node_id !== nodeId) return { ok: false, reason: 'not_running' };
      this.nodeFail(jobId, nodeId, 'empty_output');
      return { ok: false, reason: 'empty_output' };
    }
    const tx = this.db.transaction((): DoneResult => {
      const job = this.db.prepare(`SELECT max_tokens, payload FROM jobs WHERE job_id = ? AND status = 'running' AND node_id = ?`).get(jobId, nodeId) as
        | { max_tokens: number; payload: string }
        | undefined;
      if (!job) return { ok: false, reason: 'not_running' };
      // Without a live relay (it belonged to a previous process) nobody is waiting to be billed; max_tokens alone bounds the row.
      const completionCap = relay ? Math.min(Math.max(1, job.max_tokens), completionTokenBound(relay.bytes)) : Math.max(1, job.max_tokens);
      const clamped: JobUsage = {
        promptTokens: clampInt(usage.promptTokens, 0, payloadPromptBound(job.payload)),
        completionTokens: clampInt(usage.completionTokens, 0, completionCap),
        finishReason: usage.finishReason,
      };
      this.db
        .prepare(
          `UPDATE jobs SET status = 'done', prompt_tokens = ?, completion_tokens = ?, finish_reason = ?, finished_ms = ?,
             first_chunk_ms = COALESCE(first_chunk_ms, ?)
           WHERE job_id = ? AND status = 'running' AND node_id = ?`,
        )
        .run(clamped.promptTokens, clamped.completionTokens, clamped.finishReason, ms, ms, jobId, nodeId);
      this.freeNode(nodeId);
      return { ok: true, usage: clamped };
    });
    const r = tx();
    if (!r.ok) return r;
    this.invalidateReputation(nodeId);
    relay?.push({ type: 'done', usage: r.usage });
    return r;
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
    const tx = this.db.transaction((): { ok: boolean; nodeId: string | null; hurt: boolean } => {
      const job = this.get(jobId);
      if (!job) return { ok: false, nodeId: null, hurt: false };
      // A job the node already failed may still be upgraded to 'fallback' once the upstream served the client.
      const upgrade = job.status === 'failed' && status === 'fallback' && !requireNode;
      if (!upgrade && job.status !== 'queued' && job.status !== 'running') return { ok: false, nodeId: null, hurt: false };
      if (requireNode && job.node_id !== requireNode) return { ok: false, nodeId: null, hurt: false };
      if (upgrade) {
        this.db.prepare(`UPDATE jobs SET status = 'fallback' WHERE job_id = ? AND status = 'failed'`).run(jobId);
        return { ok: true, nodeId: null, hurt: false };
      }
      const wasRunning = job.status === 'running';
      const hurt = Boolean(nodeFault && job.node_id);
      this.db
        .prepare(`UPDATE jobs SET status = ?, error = ?, node_fault = ?, finished_ms = ? WHERE job_id = ? AND status IN ('queued','running')`)
        .run(status, error.slice(0, 300), hurt ? 1 : 0, Date.now(), jobId);
      if (job.node_id && wasRunning) this.freeNode(job.node_id);
      return { ok: true, nodeId: job.node_id, hurt };
    });
    const r = tx();
    if (r.ok) this.queueDepth = null;
    if (r.ok && r.hurt && r.nodeId) this.invalidateReputation(r.nodeId);
    return r.ok;
  }

  /** One job finished on the node: decrement its running count (never below what the DB says is still running). */
  private freeNode(nodeId: string): void {
    const running = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE node_id = ? AND status = 'running'`).get(nodeId) as { n: number }).n;
    if (running === 0) this.running.delete(nodeId);
    else this.running.set(nodeId, running);
    this.syncBusy(nodeId);
  }

  /** Sweep jobs whose deadline passed while nobody was watching (process restart etc). */
  reapExpired(now = Date.now()): number {
    const rows = this.db.prepare(`SELECT job_id FROM jobs WHERE status IN ('queued','running') AND deadline_ms < ?`).all(now) as Array<{ job_id: string }>;
    for (const r of rows) this.abandon(r.job_id, 'failed', 'deadline_exceeded', false);
    return rows.length;
  }
}

/**
 * Fewest UTF-8 bytes a token is assumed to take. English prose runs near 4, code near 3, CJK about 3
 * per character; dense digits and punctuation approach 2. So a count above bytes / 2 is not something
 * the text can account for, and an honest node is not cut short.
 */
const MIN_BYTES_PER_TOKEN = 2;
/** Chat-template tokens allowed per message (role header, turn delimiters) and per prompt (BOS, generation header). */
const TEMPLATE_TOKENS_PER_MESSAGE = 16;
const TEMPLATE_TOKENS_PER_PROMPT = 64;

/** Most completion tokens `bytes` of relayed text can be. */
export function completionTokenBound(bytes: number): number {
  return Math.ceil(bytes / MIN_BYTES_PER_TOKEN) + 8;
}

/** Most prompt tokens `messages` messages totalling `contentBytes` of text can be. */
export function promptTokenBound(contentBytes: number, messages: number): number {
  return Math.ceil(contentBytes / MIN_BYTES_PER_TOKEN) + TEMPLATE_TOKENS_PER_MESSAGE * messages + TEMPLATE_TOKENS_PER_PROMPT;
}

/** `promptTokenBound` for a stored job payload; an unreadable payload is bounded by its whole length as one message. */
function payloadPromptBound(payload: string): number {
  try {
    const messages = (JSON.parse(payload) as JobPayload).messages;
    const bytes = messages.reduce((n, m) => n + Buffer.byteLength(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
    return promptTokenBound(bytes, messages.length);
  } catch {
    return promptTokenBound(Buffer.byteLength(payload), 1);
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.min(max, Math.max(min, n));
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

/** Append one heartbeat row. Pruning is done by `pruneHeartbeats` on the broker's maintenance timer, not here. */
export function recordHeartbeat(db: Db, nodeId: string, busy: boolean, now = nowSec()): void {
  db.prepare(`INSERT INTO heartbeats (node_id, ts, busy) VALUES (?, ?, ?)`).run(nodeId, now, busy ? 1 : 0);
}

/** Drop heartbeat rows older than HEARTBEAT_RETENTION_SEC; returns how many went. */
export function pruneHeartbeats(db: Db, now = nowSec()): number {
  return db.prepare(`DELETE FROM heartbeats WHERE ts < ?`).run(now - HEARTBEAT_RETENTION_SEC).changes;
}

export function isOnline(node: Pick<NodeRow, 'last_seen'>, now = nowSec()): boolean {
  return node.last_seen >= now - NODE_ONLINE_SEC;
}
