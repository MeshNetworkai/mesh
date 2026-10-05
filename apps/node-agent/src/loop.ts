import { existsSync } from 'node:fs';
import { DEFAULT_MAX_PARALLEL, type NodeConfig } from './config.js';
import { GatewayClient, GatewayError, type Job } from './gateway.js';
import type { Logger } from './log.js';
import { OllamaClient } from './ollama.js';
import { AGENT_VERSION, paths } from './paths.js';
import { runJob, type RunResult } from './runner.js';
import { loadAvg1m } from './system.js';

export interface LoopOptions {
  config: NodeConfig;
  log: Logger;
  heartbeatMs?: number;
  /** Called after a successful re-registration so the caller can persist the new identity. */
  onReregister?: (cfg: NodeConfig) => void;
  /** Stop after this many jobs (tests). */
  maxJobs?: number;
  isPaused?: () => boolean;
  gateway?: GatewayClient;
  ollama?: OllamaClient;
  /** Chunk batching window passed to the runner. */
  batchMs?: number;
  /** Ollama stall budget passed to the runner. */
  stallMs?: number;
}

export interface LoopStats {
  jobs: number;
  failed: number;
  /** Jobs running right now. */
  active: number;
  maxParallel: number;
  /** Convenience: at capacity (or paused). */
  busy: boolean;
}

