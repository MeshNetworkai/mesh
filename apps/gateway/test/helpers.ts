import { MockAdapter } from '@mesh/chain-adapter';
import { loadTokenomics, type TokenomicsConfig } from '@mesh/config';
import type { AppContext } from '../src/context.js';
import { openDb } from '../src/db.js';
import type { Env } from '../src/env.js';
import { buildServer } from '../src/server.js';
import { MockUpstream } from '../src/upstream.js';

export const testConfig: TokenomicsConfig = loadTokenomics();

/** Network pricing the tests assert against, read from config/tokenomics.json so a repricing does not break the arithmetic. */
export const NETWORK_PRICE_PER_M = testConfig.requestPricing.networkPricePerMTokens;
export const NODE_REWARD_PER_M = testConfig.nodeRewards.usdPerMTokens;
/** Flat micro-USD billed to the user / accrued to the node for `tokens` total tokens served by the network. */
export const networkMicros = (tokens: number) => Math.round(tokens * NETWORK_PRICE_PER_M);
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
  } = {},
) {
  const adapter = new MockAdapter({ chain: 'solana', holders: opts.holders });
  const app = await buildServer({
    logger: false,
    env: { ...TEST_ENV, ...opts.env },
    context: { db: memDb(), adapter, config: opts.config ?? testConfig, upstream: new MockUpstream(0), ...opts.context },
  });
  return { app, adapter };
}

export const ADMIN = { 'x-admin-token': 'test-admin' };
