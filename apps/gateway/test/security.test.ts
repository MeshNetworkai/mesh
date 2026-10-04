import { MockAdapter } from '@mesh/chain-adapter';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertMonitor, localDayHour, telegramSender, type AlertSender } from '../src/alerts.js';
import { parseLoginMessage, registerMessage, safeEqual, signSession, verifySession } from '../src/auth.js';
import { nowSec } from '../src/db.js';
import { corsOrigin, jwtSecrets, loadEnv, productionProblems } from '../src/env.js';
import { JobBroker } from '../src/network.js';
import { createContext } from '../src/server.js';
import { ADMIN, TEST_ENV, memDb, testConfig, testServer } from './helpers.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

// ---------------------------------------------------------------- secrets & compares

describe('secrets', () => {
  it('safeEqual is constant-shape and exact', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('admin token: wrong token 401, right token 200, bearer form accepted', async () => {
    const { app } = await testServer();
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { 'x-admin-token': 'test-admiN' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { 'x-admin-token': 'test-admin-longer' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/overview' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { authorization: 'Bearer test-admin' } })).statusCode).toBe(200);
  });

  it('JWT rotation: tokens signed with JWT_SECRET_PREVIOUS still verify; unrelated secrets do not', async () => {
    const oldSecret = 'old-secret-old-secret-old-secret';
    const newSecret = 'new-secret-new-secret-new-secret';
    const tok = await signSession(oldSecret, 'alice', 'solana');
    expect(await verifySession(newSecret, tok)).toBeNull();
    expect((await verifySession([newSecret, oldSecret], tok))?.wallet).toBe('alice');
    expect(jwtSecrets({ JWT_SECRET: newSecret, JWT_SECRET_PREVIOUS: oldSecret })).toEqual([newSecret, oldSecret]);
    expect(jwtSecrets({ JWT_SECRET: newSecret, JWT_SECRET_PREVIOUS: undefined })).toEqual([newSecret]);

    const { app } = await testServer({ env: { JWT_SECRET: newSecret, JWT_SECRET_PREVIOUS: oldSecret } });
    apps.push(app);
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${tok}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().wallet).toBe('alice');
    // refresh re-signs with the current secret
    const fresh = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { authorization: `Bearer ${tok}` } });
    expect(fresh.statusCode).toBe(200);
    expect((await verifySession(newSecret, fresh.json().token))?.wallet).toBe('alice');
  });

  it('rejects a forged JWT (alg none / tampered payload / wrong issuer)', async () => {
    const secret = 'test-secret-test-secret-test-secret';
    const good = await signSession(secret, 'alice', 'solana');
    const [h, p, sig] = good.split('.');
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(await verifySession(secret, `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`)).toBeNull();
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    expect(await verifySession(secret, `${h}.${b64({ ...payload, sub: 'mallory' })}.${sig}`)).toBeNull();
    expect(await verifySession(secret, `${h}.${b64({ ...payload, iss: 'other' })}.${sig}`)).toBeNull();
  });

  it('production boot refuses default secrets, localhost AUTH_DOMAIN and CORS *', () => {
    const env = loadEnv({ NODE_ENV: 'production', CORS_ORIGINS: '*' });
    const problems = productionProblems(env);
    expect(problems.join('\n')).toMatch(/JWT_SECRET/);
    expect(problems.join('\n')).toMatch(/ADMIN_TOKEN/);
    expect(problems.join('\n')).toMatch(/AUTH_DOMAIN/);
    expect(problems.join('\n')).toMatch(/CORS_ORIGINS/);
    expect(() => createContext({ env: { ...TEST_ENV, NODE_ENV: 'production' } as never, context: { db: memDb(), adapter: new MockAdapter({ chain: 'solana' }), config: testConfig } })).toThrow(/refusing to start/);
    const ok = loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(40),
      ADMIN_TOKEN: 'y'.repeat(30),
      KEY_PEPPER: 'p'.repeat(40),
      AUTH_DOMAIN: 'api.mesh.example',
      CORS_ORIGINS: 'https://mesh.example',
    });
    expect(productionProblems(ok)).toEqual([]);
    expect(problems.join('\n')).toMatch(/KEY_PEPPER/);
    expect(ok.ALLOW_DEV_LOGIN).toBe(false);
    expect(ok.GEO_BLOCK_ENFORCE).toBe(true);
  });
});

