import { MockAdapter, PonsEvmAdapter, type PonsCheckReport } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../src/server.js';
import { MockUpstream } from '../src/upstream.js';
import { effectiveChain, normaliseExclude, readOverrides, resolveAdapter, writeOverrides, ChainSettingsBody } from '../src/chain-settings.js';
import { loadEnv } from '../src/env.js';
import { ADMIN, memDb, TEST_ENV, testConfig, testServer } from './helpers.js';

/** Admin → Token: chain_settings overrides, /admin/chain routes, adapter resolution (the internal docs repo). */

const TOKEN = '0x1000000000000000000000000000000000000001';
const VAULT = '0x2000000000000000000000000000000000000002';
const POOL = '0x4000000000000000000000000000000000000004';
const CURVE = '0x5000000000000000000000000000000000000005';
// checksummed real-looking address + its lower-case and wrong-case forms
const CHECKSUMMED = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const WRONG_CASE = '0xd3afEB2a57f70eF218Aa82451c51B2fb0416Ac9e';

const evmConfig: TokenomicsConfig = { ...testConfig, chain: 'evm', deployNetwork: 'robinhood' };

// These tests describe the pre-launch state (template without token/feeVault). The real
// config/deploy.robinhood.json carries the deployed vault, so point effectiveChain at a blank copy.
const FIXTURE_CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config');
let savedConfigDir: string | undefined;
beforeAll(() => {
  savedConfigDir = process.env.MESH_CONFIG_DIR;
  process.env.MESH_CONFIG_DIR = FIXTURE_CONFIG_DIR;
});
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.MESH_CONFIG_DIR;
  else process.env.MESH_CONFIG_DIR = savedConfigDir;
});

describe('chain settings: validation + persistence', () => {
  it('accepts checksummed / lower-case addresses, rejects a wrong checksum and non-addresses', () => {
    expect(ChainSettingsBody.parse({ token: CHECKSUMMED }).token).toBe(CHECKSUMMED);
    expect(ChainSettingsBody.parse({ token: CHECKSUMMED.toLowerCase() }).token).toBe(CHECKSUMMED);
    expect(ChainSettingsBody.parse({ token: '' }).token).toBeNull();
    expect(ChainSettingsBody.safeParse({ token: WRONG_CASE }).success).toBe(false);
    expect(ChainSettingsBody.safeParse({ token: '0x1234' }).success).toBe(false);
    expect(ChainSettingsBody.safeParse({ nope: 1 }).success).toBe(false);
    expect(ChainSettingsBody.parse({ deployBlock: '123' }).deployBlock).toBe('123');
  });

  it('normalises exclusion lists from text or arrays', () => {
    expect(normaliseExclude(`${POOL},\n${CURVE} ${POOL}`)).toEqual([POOL, CURVE]);
    expect(normaliseExclude([CHECKSUMMED])).toEqual([CHECKSUMMED.toLowerCase()]);
    expect(normaliseExclude(null)).toBeNull();
    expect(() => normaliseExclude(['bad'])).toThrow(/not a 0x address/);
  });

  it('writes, merges with the JSON template and reports readiness', () => {
    const db = memDb();
    const before = effectiveChain(db, evmConfig, process.env);
    expect(before.network).toBe('robinhood');
    expect(before.file.exists).toBe(true);
    expect(before.effective?.chainId).toBe(4663);
    expect(before.effective?.feeSource).toBe('pons');
    expect(before.ready).toBe(false);
    expect(before.overridden).toEqual([]);

    writeOverrides(db, ChainSettingsBody.parse({ token: TOKEN, feeVault: VAULT, deployBlock: '777', excludeWallets: `${CURVE}` }), 'header');
    expect(readOverrides(db)).toEqual({ token: TOKEN, feeVault: VAULT, deployBlock: 777, excludeWallets: [CURVE] });
    const after = effectiveChain(db, evmConfig, process.env);
    expect(after.ready).toBe(true);
    expect(after.effective?.token).toBe(TOKEN);
    expect(after.effective?.deployBlock).toBe(777);
    // exclusions merge: the template's Pons contracts stay, the curve is added
    expect(after.effective?.excludeWallets).toContain(CURVE);
    expect(after.effective?.excludeWallets).toContain(CHECKSUMMED.toLowerCase());
    expect(after.overridden).toEqual(['token', 'feeVault', 'deployBlock', 'excludeWallets']);

    // null clears a key; absent keys are untouched
    writeOverrides(db, ChainSettingsBody.parse({ feeVault: null }), 'header');
    expect(readOverrides(db).feeVault).toBeUndefined();
    expect(readOverrides(db).token).toBe(TOKEN);
    expect(effectiveChain(db, evmConfig, process.env).ready).toBe(false);
  });

  it('resolveAdapter: mock when asked, mock (waiting for token) until token + feeVault, then PonsEvmAdapter', () => {
    const db = memDb();
    const mockEnv = loadEnv({ ...(TEST_ENV as Record<string, string>), MESH_ADAPTER: 'mock' } as NodeJS.ProcessEnv);
    expect(resolveAdapter(db, evmConfig, mockEnv)).toMatchObject({ status: 'mock', waitingFor: null });

    const liveEnv = loadEnv({ ...(TEST_ENV as Record<string, string>), MESH_ADAPTER: 'evm' } as NodeJS.ProcessEnv);
    const waiting = resolveAdapter(db, evmConfig, liveEnv);
    expect(waiting.adapter).toBeInstanceOf(MockAdapter);
    expect(waiting.status).toBe('mock (waiting for token)');
    expect(waiting.waitingFor).toMatch(/token \+ feeVault/);

    writeOverrides(db, ChainSettingsBody.parse({ token: TOKEN, feeVault: VAULT }), 'header');
    const live = resolveAdapter(db, evmConfig, liveEnv);
    expect(live.adapter).toBeInstanceOf(PonsEvmAdapter);
    expect(live.status).toBe('evm (pons)');
    const p = live.adapter as PonsEvmAdapter;
    expect(p.opts.tokenAddress).toBe(TOKEN);
    expect(p.opts.ponsEscrow).toBe(CHECKSUMMED); // from the template
    expect(p.opts.chainId).toBe(4663);
  });
});

