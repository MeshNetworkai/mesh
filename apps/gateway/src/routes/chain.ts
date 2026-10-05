/**
 * Admin → Token: GET /admin/chain (effective config: JSON file vs DB overrides), POST /admin/chain
 * (save overrides; validated, audited), POST /admin/chain/check (on-chain verification report),
 * DELETE /admin/chain (clear every override). Changing an override does not swap the running adapter:
 * the gateway builds it at start-up, so the response says whether a restart is needed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ChainSettingsBody, clearOverrides, effectiveChain, normaliseExclude, overrideMeta, readOverrides, runChainCheck, sweeperAddress, writeOverrides, type EffectiveChain } from '../chain-settings.js';
import { authViaOf, type AppContext } from '../context.js';
import { KNOWN_CHAINS } from '@mesh/chain-adapter';

export interface ChainView {
  chain: string;
  network: string;
  chainId: number | null;
  chainName: string | null;
  explorer: string | null;
  rpcUrl: string | null;
  feeSource: string | null;
  /** Adapter the running process uses + whether a restart would change it. */
  adapter: { status: string; requested: string; ready: boolean; restartNeeded: boolean; waitingFor: string | null };
  sweeper: string | null;
  file: { path: string; exists: boolean; error: string | null; values: Record<string, unknown> };
  overrides: Record<string, unknown>;
  overrideMeta: Array<{ key: string; updatedAt: number; updatedBy: string | null }>;
  effective: Record<string, unknown>;
  overridden: string[];
  fields: string[];
}

const FIELDS = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed', 'deployBlock', 'excludeWallets'] as const;

function pick(cfg: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) out[f] = cfg?.[f] ?? null;
  return out;
}

export function chainView(ctx: AppContext, eff: EffectiveChain): ChainView {
  const e = eff.effective as unknown as Record<string, unknown> | null;
  const chainId = eff.effective?.chainId || null;
  const known = chainId ? KNOWN_CHAINS[chainId] : undefined;
  const status = ctx.adapterStatus ?? ctx.env.MESH_ADAPTER;
  const requested = ctx.env.MESH_ADAPTER;
  const wouldBeLive = requested !== 'mock' && eff.ready;
  const isLive = !status.startsWith('mock');
  return {
    chain: eff.chain,
    network: eff.network,
    chainId,
    chainName: known?.name ?? null,
    explorer: (eff.effective?.explorer as string | undefined) ?? known?.explorer ?? null,
    rpcUrl: process.env.MESH_EVM_RPC_URL ? '(MESH_EVM_RPC_URL set)' : ((eff.effective?.rpcUrl as string | undefined) ?? known?.rpc ?? null),
    feeSource: eff.effective?.feeSource ?? null,
    adapter: {
      status,
      requested,
      ready: eff.ready,
      restartNeeded: wouldBeLive !== isLive,
      waitingFor: requested !== 'mock' && !eff.ready ? `set ${['token', 'feeVault'].filter((k) => !e?.[k]).join(' + ')} and restart` : null,
    },
    sweeper: sweeperAddress() ?? null,
    file: { path: eff.file.path, exists: eff.file.exists, error: eff.file.error, values: pick(eff.file.config as unknown as Record<string, unknown> | null) },
    overrides: pick(eff.overrides as Record<string, unknown>),
    overrideMeta: overrideMeta(ctx.db),
    effective: { ...pick(e), chainId, rpcUrl: eff.effective?.rpcUrl ?? null, sweepMode: eff.effective?.sweepMode ?? null, quoteTokens: eff.effective?.quoteTokens ?? null, fixedEthUsd: eff.effective?.fixedEthUsd ?? null, ponsEscrow: eff.effective?.ponsEscrow ?? null, curve: eff.effective?.curve ?? null },
    overridden: eff.overridden,
    fields: [...FIELDS],
  };
}

export function chainRoutes(app: FastifyInstance, ctx: AppContext, guard: (req: FastifyRequest, reply: never) => Promise<unknown>, audit: (req: FastifyRequest, action: string, payload: unknown) => number) {
  const view = () => chainView(ctx, effectiveChain(ctx.db, ctx.config, process.env));

  app.get('/admin/chain', { preHandler: guard as never }, async () => view());

  app.post('/admin/chain', { preHandler: guard as never, bodyLimit: 64 * 1024 }, async (req, reply) => {
    if (ctx.config.chain !== 'evm') return reply.code(409).send({ error: 'not_evm', message: `tokenomics.chain is "${ctx.config.chain}"; the Token panel only configures EVM deployments` });
    const parsed = ChainSettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const body = parsed.data;
    const eff = effectiveChain(ctx.db, ctx.config, process.env);
    if (body.chainId !== undefined && eff.effective?.chainId && body.chainId !== eff.effective.chainId) {
      return reply.code(400).send({ error: 'chain_mismatch', message: `these addresses are for chainId ${body.chainId}; config/deploy.${eff.network}.json is chainId ${eff.effective.chainId}` });
    }
    if (body.excludeWallets !== undefined) {
      try {
        normaliseExclude(body.excludeWallets);
      } catch (err) {
        return reply.code(400).send({ error: 'bad_request', message: (err as Error).message });
      }
    }
    const before = readOverrides(ctx.db);
    const written = writeOverrides(ctx.db, body, authViaOf(req) ?? null);
    audit(req, 'chain-settings', { written, before, ip: req.ip, requestId: req.id });
    const v = view();
    return { ok: true, written, ...v };
  });

  app.delete('/admin/chain', { preHandler: guard as never }, async (req) => {
    const before = readOverrides(ctx.db);
    clearOverrides(ctx.db);
    audit(req, 'chain-settings-clear', { before, ip: req.ip, requestId: req.id });
    return { ok: true, cleared: Object.keys(before), ...view() };
  });

  const CheckBody = z.object({ rpcUrl: z.string().url().optional() }).optional();
  /** On-chain verification of the effective config: token is an ERC-20, escrow balance, vault roles, exclusions. */
  app.post('/admin/chain/check', { preHandler: guard as never, bodyLimit: 16 * 1024 }, async (req, reply) => {
    const parsed = CheckBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const eff = effectiveChain(ctx.db, ctx.config, process.env);
    const env = parsed.data?.rpcUrl ? { ...process.env, MESH_EVM_RPC_URL: parsed.data.rpcUrl } : process.env;
    const report = await runChainCheck(eff, env, ctx.chainCheck ? { check: ctx.chainCheck } : undefined);
    audit(req, 'chain-check', { ok: report.ok, rpcReachable: report.rpcReachable, fails: report.items.filter((i) => i.status === 'fail').map((i) => i.check), requestId: req.id });
    return { ...report, ready: eff.ready, adapter: ctx.adapterStatus ?? ctx.env.MESH_ADAPTER };
  });
}
