import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.js';

export interface NodeConfig {
  gateway: string;
  nodeId: string;
  nodeToken: string;
  wallet: string;
  models: string[];
  /** Ollama base URL (default http://127.0.0.1:11434). */
  ollama: string;
  chip: string;
  ramGb: number;
  registeredAt: number;
  /** Jobs to run at once (1..MAX_PARALLEL_LIMIT). Advertised to the gateway; mirrored into OLLAMA_NUM_PARALLEL. */
  maxParallel: number;
}

export const DEFAULT_GATEWAY = 'http://localhost:8787';
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
export const DEFAULT_MAX_PARALLEL = 1;
/** Local ceiling; the gateway applies its own (routing.maxParallelPerNode, 4 by default). */
export const MAX_PARALLEL_LIMIT = 16;

/** Keys `mesh-node config set <key> <value>` accepts, with their parser. */
export const CONFIG_SETTERS: Record<string, { parse: (raw: string) => Partial<NodeConfig>; help: string }> = {
  maxParallel: {
    parse: (raw) => ({ maxParallel: parseMaxParallel(raw) }),
    help: `jobs to run at once (1-${MAX_PARALLEL_LIMIT}; the gateway may cap it lower). Needs more RAM per extra job.`,
  },
  ollama: {
    parse: (raw) => {
      if (!/^https?:\/\//.test(raw)) throw new Error('ollama must be an http(s) URL, e.g. http://127.0.0.1:11434');
      return { ollama: raw.replace(/\/$/, '') };
    },
    help: 'Ollama base URL',
  },
  models: {
    parse: (raw) => {
      const models = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!models.length) throw new Error('models must be a comma-separated list of Ollama tags, e.g. llama3.1:8b,qwen2.5:14b');
      return { models };
    },
    help: 'comma-separated Ollama tags to serve',
  },
};

/** "2" -> 2; anything else (0, -1, "two", 3.5, 99) is an error with the allowed range. */
export function parseMaxParallel(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_LIMIT) throw new Error(`maxParallel must be a whole number from 1 to ${MAX_PARALLEL_LIMIT} (got ${String(raw)})`);
  return n;
}

export function loadConfig(file = paths.config()): NodeConfig | null {
  if (!existsSync(file)) return null;
  let raw: Partial<NodeConfig>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeConfig>;
  } catch {
    throw new Error(`config at ${file} is not valid JSON (was it edited by hand?); fix it or run \`mesh-node setup\` again`);
  }
  if (!raw || typeof raw !== 'object' || !raw.gateway || !raw.nodeId || !raw.nodeToken || !raw.wallet) {
    throw new Error(`config at ${file} is incomplete; run \`mesh-node setup\` again`);
  }
  ensurePrivate(file);
  let maxParallel = DEFAULT_MAX_PARALLEL;
  if (raw.maxParallel !== undefined) {
    // A hand-edited out-of-range value falls back to 1 rather than refusing to start the node.
    try {
      maxParallel = parseMaxParallel(raw.maxParallel);
    } catch {
      maxParallel = DEFAULT_MAX_PARALLEL;
    }
  }
  return {
    gateway: raw.gateway.replace(/\/$/, ''),
    nodeId: raw.nodeId,
    nodeToken: raw.nodeToken,
    wallet: raw.wallet,
    models: Array.isArray(raw.models) ? raw.models.filter((m): m is string => typeof m === 'string' && m.length > 0) : [],
    ollama: (raw.ollama ?? DEFAULT_OLLAMA).replace(/\/$/, ''),
    chip: raw.chip ?? 'unknown',
    ramGb: Number(raw.ramGb ?? 0),
    registeredAt: Number(raw.registeredAt ?? 0),
    maxParallel,
  };
}

/** The file holds the node token: if anything widened its permissions, put them back to 0600. */
function ensurePrivate(file: string): void {
  try {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    /* read-only filesystem etc.; the token is still only readable by whoever can read the dir */
  }
}

/** Writes atomically (tmp + rename) with 0600 perms; the directory gets 0700. */
export function saveConfig(cfg: NodeConfig, file = paths.config()): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function requireConfig(): NodeConfig {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error(`no node configured at ${paths.config()}. Run: mesh-node setup --link <code> (code from the web app: Run a node -> Link a Mac)`);
  }
  return cfg;
}