// ---------------------------------------------------------------- headers, CORS, limits

describe('transport hardening', () => {
  it('helmet headers are set on every response', async () => {
    const { app } = await testServer();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined(); // only in production
  });

  it('CORS allowlist: listed origin is echoed, others get no ACAO; * means any (dev)', async () => {
    expect(corsOrigin({ CORS_ORIGINS: undefined, NODE_ENV: 'development' })).toBe(true);
    expect(corsOrigin({ CORS_ORIGINS: undefined, NODE_ENV: 'production' })).toEqual([]);
    expect(corsOrigin({ CORS_ORIGINS: 'https://a.example/, https://b.example', NODE_ENV: 'production' })).toEqual(['https://a.example', 'https://b.example']);

    const { app } = await testServer({ env: { CORS_ORIGINS: 'https://app.mesh.example' } });
    apps.push(app);
    const ok = await app.inject({ method: 'GET', url: '/stats', headers: { origin: 'https://app.mesh.example' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.mesh.example');
    const bad = await app.inject({ method: 'GET', url: '/stats', headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions', headers: { origin: 'https://app.mesh.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    expect(pre.statusCode).toBeLessThan(300);
    expect(pre.headers['access-control-allow-origin']).toBe('https://app.mesh.example');
    expect(String(pre.headers['access-control-expose-headers'])).toContain('x-mesh-cost-usd');
  });

  it('small bodies only on /auth/* and node routes (413), /v1 keeps the big limit', async () => {
    const { app } = await testServer();
    apps.push(app);
    const big = JSON.stringify({ wallet: 'a'.repeat(20_000) });
    const r = await app.inject({ method: 'POST', url: '/auth/nonce', payload: big, headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('payload_too_large');
    const r2 = await app.inject({ method: 'POST', url: '/nodes/register', payload: big, headers: { 'content-type': 'application/json' } });
    expect(r2.statusCode).toBe(413);
    // /v1 accepts ~100 KB (fails on auth, not on size)
    const r3 = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(100_000) }] }), headers: { 'content-type': 'application/json' } });
    expect(r3.statusCode).toBe(401);
    const r4 = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] }), headers: { 'content-type': 'application/json' } });
    expect(r4.statusCode).toBe(413);
  });

  it('/auth/* shares one per-IP budget across routes; /nodes/register has its own hourly budget', async () => {
    const { app } = await testServer({ env: { AUTH_RATE_LIMIT: 2, NODE_REGISTER_RATE_LIMIT: 2 } });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'a' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/refresh' })).statusCode).toBe(401); // counts
    const third = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'a' } });
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();

    expect((await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'w' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'w' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'w', models: [] } })).statusCode).toBe(429);
  });

  it('dev-login is 404 when ALLOW_DEV_LOGIN is false (production default)', async () => {
    const { app } = await testServer({ env: { ALLOW_DEV_LOGIN: false } });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } });
    expect(r.statusCode).toBe(404);
    const { app: dev } = await testServer();
    apps.push(dev);
    expect((await dev.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).statusCode).toBe(200);
  });

  it('/health/alerts is admin only', async () => {
    const { app } = await testServer({ env: { ALERTS_ENABLED: true } });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/health/alerts' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/health/alerts', headers: ADMIN });
    expect(r.statusCode).toBe(200);
    expect(r.json().alerts.map((a: { key: string }) => a.key)).toContain('missed_epoch');
    expect(r.json().sender).toBe('log');
  });
});

// ---------------------------------------------------------------- node registration

