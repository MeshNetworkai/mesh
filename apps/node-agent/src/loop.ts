import { existsSync } from 'node:fs';
import type { NodeConfig } from './config.js';
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
}

export interface LoopHandle {
  stop: () => Promise<void>;
  done: Promise<void>;
  stats: () => { jobs: number; failed: number; busy: boolean };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Exponential backoff 1s -> 60s with jitter. */
export function backoffMs(attempt: number, base = 1000, cap = 60_000): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/**
 * The `start` loop: heartbeat every 20 s, long-poll for jobs, run one at a time. Pausing (flag
 * file) keeps heartbeats flowing with busy=true and stops polling. Gateway errors back off
 * exponentially; a 401/404 re-registers the node with the saved wallet.
 */
export function startLoop(opts: LoopOptions): LoopHandle {
  const { log } = opts;
  let cfg = opts.config;
  const gateway = opts.gateway ?? new GatewayClient(cfg.gateway, cfg.nodeToken);
  const ollama = opts.ollama ?? new OllamaClient(cfg.ollama);
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const isPaused = opts.isPaused ?? (() => existsSync(paths.pauseFlag()));
  const ac = new AbortController();

  let busy = false;
  let jobs = 0;
  let failed = 0;
  let current: Promise<RunResult> | null = null;
  let hbFailures = 0;
  let pollFailures = 0;
  let reregistering: Promise<void> | null = null;

  const reregister = () => {
    if (reregistering) return reregistering;
    reregistering = (async () => {
      try {
        log.warn('gateway rejected our node credentials; re-registering');
        const reg = await gateway.register({ wallet: cfg.wallet, chip: cfg.chip, ramGb: cfg.ramGb, models: cfg.models, agentVersion: AGENT_VERSION });
        gateway.setToken(reg.nodeToken);
        cfg = { ...cfg, nodeId: reg.nodeId, nodeToken: reg.nodeToken, registeredAt: Math.floor(Date.now() / 1000) };
        opts.onReregister?.(cfg);
        log.info(`re-registered as ${cfg.nodeId}`);
      } finally {
        reregistering = null;
      }
    })();
    return reregistering;
  };

  const handleGatewayError = async (err: unknown, what: string, failures: number): Promise<void> => {
    const e = err as GatewayError;
    if (e instanceof GatewayError && (e.status === 401 || e.status === 404)) {
      try {
        await reregister();
        return;
      } catch (rerr) {
        const re = rerr as GatewayError;
        if (re instanceof GatewayError && re.code === 'signature_required') {
          log.error('re-register failed: the gateway requires a wallet-signed registration. Open the Mesh app (Run a node -> Link a Mac) and run `mesh-node setup --link <code>`');
        } else log.error(`re-register failed: ${re.message}`);
      }
    }
    const wait = backoffMs(failures);
    log.warn(`${what} failed (${(err as Error).message}); retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait, ac.signal);
  };

  const heartbeat = async () => {
    try {
      await gateway.heartbeat(cfg.nodeId, { models: cfg.models, busy: busy || isPaused(), loadAvg: loadAvg1m() });
      hbFailures = 0;
    } catch (err) {
      hbFailures++;
      const e = err as GatewayError;
      if (e instanceof GatewayError && (e.status === 401 || e.status === 404)) {
        await reregister().catch((rerr: Error) => log.error(`re-register failed: ${rerr.message}`));
      } else if (hbFailures === 1 || hbFailures % 10 === 0) {
        log.warn(`heartbeat failed x${hbFailures}: ${(err as Error).message}`);
      }
    }
  };

  const heartbeatLoop = async () => {
    while (!ac.signal.aborted) {
      await heartbeat();
      await sleep(heartbeatMs, ac.signal);
    }
  };

  const pollLoop = async () => {
    let wasPaused = false;
    while (!ac.signal.aborted) {
      if (opts.maxJobs !== undefined && jobs >= opts.maxJobs) break;
      if (isPaused()) {
        if (!wasPaused) log.info('paused: not taking jobs (heartbeating as busy). `mesh-node resume` to continue');
        wasPaused = true;
        await sleep(2000, ac.signal);
        continue;
      }
      if (wasPaused) {
        log.info('resumed');
        wasPaused = false;
      }
      let job: Job | null;
      const polledAt = Date.now();
      try {
        job = await gateway.nextJob(cfg.nodeId);
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
      busy = true;
      jobs++;
      log.info(`job ${job.jobId} start model=${job.model} messages=${job.messages?.length ?? 0}${job.maxTokens ? ` maxTokens=${job.maxTokens}` : ''}`);
      // Tell the gateway right away that we are occupied.
      void heartbeat();
      current = runJob(job, gateway, cfg.nodeId, ollama, { batchMs: opts.batchMs, log: (m) => log.info(m) });
      const res = await current;
      current = null;
      busy = false;
      if (!res.ok) failed++;
    }
  };

  const done = Promise.all([heartbeatLoop(), pollLoop()]).then(() => undefined);

  return {
    done,
    stats: () => ({ jobs, failed, busy }),
    stop: async () => {
      if (ac.signal.aborted) return done;
      log.info('stopping: finishing the current job, then exiting');
      ac.abort();
      if (current) await current.catch(() => undefined);
      // Final heartbeat so the gateway marks us offline promptly.
      await gateway.heartbeat(cfg.nodeId, { models: cfg.models, busy: true }).catch(() => undefined);
      return done;
    },
  };
}
