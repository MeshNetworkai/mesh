import { catalogueEntries, loadModelPrices, meshPricePerM, parseModelPolicy, parseTokenomics, upstreamBilledMicros, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOpenRouterPrices, formatPrices, perMillion } from '../../../scripts/refresh-model-prices.mjs';
import { catalogueModels, guestModelAllowed } from '../src/catalogue.js';
import { MOCK_COST_USD } from '../src/upstream.js';
import { MockAdapter } from '@mesh/chain-adapter';
import { createContext } from '../src/server.js';
import { ADMIN, TEST_ENV, memDb, testConfig, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const CURATED = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.1',
  'anthropic/claude-3.5-haiku',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-4.1',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat-v3.1',
  'deepseek/deepseek-r1',
  'x-ai/grok-4',
  'moonshotai/kimi-k2',
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'qwen/qwen-2.5-72b-instruct',
  'mistralai/mistral-large',
];

async function bootWithKey(config: TokenomicsConfig = testConfig) {
  const { app } = await testServer({ holders: { alice: 10_000 }, config });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const balance = () => (app.ctx.db.prepare(`SELECT COALESCE(SUM(delta_usd_micros),0) AS v FROM credits_ledger WHERE wallet = 'alice'`).get() as { v: number }).v;
  return { app, key, balance };
}

describe('model catalogue: config', () => {
  it('config/model-prices.json carries every curated id with tier, vendor and displayName', () => {
    const prices = loadModelPrices();
    const entries = catalogueEntries(prices);
    const ids = entries.map((e) => e.id);
    // every curated model is listed, except an upstream id that is also a network alias's sibling (one row per tag)
    for (const id of CURATED.filter((c) => c !== 'meta-llama/llama-3.1-8b-instruct')) expect(ids).toContain(id);
    for (const e of entries) {
      expect(['frontier', 'fast', 'open']).toContain(e.tier);
      expect(e.vendor.length).toBeGreaterThan(0);
      expect(e.displayName.length).toBeGreaterThan(0);
      expect(e.promptUsdPerM).toBeGreaterThanOrEqual(0);
    }
    // price-only entries are billing fallbacks, not catalogue rows
    expect(ids).not.toContain('mesh/mock');
    expect(prices.models['anthropic/claude-sonnet-4.5']).toMatchObject({ promptUsdPerM: 3, completionUsdPerM: 15, tier: 'frontier' });
  });

  it('requestPricing: markup and discount are exclusive; legacy markupBps folds into upstreamMarkupBps; defaults ship at 0 / 0.02', () => {
    expect(testConfig.requestPricing).toMatchObject({ upstreamMarkupBps: 0, upstreamDiscountBps: 0, networkPricePerMTokens: 0.02 });
    const legacy = parseTokenomics({ ...testConfig, requestPricing: { mode: 'passthrough', markupBps: 500 } });
    expect(legacy.requestPricing.upstreamMarkupBps).toBe(500);
    expect(() => parseTokenomics({ ...testConfig, requestPricing: { mode: 'passthrough', upstreamMarkupBps: 500, upstreamDiscountBps: 1000 } })).toThrow(/exclusive/);
    const disc = parseTokenomics({ ...testConfig, requestPricing: { mode: 'passthrough', upstreamDiscountBps: 2000 } });
    expect(disc.requestPricing.upstreamDiscountBps).toBe(2000);
  });

  it('upstreamBilledMicros / meshPricePerM apply list × (1 − discount) or × (1 + markup)', () => {
    expect(upstreamBilledMicros(10_000, { upstreamMarkupBps: 0, upstreamDiscountBps: 0 })).toBe(10_000);
    expect(upstreamBilledMicros(10_000, { upstreamMarkupBps: 0, upstreamDiscountBps: 2000 })).toBe(8_000);
    expect(upstreamBilledMicros(10_000, { upstreamMarkupBps: 1000, upstreamDiscountBps: 0 })).toBe(11_000);
    expect(upstreamBilledMicros(3, { upstreamMarkupBps: 0, upstreamDiscountBps: 2000 })).toBe(3); // floor(0.6) = 0 off: never under-billed by rounding
    expect(meshPricePerM(15, { upstreamMarkupBps: 0, upstreamDiscountBps: 2500 })).toBe(11.25);
    expect(meshPricePerM(15, { upstreamMarkupBps: 1000, upstreamDiscountBps: 0 })).toBe(16.5);
  });

  it('guest.allowedTiers defaults to open + fast; usageShare ships disabled with 3000/7000 and validates the split', () => {
    expect(testConfig.guest.allowedTiers).toEqual(['open', 'fast']);
    expect(testConfig.usageShare).toEqual({ enabled: false, holderBps: 3000, treasuryBps: 7000, sources: { network: true, upstream: true, marketplaceFee: true } });
    expect(() => parseTokenomics({ ...testConfig, usageShare: { enabled: true, holderBps: 3000, treasuryBps: 6000 } })).toThrow(/10000/);
    const minimal = parseTokenomics({ ...testConfig, usageShare: undefined });
    expect(minimal.usageShare.enabled).toBe(false);
  });
});