describe('signed node registration', () => {
  const signedRegister = async (app: Awaited<ReturnType<typeof testServer>>['app'], wallet: string, extra: Record<string, unknown> = {}) => {
    const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet, nodeId: extra.nodeId } });
    expect(ch.statusCode).toBe(200);
    const { nonce, message } = ch.json();
    return app.inject({
      method: 'POST',
      url: '/nodes/register',
      payload: { wallet, nonce, signature: MockAdapter.sign(wallet, message), models: ['llama3.1:8b'], ...extra },
      headers: (extra.headers as Record<string, string>) ?? {},
    });
  };

  it('requires a signature by default; unsigned → 401 signature_required', async () => {
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined } });
    apps.push(app);
    expect(testConfig.nodes.requireSignature).toBe(true);
    const r = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', models: [] } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('signature_required');
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json().total).toBe(0);
  });

  it('challenge → sign → register succeeds; nonce is single use; the message is not a sign-in message', async () => {
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined } });
    apps.push(app);
    const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'mockwallet_bob' } });
    const { nonce, message, requireSignature } = ch.json();
    expect(requireSignature).toBe(true);
    expect(message.split('\n')[0]).toBe('test.mesh wants to register a Mesh node paid to:');
    expect(parseLoginMessage(message)).toBeNull(); // cannot be mistaken for /auth
    const ok = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nonce, signature: MockAdapter.sign('mockwallet_bob', message), models: ['llama3.1:8b'], chip: 'M3' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().walletVerified).toBe(true);
    expect(ok.json().nodeToken).toMatch(/^mesh_nt_/);
    // replay the same challenge
    const replay = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nonce, signature: MockAdapter.sign('mockwallet_bob', message), models: [] } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('nonce_missing');
  });

  it('rejects a signature from another wallet, a tampered nodeId, and a sign-in nonce used for registration', async () => {
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined } });
    apps.push(app);
    const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'mockwallet_bob', nodeId: 'mac-1' } });
    const { nonce, message } = ch.json();
    expect(message).toContain('Node ID: mac-1');
    // mallory signs the challenge with her own key and claims bob's wallet
    const bad = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nodeId: 'mac-1', nonce, signature: MockAdapter.sign('mallory', message), models: [] } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('bad_signature');
    // the failed attempt consumed the nonce (single use)
    const ch2 = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'mockwallet_bob', nodeId: 'mac-1' } });
    // signature over the challenge for mac-1, but registering as mac-2
    const swapped = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nodeId: 'mac-2', nonce: ch2.json().nonce, signature: MockAdapter.sign('mockwallet_bob', ch2.json().message), models: [] } });
    expect(swapped.statusCode).toBe(401);
    // a /auth nonce (different domain tag) cannot be used for registration even with a valid signature over the register text
    const login = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'mockwallet_bob' } });
    const forged = registerMessage({ domain: 'test.mesh', uri: 'https://test.mesh', wallet: 'mockwallet_bob', nonce: login.json().nonce, issuedAt: nowSec() });
    const cross = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nonce: login.json().nonce, signature: MockAdapter.sign('mockwallet_bob', forged), models: [] } });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error).toBe('nonce_missing');
  });

  it('re-registering an existing nodeId needs both the signature and the node token; caps nodes per wallet', async () => {
    const cfg = { ...testConfig, nodes: { requireSignature: true, maxPerWallet: 2 } };
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined }, config: cfg });
    apps.push(app);
    const first = await signedRegister(app, 'mockwallet_bob', { nodeId: 'mac-1' });
    expect(first.statusCode).toBe(200);
    const token = first.json().nodeToken as string;
    // signed but without the token → 409
    const noToken = await signedRegister(app, 'mockwallet_bob', { nodeId: 'mac-1' });
    expect(noToken.statusCode).toBe(409);
    // signed + token → rotates
    const rotated = await signedRegister(app, 'mockwallet_bob', { nodeId: 'mac-1', headers: { authorization: `Bearer ${token}` } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().nodeToken).not.toBe(token);
    expect((await app.inject({ method: 'POST', url: `/nodes/mac-1/heartbeat`, headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).toBe(401);
    // cap
    expect((await signedRegister(app, 'mockwallet_bob', { nodeId: 'mac-2' })).statusCode).toBe(200);
    const third = await signedRegister(app, 'mockwallet_bob', { nodeId: 'mac-3' });
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('too_many_nodes');
  });

  it('an EVM wallet can register on a Solana-config gateway with {chain:"evm"} (real EIP-191 signature)', async () => {
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined } });
    apps.push(app);
    const account = privateKeyToAccount(generatePrivateKey());
    const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: account.address } });
    const signature = await account.signMessage({ message: ch.json().message });
    const ok = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: account.address, nonce: ch.json().nonce, signature, chain: 'evm', models: ['llama3.1:8b'] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().walletVerified).toBe(true);
    // wrong signer
    const other = privateKeyToAccount(generatePrivateKey());
    const ch2 = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: account.address } });
    const bad = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: account.address, nonce: ch2.json().nonce, signature: await other.signMessage({ message: ch2.json().message }), chain: 'evm', models: [] } });
    expect(bad.statusCode).toBe(401);
  });

  it('backward compat: NODES_REQUIRE_SIGNATURE=false accepts unsigned registration but still verifies a signature when one is sent', async () => {
    const { app } = await testServer(); // helpers set NODES_REQUIRE_SIGNATURE=false
    apps.push(app);
    const legacy = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', models: [] } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().walletVerified).toBe(false);
    const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'mockwallet_bob' } });
    expect(ch.json().requireSignature).toBe(false);
    const bad = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', nonce: ch.json().nonce, signature: 'garbage', models: [] } });
    expect(bad.statusCode).toBe(401);
  });

  it('node token compare: a near-miss token is rejected', async () => {
    const { app } = await testServer();
    apps.push(app);
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'mockwallet_bob', models: [] } });
    const { nodeId, nodeToken } = reg.json();
    const near = nodeToken.slice(0, -1) + (nodeToken.endsWith('A') ? 'B' : 'A');
    expect((await app.inject({ method: 'POST', url: `/nodes/${nodeId}/heartbeat`, headers: { authorization: `Bearer ${near}` }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/nodes/${nodeId}/heartbeat`, headers: { authorization: `Bearer ${nodeToken}` }, payload: {} })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- job claims / relays

describe('job broker', () => {
  it('a closed relay refuses chunks (client gone) and a claim is atomic across two nodes', () => {
    const db = memDb();
    const broker = new JobBroker(db, () => ({ minSuccessRate: 0.8, reputationMinJobs: 5 }));
    const ts = nowSec();
    for (const id of ['n1', 'n2']) {
      db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen, token_hash) VALUES (?, 'w', '', '["t"]', ?, ?, 'h')`).run(id, ts, ts);
    }
    const { job, relay } = broker.create({ model: 'm', tag: 't', wallet: 'alice', apiKeyId: null, payload: { messages: [], params: {} }, maxTokens: 10, deadlineMs: Date.now() + 10_000 });
    const a = broker.tryClaim(job.job_id, 'n1');
    const b = broker.tryClaim(job.job_id, 'n2');
    expect(a?.node_id).toBe('n1');
    expect(b).toBeNull();
    expect(broker.chunk(job.job_id, 'n2', 0, 'x')).toBe(false); // not its job
    expect(broker.chunk(job.job_id, 'n1', 0, 'x')).toBe(true);
    relay.close(); // client disconnected
    expect(broker.chunk(job.job_id, 'n1', 1, 'y')).toBe(false);
    broker.abandon(job.job_id, 'failed', 'client_disconnected', false);
    expect(broker.get(job.job_id)?.status).toBe('failed');
    expect(broker.done(job.job_id, 'n1', { promptTokens: 1, completionTokens: 1, finishReason: 'stop' })).toEqual({ ok: false, reason: 'not_running' });
    expect((db.prepare(`SELECT busy FROM nodes WHERE node_id = 'n1'`).get() as { busy: number }).busy).toBe(0);
  });
});

