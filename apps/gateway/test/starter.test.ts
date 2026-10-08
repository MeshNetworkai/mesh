import { MockAdapter } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADMIN, testConfig, testServer } from './helpers.js';

/** Starter credits on first connect (src/starter.ts, docs/SWITCHING.md). */

const STARTER = testConfig.starterCredits;
const AMOUNT = STARTER.amountUsd;

/** The shipped block requires the wallet to hold; most tests here sign in wallets that hold nothing, so they switch that off. */
function withStarter(patch: Partial<TokenomicsConfig['starterCredits']> = {}): TokenomicsConfig {
  return { ...testConfig, starterCredits: { ...STARTER, enabled: true, requireMinHold: false, ...patch } };
}

async function signIn(app: FastifyInstance, wallet: string, ip = '203.0.113.10') {
  const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet }, remoteAddress: ip });
  const { nonce, message } = n.json();
  const r = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature: MockAdapter.sign(wallet, message), nonce, message }, remoteAddress: ip });
  expect(r.statusCode).toBe(200);
  return r.json() as { token: string; starter: { amountUsd: number; balanceUsd: number } | null };
}

async function balance(app: FastifyInstance, token: string): Promise<number> {
  const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
  expect(me.statusCode).toBe(200);
  return me.json().balance.usd as number;
}

describe('starter credits on first connect', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('config ships the block', () => {
    expect(AMOUNT).toBeGreaterThan(0);
    expect(STARTER.maxWallets).toBeGreaterThan(0);
    expect(STARTER.maxPerIpPerDay).toBe(3);
    // Shipped: only wallets that hold get it, and it cannot be sold on the marketplace.
    expect(STARTER.requireMinHold).toBe(true);
    expect(STARTER.transferable).toBe(false);
  });

  it('as shipped, a wallet that holds nothing gets no starter credit', async () => {
    const { app } = await testServer({ config: { ...testConfig, starterCredits: { ...STARTER, enabled: true } }, holders: { holder: testConfig.minHoldTokens } });
    apps.push(app);
    expect((await signIn(app, 'stranger')).starter).toBeNull();
    expect((await signIn(app, 'holder', '203.0.113.11')).starter?.amountUsd).toBe(AMOUNT);
  });

  it('first sign-in grants once; the second sign-in does not grant again', async () => {
    const { app } = await testServer({ config: withStarter() });
    apps.push(app);
    const first = await signIn(app, 'newdev');
    expect(first.starter).toEqual({ amountUsd: AMOUNT, balanceUsd: AMOUNT });
    expect(await balance(app, first.token)).toBe(AMOUNT);

    const second = await signIn(app, 'newdev');
    expect(second.starter).toBeNull();
    expect(await balance(app, second.token)).toBe(AMOUNT);

    // Ledger row uses the existing `starter` kind with the auto ref, so /report and the admin overview count it.
    const ledger = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${second.token}` } });
    const rows = ledger.json().ledger as Array<{ kind: string; ref: string | null }>;
    expect(rows.filter((r) => r.kind === 'starter' && r.ref === 'starter:auto')).toHaveLength(1);

    const stats = await app.inject({ method: 'GET', url: '/stats' });
    expect(stats.json().starterGrants).toMatchObject({ enabled: true, amountUsd: AMOUNT, granted: 1, remaining: STARTER.maxWallets - 1 });
  });

  it('stops at maxWallets', async () => {
    const { app } = await testServer({ config: withStarter({ maxWallets: 2 }) });
    apps.push(app);
    expect((await signIn(app, 'w1', '198.51.100.1')).starter?.amountUsd).toBe(AMOUNT);
    expect((await signIn(app, 'w2', '198.51.100.2')).starter?.amountUsd).toBe(AMOUNT);
    const third = await signIn(app, 'w3', '198.51.100.3');
    expect(third.starter).toBeNull();
    expect(await balance(app, third.token)).toBe(0);
    const stats = await app.inject({ method: 'GET', url: '/stats' });
    expect(stats.json().starterGrants).toMatchObject({ granted: 2, remaining: 0 });
  });

  it('grants nothing when disabled in config', async () => {
    const { app } = await testServer({ config: withStarter({ enabled: false }) });
    apps.push(app);
    const r = await signIn(app, 'offdev');
    expect(r.starter).toBeNull();
    expect(await balance(app, r.token)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().starterGrants).toMatchObject({ enabled: false, granted: 0 });
  });

  it('caps grants per IP hash per day (sybil farming)', async () => {
    const { app } = await testServer({ config: withStarter({ maxPerIpPerDay: 3 }) });
    apps.push(app);
    const ip = '192.0.2.44';
    for (const w of ['s1', 's2', 's3']) expect((await signIn(app, w, ip)).starter?.amountUsd).toBe(AMOUNT);
    const fourth = await signIn(app, 's4', ip);
    expect(fourth.starter).toBeNull();
    expect(await balance(app, fourth.token)).toBe(0);
    // A different IP is unaffected.
    expect((await signIn(app, 's5', '192.0.2.45')).starter?.amountUsd).toBe(AMOUNT);
  });

  it('requireMinHold skips wallets below minHoldTokens', async () => {
    const { app } = await testServer({ config: withStarter({ requireMinHold: true }), holders: { holder: testConfig.minHoldTokens, dust: 1 } });
    apps.push(app);
    expect((await signIn(app, 'holder', '192.0.2.1')).starter?.amountUsd).toBe(AMOUNT);
    expect((await signIn(app, 'dust', '192.0.2.2')).starter).toBeNull();
  });

  it('admin can list grants and pause/resume at runtime (audited)', async () => {
    const { app } = await testServer({ config: withStarter() });
    apps.push(app);
    await signIn(app, 'early', '192.0.2.9');

    const list = await app.inject({ method: 'GET', url: '/admin/starter', headers: ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ enabled: true, configEnabled: true, override: null, granted: 1 });
    expect(list.json().grants[0]).toMatchObject({ wallet: 'early', amountUsd: AMOUNT });
    expect(list.json().grants[0].ipHash).toHaveLength(8);

    const off = await app.inject({ method: 'POST', url: '/admin/starter/toggle', headers: ADMIN, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, override: false });
    expect((await signIn(app, 'late', '192.0.2.10')).starter).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().starterGrants.enabled).toBe(false);

    // bare toggle flips it back; null clears the override
    const on = await app.inject({ method: 'POST', url: '/admin/starter/toggle', headers: ADMIN, payload: {} });
    expect(on.json()).toMatchObject({ enabled: true, override: true });
    const clear = await app.inject({ method: 'POST', url: '/admin/starter/toggle', headers: ADMIN, payload: { enabled: null } });
    expect(clear.json()).toMatchObject({ enabled: true, override: null });
    expect((await signIn(app, 'late', '192.0.2.10')).starter?.amountUsd).toBe(AMOUNT);

    const bad = await app.inject({ method: 'POST', url: '/admin/starter/toggle', headers: ADMIN, payload: { enabled: 'yes' } });
    expect(bad.statusCode).toBe(400);

    const overview = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    const actions = overview.json().recentAdminActions as Array<{ action: string; payload: unknown }>;
    const toggles = actions.filter((a) => a.action === 'starter-toggle');
    expect(toggles.length).toBe(3);
    expect(toggles[toggles.length - 1].payload).toMatchObject({ before: true, after: false });

    const noAuth = await app.inject({ method: 'GET', url: '/admin/starter' });
    expect(noAuth.statusCode).toBe(401);
  });
});
