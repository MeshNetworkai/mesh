import { MockAdapter } from '@mesh/chain-adapter';
import { loadTokenomics, type TokenomicsConfig } from '@mesh/config';
import type { AppContext } from '../src/context.js';
import { openDb, type Db } from '../src/db.js';
import { addLedgerEntry, ensureWallet } from '../src/ledger.js';
import type { Env } from '../src/env.js';
import type { InstallOptions } from '../src/routes/install.js';
import { buildServer } from '../src/server.js';
import { MockUpstream } from '../src/upstream.js';

const loaded = loadTokenomics();
/**
 * Protocol tests drive plain (unstaked, unpledged) fake nodes, so they run with the `network` privacy
 * tier as the default; the production default is `trusted` (docs/PRIVACY.md) and privacy.test.ts
 * exercises that with its own config.
 */
export const testConfig: TokenomicsConfig = {
  ...loaded,
  privacy: { ...loaded.privacy, default: 'network' },
  // Protocol tests register plain nodes and sign in directly: beta gating and spot checks are exercised by beta.test.ts / verification.test.ts with their own config.
  beta: { ...loaded.beta, enabled: false },
  verification: { ...loaded.verification, enabled: false },
  // Starter credits would shift the exact balances the e2e test asserts; starter.test.ts turns them on with its own config.
  starterCredits: { ...loaded.starterCredits, enabled: false },
  // The mock upstream costs a round $0.001 a request and the protocol tests assert exact balances against it, so
  // they run at list price. The shipped markup and upstream fee are asserted in catalogue.test.ts and exercised
  // with their own config in catalogue.test.ts / usage-share.test.ts.
  requestPricing: { ...loaded.requestPricing, upstreamMarkupBps: 0, upstreamFeeBps: 0 },
};

/** Pricing exactly as config/tokenomics.json ships it (markup and upstream fee included). */
export const SHIPPED_PRICING = loaded.requestPricing;

/**
 * Credit a wallet with ordinary, sellable credit (what an epoch distribution or a purchase leaves behind).
 * POST /admin/starter-credit grants starter credit, which the shipped config does not let a wallet list.
 */
export function grantCredit(db: Db, wallet: string, amountUsd: number, chain = 'solana'): void {
  ensureWallet(db, wallet, chain);
  addLedgerEntry(db, { wallet, deltaMicros: Math.round(amountUsd * 1_000_000), kind: 'adjustment', ref: 'test:grant' });
}

/** Network pricing the tests assert against, read from config/tokenomics.json so a repricing does not break the arithmetic. */
export const NETWORK_PRICE_PER_M = testConfig.requestPricing.networkPricePerMTokens;
export const NODE_REWARD_PER_M = testConfig.nodeRewards.usdPerMTokens;
/** Flat micro-USD billed to the user / accrued to the node for `tokens` total tokens served by the network. */
export const networkMicros = (tokens: number) => (tokens > 0 ? Math.max(1, Math.ceil(tokens * NETWORK_PRICE_PER_M)) : 0);
export const rewardMicros = (tokens: number) => Math.round(tokens * NODE_REWARD_PER_M);
/** Micro-USD -> USD as the API reports it (6 decimals). */
export const usd = (micros: number) => micros / 1_000_000;

export function memDb() {
  return openDb(':memory:');
}

export const TEST_ENV: Partial<Env> = {
  MESH_DB_PATH: ':memory:',
  MESH_ADAPTER: 'mock',
  JWT_SECRET: 'test-secret-test-secret-test-secret',
  ADMIN_TOKEN: 'test-admin',
  AUTH_DOMAIN: 'test.mesh',
  AUTH_URI: 'https://test.mesh',
  AUTH_RATE_LIMIT: 10_000,
  STATS_CACHE_MS: 0,
  GEO_BLOCK_ENFORCE: false,
  // Legacy unsigned node registration for the protocol tests; security.test.ts turns it on.
  NODES_REQUIRE_SIGNATURE: false,
  NODE_REGISTER_RATE_LIMIT: 10_000,
  ALERTS_ENABLED: false,
};

export async function testServer(
  opts: {
    holders?: Record<string, number>;
    config?: TokenomicsConfig;
    env?: Partial<Env>;
    context?: Partial<AppContext>;
    install?: InstallOptions;
  } = {},
) {
  const adapter = new MockAdapter({ chain: 'solana', holders: opts.holders });
  const app = await buildServer({
    logger: false,
    install: opts.install,
    env: { ...TEST_ENV, ...opts.env },
    context: { db: memDb(), adapter, config: opts.config ?? testConfig, upstream: new MockUpstream(0), ...opts.context },
  });
  return { app, adapter };
}

export const ADMIN = { 'x-admin-token': 'test-admin' };
