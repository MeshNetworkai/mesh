/**
 * Gateway node protocol client (docs/NODE_PROTOCOL.md). Field names here are the wire contract:
 *   POST /nodes/register {linkCode | wallet, chip, ramGb, models[], agentVersion} -> {nodeId, nodeToken, wallet}
 *   POST /nodes/:id/heartbeat {models, busy, loadAvg?}
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
  heartbeatEverySec?: number;
  offlineAfterSec?: number;
  pollMaxWaitMs?: number;
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
}

export interface NodeStats {
  nodeId?: string;
  status: 'online' | 'busy' | 'offline' | string;
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
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export const LONG_POLL_MS = 25_000;

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

  private async call<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new GatewayError(0, `could not reach gateway at ${this.baseUrl}: ${(err as Error).message}`, 'network');
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
      throw new GatewayError(res.status, `${method} ${path} -> ${message}`, code);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** No auth for a fresh identity; the stored token as bearer when `input.nodeId` re-registers an existing node. */
  register(input: RegisterInput): Promise<RegisterResult> {
    return this.call<RegisterResult>('POST', '/nodes/register', input, { auth: Boolean(input.nodeId) });
  }

  heartbeat(nodeId: string, body: { models: string[]; busy: boolean; loadAvg?: number }): Promise<unknown> {
    return this.call('POST', `/nodes/${encodeURIComponent(nodeId)}/heartbeat`, body);
  }

  /** Long-polls for the next job (gateway holds up to `wait` ms); resolves null on 204. */
  nextJob(nodeId: string, waitMs = LONG_POLL_MS): Promise<Job | null> {
    return this.call<Job | undefined>('GET', `/nodes/${encodeURIComponent(nodeId)}/jobs/next?wait=${waitMs}`, undefined, {
      timeoutMs: waitMs + 10_000,
    }).then((j) => j ?? null);
  }

  /**
   * Sends one chunk. A transient failure (network, 5xx) is retried once with the same `seq`; the
   * gateway de-duplicates. A 4xx (409 job_not_running) propagates so the caller stops generating.
   */
  async chunk(nodeId: string, jobId: string, seq: number, delta: string): Promise<unknown> {
    const path = `/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/chunk`;
    try {
      return await this.call('POST', path, { seq, delta });
    } catch (err) {
      const e = err as GatewayError;
      if (e instanceof GatewayError && (e.status === 0 || e.status >= 500)) return this.call('POST', path, { seq, delta });
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
