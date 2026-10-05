/**
 * Gateway node protocol client (docs/NODE_PROTOCOL.md). Field names here are the wire contract:
 *   POST /nodes/register {linkCode | wallet, chip, ramGb, models[], agentVersion, maxParallel?} -> {nodeId, nodeToken, wallet, maxParallel}
 *   POST /nodes/:id/heartbeat {models, busy, loadAvg?, maxParallel?}
 *   GET  /nodes/:id/jobs/next (long-poll <= 25 s) -> 204 | Job
 *   POST /nodes/:id/jobs/:jobId/chunk {seq, delta}
 *   POST /nodes/:id/jobs/:jobId/done  {promptTokens, completionTokens, finishReason}
 *   POST /nodes/:id/jobs/:jobId/fail  {error}
 *   GET  /nodes/:id -> NodeStats
 */

export interface RegisterInput {
  /**
   * One-time link code from the web app (Run a node -> Link a Mac). The wallet signed the registration
   * challenge in the browser; the gateway binds this node to that wallet. Preferred: no key on the Mac.
   */
  linkCode?: string;
  /** Legacy unsigned flow (gateway with NODES_REQUIRE_SIGNATURE=false). Ignored when `linkCode` is set. */
  wallet?: string;
  chip: string;
  ramGb: number;
  models: string[];
  agentVersion: string;
  /** Jobs this node runs at once (Ollama OLLAMA_NUM_PARALLEL). The gateway caps it (routing.maxParallelPerNode). */
  maxParallel?: number;
  /** Re-register a stored id (requires its current token as bearer; the gateway rotates the token). */
  nodeId?: string;
}

export interface RegisterResult {
  nodeId: string;
  nodeToken: string;
  /** Reward wallet the node is bound to (from the link code, or echoed back). */
  wallet?: string;
  walletVerified?: boolean;
  linked?: boolean;
  /** What the gateway accepted for maxParallel (it may be lower than what we asked for). */
  maxParallel?: number;
  heartbeatEverySec?: number;
  offlineAfterSec?: number;
  pollMaxWaitMs?: number;
}

export interface HeartbeatBody {
  models: string[];
  /** Pin (true) or release (false) the node as "no capacity" until the next heartbeat. Not a count. */
  busy: boolean;
  loadAvg?: number;
  maxParallel?: number;
}

export interface HeartbeatResult {
  ok?: boolean;
  heartbeatEverySec?: number;
  offlineAfterSec?: number;
  queuedJobs?: number;
  maxParallel?: number;
}

export interface JobMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }> | null;
}

export interface Job {
  jobId: string;
  /** Ollama tag, e.g. llama3.1:8b */
  model: string;
  messages: JobMessage[];
  params?: Record<string, unknown>;
  maxTokens?: number | null;
  /** Absolute unix ms when > 1e12, otherwise a budget in ms from receipt. */
  deadlineMs?: number | null;
  /** 1, or 2 when the gateway re-queued the job after another node failed. */
  attempt?: number;
}

export interface NodeStats {
  nodeId?: string;
  status: 'online' | 'idle' | 'busy' | 'offline' | string;
  uptimePct24h: number;
  jobs24h: number;
  tokens24h: number;
  earnedUsd24h: number;
  earnedUsdTotal: number;
  lastSeen: number | null;
  chip?: string;
  ramGb?: number;
  models?: string[];
  wallet?: string;
  maxParallel?: number;
  runningJobs?: number;
  quarantined?: boolean;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    /** From a `retry-after` header (429/503), in ms; callers wait at least this long. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
  /** Network failure, 5xx or 429: worth retrying with backoff. 4xx (other than 429) is final. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export const LONG_POLL_MS = 25_000;

/** `retry-after` as seconds or an HTTP date -> ms (null when absent/unparseable). Capped at 5 minutes. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const sec = Number(value);
  let ms: number;
  if (Number.isFinite(sec)) ms = sec * 1000;
  else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.max(0, Math.min(ms, 5 * 60_000));
}

/** One signal that fires when either the timeout or the caller's signal does. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([timeout, signal]);
}

export class GatewayClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  setToken(token: string) {
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(opts.timeoutMs ?? 15_000, opts.signal),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (opts.signal?.aborted) throw new GatewayError(0, `${method} ${path} aborted`, 'aborted');
      const why = e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ?? e.message;
      throw new GatewayError(0, `could not reach gateway at ${this.baseUrl}: ${why}`, 'network');
    }
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let code: string | null = null;
      try {
        const b = (await res.json()) as { error?: unknown; message?: string };
        if (typeof b.error === 'string') {
          code = b.error;
          message = b.message ?? b.error;
        } else if (b.error && typeof b.error === 'object') {
          const e = b.error as { message?: string; code?: string };
          message = e.message ?? message;
          code = e.code ?? null;
        }
      } catch {
        /* non-JSON */
      }
      throw new GatewayError(res.status, `${method} ${path} -> ${message}`, code, parseRetryAfter(res.headers.get('retry-after')));
    }
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A proxy / captive portal answering 200 with HTML must not crash the loop with a bare SyntaxError.
      throw new GatewayError(res.status, `${method} ${path} -> unreadable reply (not JSON)`, 'bad_json');
    }
  }

  /** No auth for a fresh identity; the stored token as bearer when `input.nodeId` re-registers an existing node. */
  register(input: RegisterInput): Promise<RegisterResult> {
    return this.call<RegisterResult>('POST', '/nodes/register', input, { auth: Boolean(input.nodeId) });
  }

  heartbeat(nodeId: string, body: HeartbeatBody): Promise<HeartbeatResult | undefined> {
    return this.call<HeartbeatResult | undefined>('POST', `/nodes/${encodeURIComponent(nodeId)}/heartbeat`, body);
  }

  /**
   * Long-polls for the next job (gateway holds up to `wait` ms); resolves null on 204. The client-side
   * timeout is the poll wait plus a grace period so a healthy gateway's 204 always arrives before it.
   * `signal` lets the caller abandon a parked poll (shutdown) instead of waiting it out.
   */
  nextJob(nodeId: string, waitMs = LONG_POLL_MS, signal?: AbortSignal): Promise<Job | null> {
    return this.call<Job | undefined>('GET', `/nodes/${encodeURIComponent(nodeId)}/jobs/next?wait=${waitMs}`, undefined, {
      timeoutMs: waitMs + 10_000,
      signal,
    }).then((j) => j ?? null);
  }

  /**
   * Sends one chunk. A transient failure (network, 5xx, 429) is retried once with the same `seq`
   * after a short pause; the gateway de-duplicates. A 4xx (409 job_not_running) propagates so the
   * caller stops generating.
   */
  async chunk(nodeId: string, jobId: string, seq: number, delta: string): Promise<unknown> {
    const path = `/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/chunk`;
    try {
      return await this.call('POST', path, { seq, delta });
    } catch (err) {
      const e = err as GatewayError;
      if (e instanceof GatewayError && e.transient && e.code !== 'aborted') {
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs ?? 250, 2000)));
        return this.call('POST', path, { seq, delta });
      }
      throw err;
    }
  }

  done(nodeId: string, jobId: string, body: { promptTokens: number; completionTokens: number; finishReason: string }): Promise<unknown> {
    return this.call('POST', `/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/done`, body);
  }

  fail(nodeId: string, jobId: string, error: string): Promise<unknown> {
    return this.call('POST', `/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/fail`, { error });
  }

  stats(nodeId: string): Promise<NodeStats> {
    return this.call<NodeStats>('GET', `/nodes/${encodeURIComponent(nodeId)}`);
  }
}