describe('GET /v1/models', () => {
  it('returns the catalogue in OpenAI shape with mesh fields; network models first; works without a key', async () => {
    const { app, key } = await bootWithKey();
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBe('list');
    expect(body.pricing).toEqual({ networkPricePerMTokens: 0.02, upstreamDiscountBps: 0, upstreamMarkupBps: 0, guestTiers: ['open', 'fast'] });
    const ids: string[] = body.data.map((m: { id: string }) => m.id);
    // every curated model is listed, except an upstream id that is also a network alias's sibling (one row per tag)
    for (const id of CURATED.filter((c) => c !== 'meta-llama/llama-3.1-8b-instruct')) expect(ids).toContain(id);
    expect(ids).toContain('llama-3.1-8b');
    expect(ids).toContain('mesh/mock');
    // network models (policy order) come first, then frontier, fast, open
    const firstUpstream = body.data.findIndex((m: { served: string }) => m.served === 'upstream');
    expect(body.data.slice(0, firstUpstream).every((m: { served: string }) => m.served !== 'upstream')).toBe(true);
    const tiers = body.data.slice(firstUpstream).map((m: { tier: string }) => m.tier);
    expect(tiers.indexOf('fast')).toBeGreaterThan(tiers.lastIndexOf('frontier'));
    expect(tiers.indexOf('open')).toBeGreaterThan(tiers.lastIndexOf('fast'));

    const llama = body.data.find((m: { id: string }) => m.id === 'llama-3.1-8b');
    expect(llama).toMatchObject({
      object: 'model',
      owned_by: 'mesh',
      displayName: 'Llama 3.1 8B',
      vendor: 'Meta',
      tier: 'open',
      served: 'both',
      listPrice: { promptUsdPerM: 0.05, completionUsdPerM: 0.08 },
      meshPrice: { promptUsdPerM: 0.02, completionUsdPerM: 0.02 },
      privacy: 'network',
      online: 0,
      guestAllowed: true,
      mesh_network: true,
    });
    const mock = body.data.find((m: { id: string }) => m.id === 'mesh/mock');
    expect(mock).toMatchObject({ served: 'network', privacy: 'network', guestAllowed: true });
    const sonnet = body.data.find((m: { id: string }) => m.id === 'anthropic/claude-sonnet-4.5');
    expect(sonnet).toMatchObject({
      object: 'model',
      owned_by: 'anthropic',
      name: 'Claude Sonnet 4.5',
      vendor: 'Anthropic',
      tier: 'frontier',
      served: 'upstream',
      listPrice: { promptUsdPerM: 3, completionUsdPerM: 15 },
      meshPrice: { promptUsdPerM: 3, completionUsdPerM: 15 },
      privacy: 'upstream_zdr',
      online: 0,
      guestAllowed: false,
      mesh_network: false,
    });
    const haiku = body.data.find((m: { id: string }) => m.id === 'anthropic/claude-3.5-haiku');
    expect(haiku).toMatchObject({ tier: 'fast', guestAllowed: true });

    // no key at all: same catalogue (the web picker and guest chat read it); a bad key is still a 401
    const anon = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().data.length).toBe(body.data.length);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer mesh_sk_nope' } })).statusCode).toBe(401);
  });

  it('meshPrice reflects the upstream discount; `online` counts nodes advertising the tag; ?guest=1 narrows to guest tiers', async () => {
    const cfg: TokenomicsConfig = { ...testConfig, requestPricing: { ...testConfig.requestPricing, upstreamDiscountBps: 2000 } };
    const { app } = await bootWithKey(cfg);
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'mac-1', wallet: 'bob', models: ['llama3.1:8b'], chip: 'M3', ramGb: 32, agentVersion: '0.2.0' } });
    expect(reg.statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = r.json();
    expect(body.pricing.upstreamDiscountBps).toBe(2000);
    const opus = body.data.find((m: { id: string }) => m.id === 'anthropic/claude-opus-4.1');
    expect(opus.listPrice).toEqual({ promptUsdPerM: 15, completionUsdPerM: 75 });
    expect(opus.meshPrice).toEqual({ promptUsdPerM: 12, completionUsdPerM: 60 });
    expect(body.data.find((m: { id: string }) => m.id === 'llama-3.1-8b').online).toBe(1);
    // one row per Ollama tag: the upstream-style sibling is accepted as a model name but not listed twice
    expect(body.data.find((m: { id: string }) => m.id === 'meta-llama/llama-3.1-8b-instruct')).toBeUndefined();
    expect(body.data.filter((m: { mesh_network: boolean }) => m.mesh_network).map((m: { id: string }) => m.id)).toEqual(['llama-3.1-8b', 'qwen-2.5-7b', 'mesh/mock']);
    expect(body.data.find((m: { id: string }) => m.id === 'qwen-2.5-7b').online).toBe(0);

    const g = await app.inject({ method: 'GET', url: '/v1/models?guest=1' });
    const gids: string[] = g.json().data.map((m: { id: string }) => m.id);
    expect(gids).toContain('llama-3.1-8b');
    expect(gids).toContain('anthropic/claude-3.5-haiku');
    expect(gids).toContain('deepseek/deepseek-chat-v3.1');
    expect(gids).not.toContain('anthropic/claude-opus-4.1');
    expect(gids).not.toContain('openai/gpt-5');
    expect(g.json().data.every((m: { guestAllowed: boolean }) => m.guestAllowed)).toBe(true);
  });

  it('guestModelAllowed follows guest.allowedTiers; POST /v1/guest/chat refuses a frontier model with 403', async () => {
    const policy = parseModelPolicy({ networkModels: { 'llama-3.1-8b': 'llama3.1:8b' } });
    const prices = loadModelPrices();
    const ctx = { config: testConfig, prices, policy };
    expect(guestModelAllowed(ctx, 'llama-3.1-8b')).toBe(true);
    expect(guestModelAllowed(ctx, 'openai/gpt-5-mini')).toBe(true);
    expect(guestModelAllowed(ctx, 'openai/gpt-5')).toBe(false);
    expect(guestModelAllowed(ctx, 'unknown/model')).toBe(false);
    const frontierOk = { ...testConfig, guest: { ...testConfig.guest, allowedTiers: ['frontier' as const] } };
    expect(guestModelAllowed({ ...ctx, config: frontierOk }, 'openai/gpt-5')).toBe(true);
    expect(guestModelAllowed({ ...ctx, config: frontierOk }, 'openai/gpt-5-mini')).toBe(false);

    const { app } = await testServer({ config: { ...testConfig, guest: { ...testConfig.guest, enabled: true } } });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/v1/guest/chat', payload: { model: 'anthropic/claude-opus-4.1', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('model_not_allowed_for_guests');
    // the refused message did not eat a free message
    expect((await app.inject({ method: 'GET', url: '/v1/guest/quota' })).json().remaining).toBe(testConfig.guest.messagesPerDay);
  });
});

