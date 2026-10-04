import { parseModelPolicy } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { geoBlockHook, isGeoBlockedPath, requestCountry } from '../src/geoblock.js';
import { NODE_ONLINE_SEC, decideRoute } from '../src/routing.js';
import { ADMIN, memDb, testConfig, testServer } from './helpers.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('node registry', () => {
  it('heartbeat (node token) updates models/ram/chip/busy; nodes expire after 90s; public summary hides wallets and tokens', async () => {
    const { app } = await testServer();
    apps.push(app);
    const tokens: Record<string, string> = {};
    for (const [id, chip] of [['mac-a', 'M2 Ultra'], ['mac-b', 'M3 Max'], ['mac-c', 'M3 Max']] as const) {
      const r = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: id, wallet: 'w', models: ['llama3.1:8b'], chip } });
      expect(r.json()).toMatchObject({ nodeId: id, offlineAfterSec: NODE_ONLINE_SEC, heartbeatEverySec: 20 });
      tokens[id] = r.json().nodeToken;
    }
    const auth = (id: string) => ({ authorization: `Bearer ${tokens[id]}` });
    const hb = await app.inject({ method: 'POST', url: '/nodes/mac-a/heartbeat', headers: auth('mac-a'), payload: { models: ['llama3.1:8b', 'qwen2.5:7b'], ramGb: 192, chip: 'M2 Ultra', busy: true, loadAvg: 2.5 } });
    expect(hb.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/nodes/ghost/heartbeat', headers: auth('mac-a'), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-a/heartbeat', headers: auth('mac-a'), payload: { ramGb: 'lots' } })).statusCode).toBe(400);
    // another node's token is rejected; so is no token
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-a/heartbeat', headers: auth('mac-b'), payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-b/heartbeat', payload: {} })).statusCode).toBe(401);
    // re-registering an existing id without its token is refused; with it, the token rotates
    expect((await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'mac-b', wallet: 'thief', models: [] } })).statusCode).toBe(409);
    const rot = await app.inject({ method: 'POST', url: '/nodes/register', headers: auth('mac-b'), payload: { nodeId: 'mac-b', wallet: 'w', models: ['llama3.1:8b'] } });
    expect(rot.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-b/heartbeat', headers: auth('mac-b'), payload: {} })).statusCode).toBe(401);
    tokens['mac-b'] = rot.json().nodeToken;
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-b/heartbeat', headers: auth('mac-b'), payload: {} })).statusCode).toBe(200);

    let s = (await app.inject({ method: 'GET', url: '/nodes' })).json();
    expect(s).toMatchObject({ online: 3, total: 3, busy: 1, idle: 2, totalRamGb: 192, chips: { 'M2 Ultra': 1, 'M3 Max': 2 }, models: { 'llama3.1:8b': 3, 'qwen2.5:7b': 1 } });
    expect(JSON.stringify(s)).not.toContain('"wallet"');
    expect(JSON.stringify(s)).not.toMatch(/token_hash|mesh_nt_/);

    // expire mac-c: 91s without a heartbeat
    app.ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'mac-c'`).run(nowSec() - NODE_ONLINE_SEC - 1);
    s = (await app.inject({ method: 'GET', url: '/nodes' })).json();
    expect(s).toMatchObject({ online: 2, total: 3, chips: { 'M2 Ultra': 1, 'M3 Max': 1 } });
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().nodesOnline).toBe(2);
    // a heartbeat brings it back
    await app.inject({ method: 'POST', url: '/nodes/mac-c/heartbeat', headers: auth('mac-c'), payload: {} });
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json().online).toBe(3);
    // heartbeats are recorded for uptime
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM heartbeats WHERE node_id = 'mac-a'`).get() as { n: number }).n).toBeGreaterThanOrEqual(2);
  });

  it('decideRoute covers every branch and maps model names to node tags', () => {
    const db = memDb();
    const policy = parseModelPolicy({ networkModels: { 'llama-3.1-8b': 'llama3.1:8b' } });
    const t = 1_700_000_000;
    const base = { stakeTiers: testConfig.stakeTiers, privacy: testConfig.privacy };
    const cfgOn = { ...base, routing: { preferNetwork: true } };
    const net = { tier: 'network', source: 'default' } as const;
    expect(decideRoute({ db, config: { ...base, routing: { preferNetwork: false } }, policy }, 'llama-3.1-8b', net, t).reason).toBe('network_disabled');
    expect(decideRoute({ db, config: cfgOn, policy }, 'openai/gpt-4o', net, t).reason).toBe('not_network_model');
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t).reason).toBe('no_online_node');
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES ('n1','w','','["llama3.1:8b"]',?,?)`).run(t, t - 100);
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t).reason).toBe('no_online_node'); // stale
    db.prepare(`UPDATE nodes SET last_seen = ?`).run(t - 10);
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t)).toMatchObject({ target: 'node', tag: 'llama3.1:8b', candidates: ['n1'], reason: 'node', privacy: 'network', servedBy: 'network node' });
    // the raw tag is accepted as a model name too
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama3.1:8b', net, t).target).toBe('node');
    // every node at capacity: queue behind it (bounded wait), unless queueing is off or the depth cap is reached
    db.prepare(`UPDATE nodes SET busy = 1`).run();
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t)).toMatchObject({ target: 'node', reason: 'queued', candidates: ['n1'] });
    expect(decideRoute({ db, config: { ...base, routing: { preferNetwork: true, queueWaitMs: 0 } }, policy }, 'llama-3.1-8b', net, t).reason).toBe('no_online_node');
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO jobs (job_id, model, tag, wallet, status, payload, max_tokens, deadline_ms, created_at, created_ms) VALUES (?, 'm', 'llama3.1:8b', 'w', 'queued', '{}', 10, ?, ?, ?)`).run(`q${i}`, t * 1000 + 60_000, t, t * 1000);
    }
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t)).toMatchObject({ target: 'openrouter', reason: 'queue_full' });
    // a second node doubles the allowed depth
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen, busy) VALUES ('n2','w','','["llama3.1:8b"]',?,?,1)`).run(t, t - 10);
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t).reason).toBe('queued');
    // maxParallel > running: capacity again
    db.prepare(`UPDATE nodes SET max_parallel = 2 WHERE node_id = 'n2'`).run();
    expect(decideRoute({ db, config: cfgOn, policy }, 'llama-3.1-8b', net, t)).toMatchObject({ reason: 'node', candidates: ['n2'] });
  });
});

describe('geo-block', () => {
  it('helpers', () => {
    expect(requestCountry({ 'cf-ipcountry': 'us' })).toBe('US');
    expect(requestCountry({ 'x-country': 'GB' })).toBe('GB');
    expect(requestCountry({ 'cf-ipcountry': 'XX' })).toBeNull();
    expect(requestCountry({})).toBeNull();
    expect(isGeoBlockedPath('/v1/chat/completions')).toBe(true);
    expect(isGeoBlockedPath('/auth/nonce?x=1')).toBe(true);
    expect(isGeoBlockedPath('/v1')).toBe(true);
    expect(isGeoBlockedPath('/v1beta')).toBe(false);
    expect(isGeoBlockedPath('/stats')).toBe(false);
    expect(typeof geoBlockHook({ enforce: true, blocked: ['US'] })).toBe('function');
  });

  it('returns 451 for /v1 and /auth from blocked countries when enforced; /stats stays open', async () => {
    const { app } = await testServer({ env: { GEO_BLOCK_ENFORCE: true } });
    apps.push(app);
    expect(testConfig.geoBlock).toContain('US');
    const v1 = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { 'cf-ipcountry': 'US' }, payload: {} });
    expect(v1.statusCode).toBe(451);
    expect(v1.json().error).toMatchObject({ code: 'region_blocked', type: 'permission_error' });
    expect(v1.json().error.message).toContain('US');
    const auth = await app.inject({ method: 'POST', url: '/auth/nonce', headers: { 'x-country': 'gb' }, payload: { wallet: 'a' } });
    expect(auth.statusCode).toBe(451);
    expect(auth.json()).toMatchObject({ error: 'region_blocked', country: 'GB' });
    const models = await app.inject({ method: 'GET', url: '/v1/models', headers: { 'cf-ipcountry': 'AE' } });
    expect(models.statusCode).toBe(451);

    const ok = await app.inject({ method: 'POST', url: '/auth/nonce', headers: { 'cf-ipcountry': 'DE' }, payload: { wallet: 'a' } });
    expect(ok.statusCode).toBe(200);
    const noHeader = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'a' } });
    expect(noHeader.statusCode).toBe(200);
    const stats = await app.inject({ method: 'GET', url: '/stats', headers: { 'cf-ipcountry': 'US' } });
    expect(stats.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).json().geoBlock).toEqual(testConfig.geoBlock);
  });

  it('is skipped in dev (not enforced)', async () => {
    const { app } = await testServer({ env: { GEO_BLOCK_ENFORCE: false } });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/auth/nonce', headers: { 'cf-ipcountry': 'US' }, payload: { wallet: 'a' } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).json().geoBlock).toBe('off');
  });
});

describe('ops', () => {
  it('/health reports db, last epoch and upstream mode', async () => {
    const { app } = await testServer();
    apps.push(app);
    let h = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(h).toMatchObject({ ok: true, db: 'ok', upstream: 'mock', upstreamMode: 'mock (offline)', lastEpoch: null });
    await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: 3600 } });
    h = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(h.lastEpoch).toMatchObject({ epochStart: 3600, status: 'empty' });
    expect(h.lastEpoch.ageSec).toBeGreaterThanOrEqual(0);
  });

  it('structured errors: 404, invalid JSON, 5xx (recorded for admin), OpenAI shape under /v1', async () => {
    const { app } = await testServer();
    apps.push(app);
    app.get('/boom', async () => {
      throw new Error('kaboom');
    });
    app.get('/v1/boom', async () => {
      throw new Error('kaboom-v1');
    });

    const nf = await app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: 'not_found', statusCode: 404 });
    const nfV1 = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(nfV1.json().error).toMatchObject({ code: 'not_found', type: 'invalid_request_error' });

    const badJson = await app.inject({ method: 'POST', url: '/keys', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, payload: '{not json' });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: 'bad_request', statusCode: 400 });
    expect(typeof badJson.json().requestId).toBe('string');

    const boom = await app.inject({ method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toMatchObject({ error: 'internal_error', statusCode: 500 });
    expect(boom.json().message).not.toContain('kaboom');
    const boomV1 = await app.inject({ method: 'GET', url: '/v1/boom' });
    expect(boomV1.statusCode).toBe(500);
    expect(boomV1.json().error).toMatchObject({ type: 'server_error', code: 'internal_error' });

    const over = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json();
    expect(over.recentErrors.map((e: { message: string }) => e.message)).toEqual(['kaboom-v1', 'kaboom']);
  });
});
