import { listPriceForModel, parseModelPolicy, parseTokenomics, type ModelPrices, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { networkCostMicros } from '../src/routes/v1.js';
import { effectiveMultiplier, listCostMicros, networkSavingsUsd24h, savedMicros, walletSavings } from '../src/savings.js';
import { ADMIN, memDb, NETWORK_PRICE_PER_M, networkMicros, testConfig, testServer, usd } from './helpers.js';

const prices: ModelPrices = {
  default: { promptUsdPerM: 1, completionUsdPerM: 3 },
  models: {
    'openai/gpt-4o': { promptUsdPerM: 2.5, completionUsdPerM: 10 },
    'meta-llama/llama-3.1-8b-instruct': { promptUsdPerM: 0.05, completionUsdPerM: 0.08 },
    // priced below the flat network price, so a network-served request saves nothing
    'tiny-model': { promptUsdPerM: NETWORK_PRICE_PER_M / 2, completionUsdPerM: NETWORK_PRICE_PER_M / 2 },
  },
};
const policy = parseModelPolicy({
  networkModels: { 'llama-3.1-8b': 'llama3.1:8b', 'meta-llama/llama-3.1-8b-instruct': 'llama3.1:8b', 'big-model': 'big:70b' },
});

describe('network credits: cost math', () => {
  it('config: showSavings defaults to true and is read from tokenomics.json', () => {
    const parsed = parseTokenomics({ ...testConfig, requestPricing: { mode: 'passthrough', markupBps: 0 } });
    expect(parsed.requestPricing.showSavings).toBe(true);
    expect(parsed.requestPricing.networkPricePerMTokens).toBe(NETWORK_PRICE_PER_M);
    expect(testConfig.requestPricing.showSavings).toBe(true);
    expect(parseTokenomics({ ...testConfig, requestPricing: { ...testConfig.requestPricing, showSavings: false } }).requestPricing.showSavings).toBe(false);
  });

  it('listPriceForModel: exact entry, else the priced sibling with the same Ollama tag, else default', () => {
    expect(listPriceForModel(prices, policy, 'openai/gpt-4o')).toEqual({ promptUsdPerM: 2.5, completionUsdPerM: 10 });
    // alias without its own price entry -> sibling "meta-llama/llama-3.1-8b-instruct" (same tag)
    expect(listPriceForModel(prices, policy, 'llama-3.1-8b')).toEqual({ promptUsdPerM: 0.05, completionUsdPerM: 0.08 });
    // network model with no priced sibling -> default
    expect(listPriceForModel(prices, policy, 'big-model')).toEqual(prices.default);
    expect(listPriceForModel(prices, policy, 'unknown/model')).toEqual(prices.default);
  });

  it('listCostMicros = prompt*price + completion*price (+ markup), independent of what the network billed', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 500 };
    // gpt-4o: 1000*2.5 + 500*10 = 7500 micro-USD
    expect(listCostMicros(usage, 'openai/gpt-4o', prices, policy)).toBe(7500);
    // 10% markup is applied to the list price too (floor)
    expect(listCostMicros(usage, 'openai/gpt-4o', prices, policy, 1000)).toBe(8250);
    // alias resolves through the tag: 1000*0.05 + 500*0.08 = 90
    expect(listCostMicros(usage, 'llama-3.1-8b', prices, policy)).toBe(90);
    expect(listCostMicros(null, 'openai/gpt-4o', prices, policy)).toBe(0);
  });

  it('savedMicros is list - network, floored at zero; effectiveMultiplier is list / network to 1 decimal', () => {
    const network = networkCostMicros(1500, NETWORK_PRICE_PER_M);
    expect(network).toBe(1500 * NETWORK_PRICE_PER_M); // 30 micro-USD at $0.02/M
    expect(savedMicros(7500, network)).toBe(7500 - network);
    expect(effectiveMultiplier(7500, network)).toBe(Math.round((7500 / network) * 10) / 10);
    expect(effectiveMultiplier(720, 300)).toBe(2.4);
    expect(effectiveMultiplier(2500, 30)).toBe(83.3);
    // a model that is cheaper upstream than the flat network price saves nothing and goes 1x
    expect(savedMicros(network - 1, network)).toBe(0);
    expect(effectiveMultiplier(network - 1, network)).toBe(1);
    expect(effectiveMultiplier(0, 0)).toBe(1);
    expect(effectiveMultiplier(500, 0)).toBe(1);
  });

  it('walletSavings / networkSavingsUsd24h aggregate requests_log per wallet, 24h vs all time, network share and multiplier', () => {
    const db = memDb();
    const now = nowSec();
    const ins = db.prepare(
      `INSERT INTO requests_log (api_key_id, wallet, model, prompt_tokens, completion_tokens, cost_usd_micros, upstream, latency_ms, stream, created_at, list_cost_usd_micros, saved_usd_micros)
       VALUES (1, ?, 'm', 10, 10, ?, ?, 1, 0, ?, ?, ?)`,
    );
    // alice: two network requests (one old), one upstream request
    ins.run('alice', 300, 'node:n1', now - 10, 720, 420);
    ins.run('alice', 100, 'node:n1', now - 2 * 86_400, 480, 380);
    ins.run('alice', 5000, 'openrouter', now - 20, 5000, 0);
    // bob: only upstream
    ins.run('bob', 900, 'openrouter', now - 5, 900, 0);

    expect(walletSavings(db, 'alice', now)).toEqual({
      usd24h: 0.00042,
      usdTotal: 0.0008,
      networkSharePercent: 66.67,
      multiplier: 3, // (720+480) / (300+100)
      networkSpendUsdTotal: 0.0004,
      networkRequests: 2,
      requests: 3,
    });
    expect(walletSavings(db, 'bob', now)).toEqual({ usd24h: 0, usdTotal: 0, networkSharePercent: 0, multiplier: 1, networkSpendUsdTotal: 0, networkRequests: 0, requests: 1 });
    expect(walletSavings(db, 'nobody', now)).toMatchObject({ usd24h: 0, usdTotal: 0, networkSharePercent: 0, multiplier: 1, requests: 0 });
    expect(networkSavingsUsd24h(db, now)).toBe(0.00042);
  });
});

