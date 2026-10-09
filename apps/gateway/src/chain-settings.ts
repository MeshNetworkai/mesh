/**
 * Chain / token settings the founder pastes in Admin → Token, so the launched token can be plugged in
 * without editing JSON (the internal docs repo). Overrides live in `chain_settings` (migration 17) and win
 * over `config/deploy.<network>.json` when the adapter is built. The live EVM adapter only goes live
 * once `token` + `feeVault` are known; until then the gateway runs the MockAdapter and says so.
 */
import {
  applyEvmOverrides,
  checkPonsConfig,
  createAdapter,
  defaultNetworkFor,
  deployConfigPath,
  evmConfigReady,
  EVM_OVERRIDABLE_FIELDS,
  loadDeployConfig,
  MockAdapter,
  type ChainAdapter,
  type DeployConfig,
  type EvmDeployConfig,
  type EvmOverridableField,
  type PonsCheckReport,
  checksumPastedAddress,
  normalizeEvmAddress,
  sweeperAddressFromKey,
} from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { z } from 'zod';
import { nowSec, type Db } from './db.js';
import type { Env } from './env.js';

export type ChainOverrides = Partial<{
  token: string;
  feeVault: string;
  creditPool: string;
  treasury: string;
  stable: string;
  swapRouter: string;
  priceFeed: string;
  deployBlock: number;
  excludeWallets: string[];
}>;

const ADDRESS_FIELDS = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed'] as const;

/** Checksummed 0x address, or null/'' to clear. Lower-case input is accepted and checksummed; a wrong mixed-case checksum is rejected. */
const addressField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v.trim() === '') return null;
    const r = checksumPastedAddress(v);
    if ('error' in r) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error });
      return z.NEVER;
    }
    return r.address;
  });

export const ChainSettingsBody = z
  .object({
    chainId: z.number().int().positive().optional(),
    token: addressField,
    feeVault: addressField,
    creditPool: addressField,
    treasury: addressField,
    stable: addressField,
    swapRouter: addressField,
    priceFeed: addressField,
    deployBlock: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/), z.null()]).optional(),
    excludeWallets: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
  })
  .strict();
export type ChainSettingsInput = z.infer<typeof ChainSettingsBody>;

export function readOverrides(db: Db): ChainOverrides {
  const rows = db.prepare(`SELECT key, value FROM chain_settings`).all() as Array<{ key: string; value: string }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out as ChainOverrides;
}

