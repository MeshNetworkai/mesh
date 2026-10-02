import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];

describe('API key lifecycle: name, spend limit, usage', () => {
  let app: App;
  let jwt: string;
  let otherJwt: string;
  let keyId: number;
  let key: string;
  const H = () => ({ authorization: `Bearer ${jwt}` });

  beforeAll(async () => {
    ({ app } = await testServer());
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 5 } });
    jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    otherJwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'mallory' } })).json().token;
  });
  afterAll(async () => app.close());

  it('creates a named key with a spend limit', async () => {
    const r = await app.inject({ method: 'POST', url: '/keys', headers: H(), payload: { name: 'cursor', spendLimitUsd: 0.0025 } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'cursor', spendLimitUsd: 0.0025 });
    keyId = r.json().id;
    key = r.json().key;
    const list = await app.inject({ method: 'GET', url: '/keys', headers: H() });
    expect(list.json().keys[0]).toMatchObject({ id: keyId, name: 'cursor', spendLimitUsd: 0.0025, spentUsd: 0 });
    // legacy label still works and maps to name
    const legacy = await app.inject({ method: 'POST', url: '/keys', headers: H(), payload: { label: 'old-client' } });
    expect(legacy.json()).toMatchObject({ name: 'old-client', spendLimitUsd: null });
  });

  it('enforces the per-key spend limit on /v1 (wallet balance untouched by the block)', async () => {
    const chat = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] },
      });
    // mock costs $0.001 each; limit $0.0025 -> 3rd request passes (spent 0.002 < 0.0025), 4th blocked
    for (let i = 0; i < 3; i++) expect((await chat()).statusCode).toBe(200);
    const blocked = await chat();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ type: 'insufficient_quota', code: 'key_spend_limit_reached' });
    expect(blocked.json().error.message).toContain(`PATCH /keys/${keyId}`);

    const me = await app.inject({ method: 'GET', url: '/me', headers: H() });
    expect(me.json().balance.usd).toBeCloseTo(5 - 0.003, 9);
    expect(me.json().apiKeys.find((k: { id: number }) => k.id === keyId).spentUsd).toBeCloseTo(0.003, 9);
  });

  it('PATCH /keys/:id raises the limit, renames, clears the limit; other wallets get 404', async () => {
    const p = await app.inject({ method: 'PATCH', url: `/keys/${keyId}`, headers: H(), payload: { spendLimitUsd: 1, name: 'cursor-2' } });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ id: keyId, name: 'cursor-2', spendLimitUsd: 1 });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(ok.statusCode).toBe(200);

    const cleared = await app.inject({ method: 'PATCH', url: `/keys/${keyId}`, headers: H(), payload: { spendLimitUsd: null } });
    expect(cleared.json().spendLimitUsd).toBeNull();

    const empty = await app.inject({ method: 'PATCH', url: `/keys/${keyId}`, headers: H(), payload: {} });
    expect(empty.statusCode).toBe(400);
    const foreign = await app.inject({ method: 'PATCH', url: `/keys/${keyId}`, headers: { authorization: `Bearer ${otherJwt}` }, payload: { name: 'pwned' } });
    expect(foreign.statusCode).toBe(404);
  });

  it('GET /keys/:id/usage reports 24h/7d totals, request count and top models', async () => {
    const u = await app.inject({ method: 'GET', url: `/keys/${keyId}/usage`, headers: H() });
    expect(u.statusCode).toBe(200);
    const body = u.json();
    expect(body.key.id).toBe(keyId);
    expect(body.requestCount).toBe(4);
    expect(body.last24h).toMatchObject({ requests: 4, spendUsd: 0.004 });
    expect(body.last7d.requests).toBe(4);
    expect(body.last24h.promptTokens).toBeGreaterThan(0);
    expect(body.topModels).toEqual([{ model: 'mesh/mock', requests: 4, spendUsd: 0.004 }]);

    const foreign = await app.inject({ method: 'GET', url: `/keys/${keyId}/usage`, headers: { authorization: `Bearer ${otherJwt}` } });
    expect(foreign.statusCode).toBe(404);
  });
});
