import { MockAdapter } from '@mesh/chain-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLoginMessage } from '../src/auth.js';
import { ADMIN, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];

describe('end to end: fees -> epoch -> key -> completion -> balance', () => {
  let app: App;
  let adapter: MockAdapter;
  const EPOCH = 1_700_000_000 - (1_700_000_000 % 3600);

  beforeAll(async () => {
    ({ app, adapter } = await testServer({ holders: { alice: 75_000, bob: 25_000, dust: 10 } }));
  });
  afterAll(async () => {
    await app.close();
  });

  let jwt: string;
  let apiKey: string;
  let keyId: number;
  let balanceBefore: number;

  it('health + stats are public', async () => {
    const h = await app.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json().upstream).toBe('mock');
    const s = await app.inject({ method: 'GET', url: '/stats' });
    expect(s.statusCode).toBe(200);
    expect(s.json().totalFeesUsd).toBe(0);
  });

  it('admin endpoints reject without token', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/fake-fees', payload: { amountUsd: 1 } });
    expect(r.statusCode).toBe(401);
  });

  it('fake fees then run epoch distributes credits', async () => {
    const f = await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: ADMIN, payload: { amountUsd: 100 } });
    expect(f.statusCode).toBe(200);
    expect(f.json().pendingFeesUsd).toBe(100);

    const e = await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: EPOCH } });
    expect(e.statusCode).toBe(200);
    const body = e.json();
    expect(body.status).toBe('complete');
    expect(body.feesUsd).toBe(100);
    expect(body.holderPoolUsd).toBe(50);
    expect(body.eligibleHolders).toBe(2);
    const alice = body.distributed.find((d: { wallet: string }) => d.wallet === 'alice');
    expect(alice.usd).toBe(37.5);

    const again = await app.inject({ method: 'POST', url: '/admin/run-epoch', headers: ADMIN, payload: { epochStart: EPOCH } });
    expect(again.json().status).toBe('skipped');
    expect(adapter.pendingFees()).toBe(0);
  });

  it('wallet login via real nonce + mock signature', async () => {
    const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'alice' } });
    expect(n.statusCode).toBe(200);
    const { nonce, message, domain } = n.json();
    expect(domain).toBe('test.mesh');
    expect(message).toContain('test.mesh wants you to sign in with your wallet:\nalice');
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain('Issued At: ');
    expect(parseLoginMessage(message)).toMatchObject({ domain: 'test.mesh', wallet: 'alice', nonce });

    const bad = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: 'wrong' } });
    expect(bad.statusCode).toBe(401);

    // nonce consumed -> need a new one
    const n2 = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'alice' } });
    const sig = MockAdapter.sign('alice', n2.json().message);
    const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: sig } });
    expect(ok.statusCode).toBe(200);
    jwt = ok.json().token;
    expect(typeof jwt).toBe('string');
  });

  it('/me shows the distributed balance', async () => {
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().balance.usd).toBe(37.5);
    expect(me.json().ledger[0].kind).toBe('distribution');
    balanceBefore = me.json().balance.usdMicros;

    const anon = await app.inject({ method: 'GET', url: '/me' });
    expect(anon.statusCode).toBe(401);
  });

  it('creates an API key (returned once, masked afterwards)', async () => {
    const k = await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` }, payload: { label: 'test' } });
    expect(k.statusCode).toBe(201);
    apiKey = k.json().key;
    keyId = k.json().id;
    expect(apiKey.startsWith('mesh_sk_')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/keys', headers: { authorization: `Bearer ${jwt}` } });
    expect(list.json().keys[0].masked).not.toContain(apiKey.slice(14));
    expect(list.json().keys[0].masked.startsWith(apiKey.slice(0, 14))).toBe(true);
  });

  it('chat completion (non-stream) against mock upstream debits 0.001 USD', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toContain('Mesh mock upstream');
    expect(body.usage.cost).toBe(0.001);
    expect(r.headers['x-mesh-cost-usd']).toBe('0.001');

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } });
    expect(me.json().balance.usdMicros).toBe(balanceBefore - 1_000);
    expect(me.json().ledger[0].kind).toBe('usage');
    expect(me.json().ledger[0].deltaUsdMicros).toBe(-1_000);
  });

  it('chat completion (stream) passes SSE through and debits again', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'mesh/mock', stream: true, messages: [{ role: 'user', content: 'stream please' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const chunks = r.body.split('\n\n').filter((l) => l.startsWith('data:'));
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.at(-1)).toBe('data: [DONE]');
    const last = JSON.parse(chunks.at(-2)!.slice(5));
    expect(last.usage.cost).toBe(0.001);

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } });
    expect(me.json().balance.usdMicros).toBe(balanceBefore - 2_000);
  });

  it('/v1/models is proxied; bad key is OpenAI-shaped 401; zero balance is 402', async () => {
    const m = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${apiKey}` } });
    expect(m.statusCode).toBe(200);
    expect(m.json().data[0].id).toBe('mesh/mock');

    const bad = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer mesh_sk_nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_api_key');

    // a wallet with no credits
    const login = await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'poor' } });
    const poorJwt = login.json().token;
    const k = await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${poorJwt}` } });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${k.json().key}` },
      payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.type).toBe('insufficient_quota');

    // starter credit fixes it
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'poor', amountUsd: 0.05 } });
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${k.json().key}` },
      payload: { model: 'mesh/mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('revoking the key disables it; stats reflect activity', async () => {
    const d = await app.inject({ method: 'DELETE', url: `/keys/${keyId}`, headers: { authorization: `Bearer ${jwt}` } });
    expect(d.statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${apiKey}` } });
    expect(r.statusCode).toBe(401);

    const s = await app.inject({ method: 'GET', url: '/stats' });
    const stats = s.json();
    expect(stats.totalFeesUsd).toBe(100);
    expect(stats.creditsDistributedUsd).toBe(50);
    expect(stats.holdersEligibleLastEpoch).toBe(2);
    expect(stats.requestsLast24h).toBe(3);
    expect(stats.lastEpoch.epochStart).toBe(EPOCH);
  });

  it('nodes register (token issued), heartbeat with the token, show up in the public summary', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/nodes/register',
      payload: { nodeId: 'mac-1', wallet: 'alice', models: ['llama3.1:8b'], chip: 'M3 Max', ramGb: 64, agentVersion: '0.2.0' },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().nodeToken as string;
    expect(token.startsWith('mesh_nt_')).toBe(true);
    const hb = await app.inject({ method: 'POST', url: '/nodes/mac-1/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: { models: ['llama3.1:8b'], busy: false } });
    expect(hb.statusCode).toBe(200);
    const noAuth = await app.inject({ method: 'POST', url: '/nodes/mac-1/heartbeat', payload: {} });
    expect(noAuth.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/nodes/ghost/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(unknown.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/nodes' });
    expect(list.json()).toMatchObject({ online: 1, total: 1, models: { 'llama3.1:8b': 1 }, jobs24h: 0, servedByNetwork24h: 0 });
  });
});