export function overrideMeta(db: Db): Array<{ key: string; updatedAt: number; updatedBy: string | null }> {
  return (db.prepare(`SELECT key, updated_at, updated_by FROM chain_settings ORDER BY key`).all() as Array<{ key: string; updated_at: number; updated_by: string | null }>).map((r) => ({
    key: r.key,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

/**
 * Persist a validated body: present keys are written (null clears), absent keys are left alone.
 * Returns the normalised overrides that were written.
 */
export function writeOverrides(db: Db, input: ChainSettingsInput, by: string | null): ChainOverrides {
  const upsert = db.prepare(`INSERT INTO chain_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const del = db.prepare(`DELETE FROM chain_settings WHERE key = ?`);
  const written: Record<string, unknown> = {};
  const t = nowSec();
  db.transaction(() => {
    for (const k of ADDRESS_FIELDS) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null) del.run(k);
      else upsert.run(k, JSON.stringify(v), t, by);
      written[k] = v;
    }
    if (input.deployBlock !== undefined) {
      if (input.deployBlock === null) del.run('deployBlock');
      else upsert.run('deployBlock', JSON.stringify(Number(input.deployBlock)), t, by);
      written.deployBlock = input.deployBlock === null ? null : Number(input.deployBlock);
    }
    if (input.excludeWallets !== undefined) {
      const list = normaliseExclude(input.excludeWallets);
      if (list === null) del.run('excludeWallets');
      else upsert.run('excludeWallets', JSON.stringify(list), t, by);
      written.excludeWallets = list;
    }
  })();
  return written as ChainOverrides;
}

/** Comma/whitespace separated or array → unique lower-case addresses; throws on a non-address. null clears. */
export function normaliseExclude(v: string[] | string | null): string[] | null {
  if (v === null) return null;
  const raw = Array.isArray(v) ? v : v.split(/[\s,]+/);
  const out: string[] = [];
  for (const w of raw) {
    const s = w.trim();
    if (!s) continue;
    const l = normalizeEvmAddress(s);
    if (!l) throw new Error(`excludeWallets: not a 0x address: ${s}`);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

export function clearOverrides(db: Db): void {
  db.prepare(`DELETE FROM chain_settings`).run();
}

// ------------------------------------------------------------------ effective config

export interface EffectiveChain {
  chain: TokenomicsConfig['chain'];
  network: string;
  file: { path: string; exists: boolean; config: EvmDeployConfig | null; error: string | null };
  overrides: ChainOverrides;
  effective: EvmDeployConfig | null;
  ready: boolean;
  /** Which fields the override changed vs the file. */
  overridden: EvmOverridableField[];
}

export function effectiveChain(db: Db, config: TokenomicsConfig, env: NodeJS.ProcessEnv = process.env): EffectiveChain {
  const network = defaultNetworkFor(config.chain, env, config.deployNetwork);
  // MESH_CONFIG_DIR points at another config/ directory (tests use a blank pre-launch template).
  const dir = env.MESH_CONFIG_DIR || undefined;
  const path = deployConfigPath(network, dir);
  let file: DeployConfig | null = null;
  let error: string | null = null;
  try {
    file = loadDeployConfig(network, dir);
  } catch (err) {
    error = (err as Error).message;
  }
  const evmFile = file && file.chain === 'evm' ? file : null;
  const overrides = readOverrides(db);
  const effective = config.chain === 'evm' ? applyEvmOverrides(evmFile ?? emptyEvm(network), overrides) : null;
  const overridden = EVM_OVERRIDABLE_FIELDS.filter((k) => overrides[k] !== undefined && overrides[k] !== null);
  return { chain: config.chain, network, file: { path, exists: file !== null || error !== null, config: evmFile, error }, overrides, effective, ready: evmConfigReady(effective), overridden };
}

function emptyEvm(network: string): EvmDeployConfig {
  return { chain: 'evm', network, chainId: 0, deployBlock: 0, excludeWallets: [], feeSource: 'pons' };
}

// ------------------------------------------------------------------ adapter resolution

export interface ResolvedAdapter {
  adapter: ChainAdapter;
  /** What /health reports: `mock`, `mock (waiting for token)`, `evm (pons)`, `evm`, `solana`. */
  status: string;
  /** Why we are on mock despite MESH_ADAPTER asking for the chain, if so. */
  waitingFor: string | null;
}

/**
 * Build the adapter for this process. MESH_ADAPTER=mock → MockAdapter. Otherwise the live adapter for
 * tokenomics.chain, from the deploy JSON with the admin overrides applied; an EVM config without
 * token + feeVault yields the MockAdapter with a "waiting for token" status so the rest of the gateway
 * (and /health) keeps working until the founder pastes the addresses.
 */
export function resolveAdapter(db: Db, config: TokenomicsConfig, env: Env): ResolvedAdapter {
  if (env.MESH_ADAPTER === 'mock') return { adapter: new MockAdapter({ chain: config.chain, acceptMockSignatures: env.NODE_ENV !== 'production' }), status: 'mock', waitingFor: null };
  if (config.chain === 'evm') {
    const eff = effectiveChain(db, config, process.env);
    if (!eff.ready || !eff.effective) {
      const missing = ['token', 'feeVault'].filter((k) => !(eff.effective as Record<string, unknown> | null)?.[k]);
      return { adapter: new MockAdapter({ chain: 'evm', acceptMockSignatures: env.NODE_ENV !== 'production' }), status: 'mock (waiting for token)', waitingFor: `set ${missing.join(' + ')} in Admin → Token (or config/deploy.${eff.network}.json)` };
    }
    const adapter = createAdapter(config, { deploy: eff.effective, network: eff.network });
    return { adapter, status: eff.effective.feeSource === 'pons' ? 'evm (pons)' : 'evm', waitingFor: null };
  }
  return { adapter: createAdapter(config), status: config.chain, waitingFor: null };
}

/** The sweeper address the gateway would sign with (from MESH_EVM_PRIVATE_KEY), for the Check report. */
export function sweeperAddress(env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  return sweeperAddressFromKey(env.MESH_EVM_PRIVATE_KEY);
}

/** Run the on-chain Check for the effective config (RPC from env > file > known chain). */
export async function runChainCheck(eff: EffectiveChain, env: NodeJS.ProcessEnv = process.env, inject?: { check?: typeof checkPonsConfig }): Promise<PonsCheckReport> {
  const cfg = eff.effective ?? emptyEvm(eff.network);
  const check = inject?.check ?? checkPonsConfig;
  return check(cfg, { rpcUrl: env.MESH_EVM_RPC_URL ?? cfg.rpcUrl, sweeperAddress: sweeperAddress(env) });
}