describe('GET/POST /admin/chain', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('round-trips overrides with validation, chainId check and audit rows', async () => {
    const { app } = await testServer({ config: evmConfig });
    apps.push(app);
    const g0 = await app.inject({ method: 'GET', url: '/admin/chain', headers: ADMIN });
    expect(g0.statusCode).toBe(200);
    const v0 = g0.json();
    expect(v0.chainId).toBe(4663);
    expect(v0.chainName).toBe('Robinhood Chain');
    expect(v0.feeSource).toBe('pons');
    expect(v0.adapter.ready).toBe(false);
    expect(v0.fields).toContain('excludeWallets');
    expect(v0.file.values.token).toBeNull();

    const bad = await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { token: WRONG_CASE } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toMatch(/checksum/);

    const mismatch = await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { chainId: 8453, token: TOKEN } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('chain_mismatch');

    const badExcl = await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { excludeWallets: 'nope' } });
    expect(badExcl.statusCode).toBe(400);

    const ok = await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { chainId: 4663, token: TOKEN.toLowerCase(), feeVault: VAULT, deployBlock: 100, excludeWallets: [CURVE, POOL] } });
    expect(ok.statusCode).toBe(200);
    const v1 = ok.json();
    expect(v1.written).toEqual({ token: TOKEN, feeVault: VAULT, deployBlock: 100, excludeWallets: [CURVE, POOL] });
    expect(v1.overrides.token).toBe(TOKEN);
    expect(v1.effective.token).toBe(TOKEN);
    expect(v1.effective.excludeWallets).toEqual(expect.arrayContaining([CURVE, POOL, CHECKSUMMED.toLowerCase()]));
    expect(v1.adapter.ready).toBe(true);
    expect(v1.adapter.status).toBe('mock'); // test server injects a MockAdapter
    expect(v1.overridden).toEqual(['token', 'feeVault', 'deployBlock', 'excludeWallets']);

    const rows = app.ctx.db.prepare(`SELECT action FROM admin_actions WHERE action = 'chain-settings'`).all();
    expect(rows).toHaveLength(1);

    const cleared = await app.inject({ method: 'DELETE', url: '/admin/chain', headers: ADMIN });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().cleared.sort()).toEqual(['deployBlock', 'excludeWallets', 'feeVault', 'token']);
    expect(cleared.json().adapter.ready).toBe(false);

    const anon = await app.inject({ method: 'GET', url: '/admin/chain' });
    expect(anon.statusCode).toBe(401);
  });

  it('refuses the panel when tokenomics.chain is solana', async () => {
    const { app } = await testServer({ config: { ...testConfig, chain: 'solana' } });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(409);
  });

  it('POST /admin/chain/check returns the report from the injected checker', async () => {
    let seen: unknown = null;
    const fake = async (cfg: unknown, opts: unknown): Promise<PonsCheckReport> => {
      seen = { cfg, opts };
      return { ok: false, chainId: 4663, rpcUrl: 'x', rpcReachable: false, rpcChainId: null, checkedAt: 1, items: [{ check: 'rpc', status: 'fail', detail: 'unreachable' }] };
    };
    const { app } = await testServer({ config: evmConfig, context: { chainCheck: fake as never } });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/chain', headers: ADMIN, payload: { token: TOKEN, feeVault: VAULT } });
    const r = await app.inject({ method: 'POST', url: '/admin/chain/check', headers: ADMIN, payload: { rpcUrl: 'http://127.0.0.1:1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: false, ready: true, items: [{ check: 'rpc', status: 'fail' }] });
    expect((seen as { cfg: { token: string; chainId: number }; opts: { rpcUrl: string } }).cfg).toMatchObject({ token: TOKEN, chainId: 4663 });
    expect((seen as { opts: { rpcUrl: string } }).opts.rpcUrl).toBe('http://127.0.0.1:1');
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'chain-check'`).get()).toEqual({ n: 1 });
  });

  it('the real checker runs offline: static validation, unreachable RPC → fail items, never throws', async () => {
    const { app } = await testServer({ config: evmConfig });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/admin/chain/check', headers: ADMIN, payload: { rpcUrl: 'http://127.0.0.1:1' } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as PonsCheckReport & { ready: boolean };
    expect(body.ok).toBe(false);
    expect(body.ready).toBe(false);
    const by = Object.fromEntries(body.items.map((i) => [i.check, i.status]));
    expect(by['field.token']).toBe('fail');
    expect(by['field.feeVault']).toBe('fail');
    expect(by['field.ponsEscrow']).toBe('ok');
    expect(by['rpc']).toBe('fail');
  }, 20_000);
});

describe('/health adapter status', () => {
  it('reports mock (waiting for token) when MESH_ADAPTER=evm but the template has no token', async () => {
    const app = await buildServer({
      logger: false,
      env: { ...TEST_ENV, MESH_ADAPTER: 'evm' },
      context: { db: memDb(), config: evmConfig, upstream: new MockUpstream(0) },
    });
    try {
      expect(app.ctx.adapter).toBeInstanceOf(MockAdapter);
      const h = await app.inject({ method: 'GET', url: '/health' });
      expect(h.json()).toMatchObject({ adapter: 'mock (waiting for token)', adapterRequested: 'evm', chain: 'evm' });
      const ov = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
      expect(ov.json().adapter).toBe('mock (waiting for token)');
      const c = await app.inject({ method: 'GET', url: '/admin/chain', headers: ADMIN });
      expect(c.json().adapter).toMatchObject({ status: 'mock (waiting for token)', requested: 'evm', ready: false, restartNeeded: false });
      expect(c.json().adapter.waitingFor).toMatch(/token \+ feeVault/);
    } finally {
      await app.close();
    }
  });
});