export interface LoopHandle {
  stop: () => Promise<void>;
  done: Promise<void>;
  stats: () => LoopStats;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Exponential backoff 1s -> 60s with +-30% jitter. */
export function backoffMs(attempt: number, base = 1000, cap = 60_000): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/** Backoff for a failed gateway call: jittered exponential, but never shorter than a `retry-after` the gateway sent. */
export function retryDelayMs(err: unknown, attempt: number): number {
  const wait = backoffMs(attempt);
  const ra = err instanceof GatewayError ? err.retryAfterMs : null;
  return ra !== null ? Math.max(wait, ra) : wait;
}

/**
 * The `start` loop: heartbeat every 20 s, long-poll for jobs and run up to `maxParallel` at a time.
 *
 * Heartbeat `busy` is a pin, not a count (docs/NODE_PROTOCOL.md §2): `true` tells the gateway to route
 * nothing here until the next heartbeat says `false`. We send `true` only while paused, draining, or
 * at capacity, and send an extra heartbeat the moment that stops being the case so the node is not
 * idle for a heartbeat interval after every job. In-flight jobs are counted by the gateway itself.
 *
 * Gateway errors back off exponentially with jitter (plus any retry-after); a 401/404 re-registers
 * the node with the saved wallet. The loops never exit on their own and never reject.
 */
export function startLoop(opts: LoopOptions): LoopHandle {
  const { log } = opts;
  let cfg = opts.config;
  const maxParallel = Math.max(1, Math.floor(cfg.maxParallel || DEFAULT_MAX_PARALLEL));
  const gateway = opts.gateway ?? new GatewayClient(cfg.gateway, cfg.nodeToken);
  const ollama = opts.ollama ?? new OllamaClient(cfg.ollama);
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const isPaused = opts.isPaused ?? (() => existsSync(paths.pauseFlag()));
  const ac = new AbortController();

  let jobs = 0;
  let failed = 0;
  const active = new Map<string, Promise<RunResult>>();
  let draining = false;
  let hbFailures = 0;
  let pollFailures = 0;
  let lastSentBusy: boolean | null = null;
  let reregistering: Promise<void> | null = null;
  let lastReregisterLog = 0;
  let capLogged = false;

  const shouldPin = () => draining || isPaused() || active.size >= maxParallel;

  const registerInput = () => ({ wallet: cfg.wallet, chip: cfg.chip, ramGb: cfg.ramGb, models: cfg.models, agentVersion: AGENT_VERSION, maxParallel });

  const reregister = () => {
    if (reregistering) return reregistering;
    reregistering = (async () => {
      try {
        log.warn('gateway rejected our node credentials; re-registering');
        const reg = await gateway.register(registerInput());
        gateway.setToken(reg.nodeToken);
        cfg = { ...cfg, nodeId: reg.nodeId, nodeToken: reg.nodeToken, registeredAt: Math.floor(Date.now() / 1000) };
        try {
          opts.onReregister?.(cfg);
        } catch (err) {
          log.error(`could not save the new node identity: ${(err as Error).message}`);
        }
        log.info(`re-registered as ${cfg.nodeId}${reg.maxParallel && reg.maxParallel < maxParallel ? ` (gateway capped maxParallel at ${reg.maxParallel})` : ''}`);
      } finally {
        reregistering = null;
      }
    })();
    return reregistering;
  };

  const explainReregisterFailure = (rerr: unknown) => {
    // Repeats every heartbeat while the gateway refuses us: say it once a minute, not three times a minute.
    const t = Date.now();
    if (t - lastReregisterLog < 60_000) return;
    lastReregisterLog = t;
    const re = rerr as GatewayError;
    if (re instanceof GatewayError && re.code === 'signature_required') {
      log.error('re-register failed: the gateway requires a wallet-signed registration. Open the Mesh app (Run a node -> Link a Mac) and run `mesh-node setup --link <code>`');
    } else log.error(`re-register failed: ${(rerr as Error).message}`);
  };

  const handleGatewayError = async (err: unknown, what: string, failures: number): Promise<void> => {
    const e = err as GatewayError;
    if (e instanceof GatewayError && (e.status === 401 || e.status === 404)) {
      try {
        await reregister();
        // One successful re-registration is a fix; a second 401 right after means the gateway keeps
        // rejecting us, and we must not hot-loop register -> poll -> 401 -> register.
        if (failures <= 1) return;
      } catch (rerr) {
        explainReregisterFailure(rerr);
      }
    }
    const wait = retryDelayMs(err, failures);
    if (failures === 1 || failures % 10 === 0) log.warn(`${what} failed x${failures} (${(err as Error).message}); retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait, ac.signal);
  };

  const heartbeat = async () => {
    const busy = shouldPin();
    try {
      const r = await gateway.heartbeat(cfg.nodeId, { models: cfg.models, busy, loadAvg: loadAvg1m(), maxParallel });
      lastSentBusy = busy;
      if (hbFailures >= 3) log.info('gateway reachable again');
      hbFailures = 0;
      if (r && typeof r.maxParallel === 'number' && r.maxParallel < maxParallel && !capLogged) {
        capLogged = true;
        log.info(`gateway caps this node at ${r.maxParallel} parallel job(s) (config asks for ${maxParallel})`);
      }
    } catch (err) {
      hbFailures++;
      const e = err as GatewayError;
      if (e instanceof GatewayError && (e.status === 401 || e.status === 404)) {
        await reregister().catch(explainReregisterFailure);
      } else if (hbFailures === 1 || hbFailures % 10 === 0) {
        log.warn(`heartbeat failed x${hbFailures}: ${(err as Error).message}`);
      }
    }
  };

  const heartbeatLoop = async () => {
    while (!ac.signal.aborted) {
      await heartbeat().catch((err: Error) => log.error(`heartbeat crashed: ${err.message}`));
      await sleep(heartbeatMs, ac.signal);
    }
  };

  /** A job ended: free the slot and, if the last heartbeat pinned us, unpin right away. */
  const onJobEnd = (res: RunResult) => {
    if (!res.ok) failed++;
    if (lastSentBusy && !shouldPin() && !ac.signal.aborted) void heartbeat().catch(() => undefined);
  };

  const launch = (job: Job) => {
    jobs++;
    const id = typeof job.jobId === 'string' ? job.jobId : `anon_${jobs}`;
    log.info(`job ${id} start model=${job.model} messages=${job.messages?.length ?? 0}${job.maxTokens ? ` maxTokens=${job.maxTokens}` : ''}${job.attempt && job.attempt > 1 ? ` attempt=${job.attempt}` : ''}${maxParallel > 1 ? ` slots=${active.size + 1}/${maxParallel}` : ''}`);
    const p = runJob(job, gateway, cfg.nodeId, ollama, { batchMs: opts.batchMs, stallMs: opts.stallMs, log: (m) => log.info(m) })
      .catch((err: Error): RunResult => {
        // runJob reports every outcome as a result; this is the belt to its braces.
        log.error(`job ${id} crashed the runner: ${err.message}`);
        return { jobId: id, ok: false, promptTokens: 0, completionTokens: 0, finishReason: 'error', chunks: 0, chars: 0, durationMs: 0, error: err.message, outcome: 'failed' };
      })
      .then((res) => {
        active.delete(id);
        onJobEnd(res);
        return res;
      });
    active.set(id, p);
    // At capacity now: let the gateway know at once rather than at the next tick.
    if (active.size >= maxParallel) void heartbeat().catch(() => undefined);
  };

  const pollLoop = async () => {
    let wasPaused = false;
    while (!ac.signal.aborted) {
      if (opts.maxJobs !== undefined && jobs >= opts.maxJobs) break;
      if (isPaused()) {
        if (!wasPaused) {
          log.info(`paused: not taking new jobs${active.size ? ` (finishing ${active.size} running)` : ''}. \`mesh-node resume\` to continue`);
          wasPaused = true;
          void heartbeat().catch(() => undefined);
        }
        await sleep(2000, ac.signal);
        continue;
      }
      if (wasPaused) {
        log.info('resumed');
        wasPaused = false;
        void heartbeat().catch(() => undefined);
      }
      if (active.size >= maxParallel) {
        // Every slot is taken: wait for one to free up (or for a stop) before asking for more work.
        await Promise.race([...active.values(), sleep(heartbeatMs, ac.signal)]);
        continue;
      }
      let job: Job | null;
      const polledAt = Date.now();
      try {
        job = await gateway.nextJob(cfg.nodeId, undefined, ac.signal);
        if (pollFailures >= 3) log.info('gateway reachable again');
        pollFailures = 0;
      } catch (err) {
        if (ac.signal.aborted) break;
        pollFailures++;
        await handleGatewayError(err, 'job poll', pollFailures);
        continue;
      }
      if (!job) {
        // A gateway that answers 204 immediately instead of holding the poll must not make us spin.
        if (Date.now() - polledAt < 500) await sleep(1000, ac.signal);
        continue;
      }
      launch(job);
    }
    await Promise.allSettled([...active.values()]);
  };

  const done = Promise.all([heartbeatLoop(), pollLoop()]).then(
    () => undefined,
    (err: Error) => log.error(`node loop ended unexpectedly: ${err.message}`),
  );

  return {
    done,
    stats: () => ({ jobs, failed, active: active.size, maxParallel, busy: shouldPin() }),
    stop: async () => {
      if (ac.signal.aborted) return done;
      draining = true;
      log.info(active.size ? `stopping: finishing ${active.size} running job(s), then exiting` : 'stopping');
      // Pin busy first so no new job is routed here while we drain; then abandon the parked poll.
      await gateway.heartbeat(cfg.nodeId, { models: cfg.models, busy: true, maxParallel }).catch(() => undefined);
      ac.abort();
      await Promise.allSettled([...active.values()]);
      return done;
    },
  };
}
