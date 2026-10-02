import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
}

export const DEFAULT_GATEWAY = 'http://localhost:8787';
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';

export function loadConfig(file = paths.config()): NodeConfig | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeConfig>;
  if (!raw.gateway || !raw.nodeId || !raw.nodeToken || !raw.wallet) throw new Error(`config at ${file} is incomplete; run \`mesh-node setup\` again`);
  return {
    gateway: raw.gateway.replace(/\/$/, ''),
    nodeId: raw.nodeId,
    nodeToken: raw.nodeToken,
    wallet: raw.wallet,
    models: Array.isArray(raw.models) ? raw.models : [],
    ollama: (raw.ollama ?? DEFAULT_OLLAMA).replace(/\/$/, ''),
    chip: raw.chip ?? 'unknown',
    ramGb: Number(raw.ramGb ?? 0),
    registeredAt: Number(raw.registeredAt ?? 0),
  };
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