// ---------------- end to end: a node-served request reports and records its savings ----------------

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const calmConfig: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000, jobTimeoutMs: 5000 },
};

function sse(body: string): Array<Record<string, any>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

async function bootWithNode(config = calmConfig, extraPolicy: Record<string, string> = {}) {
  // "pricey-model" has no price entry and no priced sibling on its tag -> list price = default ($1/$3 per M)
  const nodePolicy = parseModelPolicy({
    networkModels: { 'llama-3.1-8b': 'llama3.1:8b', 'meta-llama/llama-3.1-8b-instruct': 'llama3.1:8b', 'pricey-model': 'big:70b', 'tiny-model': 'tiny:1b', ...extraPolicy },
  });
  const { app } = await testServer({ holders: { alice: 10_000 }, config, context: { policy: nodePolicy, prices } });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const reg = await app.inject({
    method: 'POST',
    url: '/nodes/register',
    payload: { nodeId: 'mac-s', wallet: 'bob', models: ['llama3.1:8b', 'big:70b', 'tiny:1b'], chip: 'M3 Max', ramGb: 64, agentVersion: '0.2.0' },
  });
  expect(reg.statusCode).toBe(200);
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  const serve = async (payload: Record<string, unknown>, usage = { promptTokens: 1000, completionTokens: 500, finishReason: 'stop' }) => {
    const client = app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload });
    const job = (await app.inject({ method: 'GET', url: `/nodes/mac-s/jobs/next?wait=2000`, headers: h })).json();
    await app.inject({ method: 'POST', url: `/nodes/mac-s/jobs/${job.jobId}/chunk`, headers: h, payload: { seq: 0, delta: 'ok' } });
    await app.inject({ method: 'POST', url: `/nodes/mac-s/jobs/${job.jobId}/done`, headers: h, payload: usage });
    return client;
  };
  const me = async () => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } })).json();
  return { app, jwt, key, serve, me };
}

// Every served request below is 1000 prompt + 500 completion tokens.
const BILLED = networkMicros(1500); // flat network price, micro-USD
const LIST_PRICEY = 1000 * prices.default.promptUsdPerM + 500 * prices.default.completionUsdPerM; // 2500
const SAVED_PRICEY = LIST_PRICEY - BILLED;
const MULTIPLIER_PRICEY = Math.round((LIST_PRICEY / BILLED) * 10) / 10;
if (BILLED <= 0 || SAVED_PRICEY <= 0) {
  throw new Error('savings tests assume the network price bills a positive amount that is below the default list price');
}