describe('billing with upstreamDiscountBps', () => {
  it('an upstream-served request bills list × (1 − discount); requests_log keeps list and saved', async () => {
    const cfg: TokenomicsConfig = { ...testConfig, requestPricing: { ...testConfig.requestPricing, upstreamDiscountBps: 2500 } };
    const { app, key, balance } = await bootWithKey(cfg);
    const before = balance();
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(200);
    const list = Math.round(MOCK_COST_USD * 1e6); // 1000 micro-USD: the mock upstream reports usage.cost
    const billed = list - Math.floor((list * 2500) / 10_000); // 750
    expect(billed).toBe(750);
    expect(r.headers['x-mesh-cost-usd']).toBe(String(billed / 1e6));
    expect(r.json().usage.cost).toBe(MOCK_COST_USD); // the upstream's own usage block is passed through untouched
    expect(balance()).toBe(before - billed);
    const row = app.ctx.db.prepare(`SELECT cost_usd_micros, list_cost_usd_micros, saved_usd_micros FROM requests_log ORDER BY id DESC LIMIT 1`).get() as Record<string, number>;
    expect(row).toEqual({ cost_usd_micros: billed, list_cost_usd_micros: list, saved_usd_micros: list - billed });
  });

  it('a markup bills list × (1 + markup); with neither, list', async () => {
    const up: TokenomicsConfig = { ...testConfig, requestPricing: { ...testConfig.requestPricing, upstreamMarkupBps: 1000 } };
    const a = await bootWithKey(up);
    const b0 = a.balance();
    await a.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${a.key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(a.balance()).toBe(b0 - 1100);
    const flat = await bootWithKey();
    const f0 = flat.balance();
    await flat.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${flat.key}` }, payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] } });
    expect(flat.balance()).toBe(f0 - 1000);
  });
});

describe('scripts/refresh-model-prices.mjs', () => {
  const fixture = {
    data: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', pricing: { prompt: '0.000003', completion: '0.000015', request: '0' } },
      { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
      { id: 'x-ai/grok-4', name: 'xAI: Grok 4', pricing: { prompt: '0.000003', completion: '0.000016' } },
      { id: 'meta-llama/llama-3.1-8b-instruct', pricing: { prompt: '0.00000002', completion: '0.00000003' } },
      { id: 'some/other-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'broken/model', pricing: { prompt: 'n/a', completion: '0.1' } },
    ],
  };

  it('perMillion converts OpenRouter per-token strings to USD per 1M', () => {
    expect(perMillion('0.000003')).toBe(3);
    expect(perMillion('0.00000125')).toBe(1.25);
    expect(perMillion('0.00000002')).toBe(0.02);
    expect(perMillion('nope')).toBeNull();
    expect(perMillion('-1')).toBeNull();
  });

  it('applyOpenRouterPrices rewrites only curated ids present in the payload and preserves everything else', () => {
    const current = loadModelPrices();
    const { prices, changed, matched } = applyOpenRouterPrices(current, fixture, '2026-10-05');
    expect(matched).toBe(4);
    expect(prices.models['x-ai/grok-4']).toMatchObject({ promptUsdPerM: 3, completionUsdPerM: 16, tier: 'frontier', vendor: 'xAI', displayName: 'Grok 4' });
    expect(prices.models['meta-llama/llama-3.1-8b-instruct']).toMatchObject({ promptUsdPerM: 0.02, completionUsdPerM: 0.03, tier: 'open' });
    expect(prices.models['anthropic/claude-sonnet-4.5']).toMatchObject({ promptUsdPerM: 3, completionUsdPerM: 15 });
    expect(changed.map((c: { id: string }) => c.id).sort()).toEqual(['meta-llama/llama-3.1-8b-instruct', 'x-ai/grok-4']);
    // untouched: not in the payload, not curated, the default and the comment
    expect(prices.models['anthropic/claude-opus-4.1']).toEqual(current.models['anthropic/claude-opus-4.1']);
    expect(prices.models['mesh/mock']).toEqual(current.models['mesh/mock']);
    expect(prices.models['some/other-model']).toBeUndefined();
    expect(prices.default).toEqual(current.default);
    expect(prices._comment).toBe(current._comment);
    expect(prices._refreshedAt).toBe('2026-10-05');
    expect(Object.keys(prices.models)).toEqual(Object.keys(current.models));
    // inputs untouched
    expect(current.models['x-ai/grok-4'].completionUsdPerM).toBe(15);
    // the rewritten file is valid JSON that still passes the schema
    const text = formatPrices(prices);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(catalogueEntries(JSON.parse(text)).length).toBe(catalogueEntries(current).length);
  });

  it('refuses a payload without data[] or without any curated id (the caller exits 1 and leaves the file alone)', () => {
    const current = loadModelPrices();
    expect(() => applyOpenRouterPrices(current, { error: 'down' }, '2026-10-05')).toThrow(/data/);
    expect(() => applyOpenRouterPrices(current, { data: [{ id: 'some/other-model', pricing: { prompt: '0.1', completion: '0.1' } }] }, '2026-10-05')).toThrow(/none of the curated/);
  });
  it('hides the mock model in production and lists one row per Ollama tag', () => {
    const ctx = createContext({ env: TEST_ENV as never, context: { db: memDb(), adapter: new MockAdapter({ chain: 'solana' }), config: testConfig } });
    const dev = catalogueModels(ctx).map((m) => m.id);
    expect(dev).toContain('mesh/mock');
    expect(dev.filter((id) => id === 'llama-3.1-8b' || id === 'meta-llama/llama-3.1-8b-instruct')).toEqual(['llama-3.1-8b']);
    const prod = catalogueModels({ ...ctx, env: { NODE_ENV: 'production' } }).map((m) => m.id);
    expect(prod).not.toContain('mesh/mock');
    expect(prod).toContain('llama-3.1-8b');
  });
});