// ---------------------------------------------------------------- alerts

function fakeSender(): AlertSender & { messages: string[] } {
  const messages: string[] = [];
  return {
    name: 'fake',
    messages,
    async send(text) {
      messages.push(text);
    },
  };
}

/** 2026-10-03 06:00 UTC = 10:00 Asia/Dubai (UTC+4). */
const T0 = Date.UTC(2026, 9, 3, 6, 0, 0);

function monitorAt(startMs: number, opts: Partial<ConstructorParameters<typeof AlertMonitor>[0]> = {}) {
  const db = opts.db ?? memDb();
  let now = startMs;
  const sender = fakeSender();
  const mon = new AlertMonitor({
    db,
    config: { epochSeconds: 3600 },
    env: { EPOCH_CRON: '0 * * * *', MESH_DB_PATH: ':memory:' },
    sender,
    now: () => now,
    dbSize: () => null,
    disk: () => null,
    ...opts,
  });
  return { db, mon, sender, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) };
}

describe('alerts', () => {
  it('localDayHour handles Asia/Dubai (UTC+4)', () => {
    expect(localDayHour(Date.UTC(2026, 9, 3, 4, 59), 'Asia/Dubai')).toEqual({ day: '2026-10-03', hour: 8 });
    expect(localDayHour(Date.UTC(2026, 9, 3, 5, 0), 'Asia/Dubai')).toEqual({ day: '2026-10-03', hour: 9 });
    expect(localDayHour(Date.UTC(2026, 9, 3, 20, 30), 'Asia/Dubai')).toEqual({ day: '2026-10-04', hour: 0 });
  });

  it('missed epoch fires after 1.5 × epochSeconds without a complete epoch and resolves when one lands', async () => {
    const { db, mon, sender, advance } = monitorAt(T0);
    await mon.check();
    expect(sender.messages).toEqual([]); // no digest: booted after 09:00 today
    advance(60 * 60_000);
    await mon.check();
    expect(sender.messages).toEqual([]);
    advance(31 * 60_000); // 91 min since boot > 90
    await mon.check();
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toMatch(/ALERT missed_epoch/);
    await mon.check(); // no spam
    expect(sender.messages).toHaveLength(1);
    const ts = Math.floor((T0 + 91 * 60_000) / 1000);
    db.prepare(`INSERT INTO epochs (epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, status, created_at) VALUES (?, ?, 0, 0, 0, 0, 'empty', ?)`).run(ts - 3600, ts, ts);
    await mon.check();
    expect(sender.messages).toHaveLength(2);
    expect(sender.messages[1]).toMatch(/resolved missed_epoch/);
    expect(mon.status().alerts.find((a) => a.key === 'missed_epoch')?.firing).toBe(false);
    // re-notify every 6 h while still firing
    advance(6 * 3_600_000);
    await mon.check();
    expect(sender.messages[2]).toMatch(/ALERT missed_epoch/);
    advance(6 * 3_600_000);
    await mon.check();
    expect(sender.messages[3]).toMatch(/STILL FIRING missed_epoch/);
  });

  it('EPOCH_CRON=off never raises missed_epoch', async () => {
    const { mon, sender, advance } = monitorAt(T0, { env: { EPOCH_CRON: 'off', MESH_DB_PATH: ':memory:' } });
    advance(10 * 3_600_000);
    await mon.check();
    expect(sender.messages).toEqual([]);
  });

  it('failed sweep: a failed epoch row or an epoch_failed error fires once per occurrence', async () => {
    const { db, mon, sender } = monitorAt(T0);
    const ts = Math.floor(T0 / 1000);
    db.prepare(`INSERT INTO errors_log (route, status, code, message, created_at) VALUES ('cron run-epoch', 500, 'epoch_failed', 'rpc down', ?)`).run(ts);
    await mon.check();
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toMatch(/ALERT failed_sweep: 1 failed sweep\(s\).*rpc down/);
    await mon.check(); // nothing new → clears silently
    expect(sender.messages).toHaveLength(1);
    db.prepare(`INSERT INTO epochs (epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, status, created_at) VALUES (?, ?, 0, 0, 0, 0, 'failed', ?)`).run(ts - 3600, ts, ts);
    await mon.check();
    expect(sender.messages).toHaveLength(2);
    expect(sender.messages[1]).toMatch(/ALERT failed_sweep/);
  });

  it('upstream error rate > 20 % over 5 min (min 3 errors)', async () => {
    const { db, mon, sender } = monitorAt(T0);
    const ts = Math.floor(T0 / 1000);
    const err = db.prepare(`INSERT INTO errors_log (route, status, code, message, created_at) VALUES ('/v1/chat/completions', 502, 'upstream_timeout', 'x', ?)`);
    const req = db.prepare(`INSERT INTO requests_log (api_key_id, wallet, model, upstream, latency_ms, created_at) VALUES (1, 'a', 'm', 'openrouter', 10, ?)`);
    for (let i = 0; i < 2; i++) err.run(ts - 10);
    await mon.check();
    expect(sender.messages).toEqual([]); // below min errors
    err.run(ts - 10);
    for (let i = 0; i < 20; i++) req.run(ts - 10);
    await mon.check();
    expect(sender.messages).toEqual([]); // 3/23 = 13 %
    for (let i = 0; i < 4; i++) err.run(ts - 10);
    await mon.check();
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toMatch(/ALERT upstream_error_rate: 7 upstream errors \/ 27 requests/);
  });

  it('fleet drop > 50 % in 10 min', async () => {
    const { db, mon, sender } = monitorAt(T0);
    const ts = Math.floor(T0 / 1000);
    const node = db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES (?, 'w', '', '[]', ?, ?)`);
    const hb = db.prepare(`INSERT INTO heartbeats (node_id, ts, busy) VALUES (?, ?, 0)`);
    for (const id of ['a', 'b', 'c', 'd']) {
      node.run(id, ts - 7200, id === 'a' ? ts : ts - 1000); // only a is online now
      hb.run(id, ts - 600 - 20); // all four were online 10 min ago
    }
    await mon.check();
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toMatch(/ALERT fleet_drop: 1 nodes online now, 4 ten minutes ago/);
  });

  it('db size and disk thresholds use the injected probes', async () => {
    const { mon, sender } = monitorAt(T0, {
      dbSize: () => 2 * 1024 ** 3,
      disk: () => ({ freeBytes: 5 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
    });
    await mon.check();
    expect(sender.messages.map((m) => m.split(':')[0])).toEqual(['[mesh] ALERT db_size', '[mesh] ALERT disk_low']);
  });

  it('daily digest at 09:00 Asia/Dubai, once per day, with 24 h numbers', async () => {
    const start = Date.UTC(2026, 9, 3, 4, 0, 0); // 08:00 Dubai
    const { db, mon, sender, set } = monitorAt(start);
    const ts = Math.floor(start / 1000);
    db.prepare(`INSERT INTO epochs (epoch_start, epoch_end, fees_usd_micros, holder_pool_usd_micros, treasury_usd_micros, eligible_holders, status, created_at) VALUES (?, ?, 100000000, 50000000, 50000000, 3, 'complete', ?)`).run(ts - 3600, ts, ts - 60);
    db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', 50000000, 'distribution', 'epoch:1', ?)`).run(ts - 60);
    db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', -1000, 'usage', 'req:1', ?)`).run(ts - 30);
    db.prepare(`INSERT INTO requests_log (api_key_id, wallet, model, upstream, latency_ms, created_at) VALUES (1, 'a', 'm', 'node:n1', 10, ?)`).run(ts - 30);
    db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES ('n1', 'w', '', '[]', ?, ?)`).run(ts - 7200, ts + 3600); // still heartbeating at digest time
    db.prepare(`INSERT INTO errors_log (route, status, code, message, created_at) VALUES ('/v1', 502, 'upstream_timeout', 'x', ?)`).run(ts - 30);
    await mon.check();
    expect(sender.messages).toEqual([]);
    set(Date.UTC(2026, 9, 3, 5, 0, 30)); // 09:00:30 Dubai
    await mon.check();
    expect(sender.messages).toHaveLength(1);
    const d = sender.messages[0];
    expect(d).toContain('daily digest 2026-10-03');
    expect(d).toContain('fees: $100.00 over 1 epoch(s); holder pool $50.00');
    expect(d).toContain('credits: +$50.00 distributed, -$0.0010 used');
    expect(d).toContain('requests: 1 from 1 wallet(s), 1 served by nodes');
    expect(d).toContain('nodes: 1 online / 1 registered');
    expect(d).toContain('errors: 1 (upstream_timeout ×1)');
    const digests = () => sender.messages.filter((m) => m.includes('daily digest'));
    set(Date.UTC(2026, 9, 3, 12, 0, 0));
    await mon.check(); // (missed_epoch fires here too; that is correct and not what we count)
    expect(digests()).toHaveLength(1); // not twice a day
    set(Date.UTC(2026, 9, 4, 5, 10, 0)); // next day 09:10 Dubai
    await mon.check();
    expect(digests()).toHaveLength(2);
    expect(digests()[1]).toContain('alerts firing: missed_epoch');
    expect(mon.status().lastDigestDay).toBe('2026-10-04');
  });

  it('telegram sender posts to the bot API with the chat id; failures are counted, not thrown', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: calls.length === 1 ? 200 : 500 });
    }) as typeof fetch;
    const tg = telegramSender('123:abc', '-100777', fetchImpl);
    await tg.send('hello');
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(calls[0].body).toMatchObject({ chat_id: '-100777', text: 'hello' });
    await expect(tg.send('again')).rejects.toThrow(/HTTP 500/);

    const { mon } = monitorAt(T0, { sender: tg, dbSize: () => 10 * 1024 ** 3 });
    await mon.check();
    expect(mon.deliveryFailures).toBe(1);
    expect(mon.status().recentlySent[0].ok).toBe(false);
  });
});