describe('network credits: gateway', () => {
  it('stream: final chunk carries mesh.listCostUsd + mesh.savedUsd; /me.savings and /stats.networkSavingsUsd24h follow', async () => {
    const { app, serve, me } = await bootWithNode();
    expect((await me()).savings).toEqual({ usd24h: 0, usdTotal: 0, networkSharePercent: 0, multiplier: 1, networkSpendUsdTotal: 0, networkRequests: 0, requests: 0 });

    const res = await serve({ model: 'pricey-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    const last = events[events.length - 1];
    // billed: 1500 tokens at the flat network price (30 micro-USD at $0.02/M). list: 1000*$1 + 500*$3 per M = 2500 micro-USD.
    expect(last.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cost: usd(BILLED) });
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: 'mac-s', listCostUsd: usd(LIST_PRICEY), savedUsd: usd(SAVED_PRICEY) });

    const row = app.ctx.db.prepare(`SELECT cost_usd_micros, list_cost_usd_micros, saved_usd_micros, upstream FROM requests_log`).get();
    expect(row).toEqual({ cost_usd_micros: BILLED, list_cost_usd_micros: LIST_PRICEY, saved_usd_micros: SAVED_PRICEY, upstream: 'node:mac-s' });

    const savings = (await me()).savings;
    expect(savings).toMatchObject({ usd24h: usd(SAVED_PRICEY), usdTotal: usd(SAVED_PRICEY), networkSharePercent: 100, networkSpendUsdTotal: usd(BILLED), networkRequests: 1, requests: 1 });
    expect(savings.multiplier).toBe(MULTIPLIER_PRICEY); // list / billed, 1 decimal

    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats.networkSavingsUsd24h).toBe(usd(SAVED_PRICEY));
    expect(stats.showSavings).toBe(true);
  });

  it('non-stream: x-mesh-saved-usd header + mesh fields; a model cheaper upstream than the network price saves nothing', async () => {
    const { app, serve, me } = await bootWithNode();
    // tiny-model lists at half the network price per token, so its list cost is below what the network bills
    const listTiny = Math.floor(1500 * (NETWORK_PRICE_PER_M / 2));
    expect(listTiny).toBeLessThan(BILLED);
    const res = await serve({ model: 'tiny-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-cost-usd']).toBe(String(usd(BILLED)));
    expect(res.headers['x-mesh-saved-usd']).toBe('0');
    expect(res.json().mesh).toMatchObject({ route: 'node', listCostUsd: usd(listTiny), savedUsd: 0 });
    expect((await me()).savings).toMatchObject({ usdTotal: 0, networkSharePercent: 100, multiplier: 1, networkRequests: 1 });
    const row = app.ctx.db.prepare(`SELECT cost_usd_micros, list_cost_usd_micros, saved_usd_micros FROM requests_log`).get();
    expect(row).toEqual({ cost_usd_micros: BILLED, list_cost_usd_micros: listTiny, saved_usd_micros: 0 });
  });

  it('upstream-served requests record list == cost and saved == 0, lowering the wallet network share', async () => {
    const { app, serve, me, key } = await bootWithNode();
    await serve({ model: 'pricey-model', messages: [{ role: 'user', content: 'hi' }] });
    // not a network model -> mock upstream (cost $0.001)
    const up = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/other', messages: [{ role: 'user', content: 'hi' }] } });
    expect(up.statusCode).toBe(200);
    expect(up.headers['x-mesh-saved-usd']).toBeUndefined();
    const rows = app.ctx.db.prepare(`SELECT upstream, cost_usd_micros, list_cost_usd_micros, saved_usd_micros FROM requests_log ORDER BY id`).all();
    expect(rows).toEqual([
      { upstream: 'node:mac-s', cost_usd_micros: BILLED, list_cost_usd_micros: LIST_PRICEY, saved_usd_micros: SAVED_PRICEY },
      { upstream: 'mock', cost_usd_micros: 1000, list_cost_usd_micros: 1000, saved_usd_micros: 0 },
    ]);
    expect((await me()).savings).toMatchObject({ usdTotal: usd(SAVED_PRICEY), networkSharePercent: 50, multiplier: MULTIPLIER_PRICEY, requests: 2, networkRequests: 1 });
  });

  it('showSavings: false hides the mesh savings fields and header but still records them', async () => {
    const quiet: TokenomicsConfig = { ...calmConfig, requestPricing: { ...calmConfig.requestPricing, showSavings: false } };
    const { app, serve, me } = await bootWithNode(quiet);
    const res = await serve({ model: 'pricey-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-saved-usd']).toBeUndefined();
    expect(res.json().mesh.listCostUsd).toBeUndefined();
    expect(res.json().mesh.savedUsd).toBeUndefined();
    expect((await me()).savings.usdTotal).toBe(usd(SAVED_PRICEY));
    expect((await app.inject({ method: 'GET', url: '/stats' })).json()).toMatchObject({ showSavings: false, networkSavingsUsd24h: usd(SAVED_PRICEY) });
  });
});
