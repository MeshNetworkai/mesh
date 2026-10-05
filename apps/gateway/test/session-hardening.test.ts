import { MockAdapter } from '@mesh/chain-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  KEY_HASH_V1,
  SESSION_COOKIE,
  createApiKey,
  csrfOk,
  hashApiKey,
  isPepperedKeyHash,
  lookupApiKey,
  parseCookies,
  serializeCookie,
  signAdminSession,
  signSession,
  verifyAdminSession,
  verifySession,
} from '../src/auth.js';
import { adminIpAllowlist, loadEnv, productionProblems, trustedProxyCidrs } from '../src/env.js';
import { ensureWallet } from '../src/ledger.js';
import { DEFAULT_TRUSTED_PROXY_CIDRS, cidrMatcher, parseCidrList } from '../src/netaddr.js';
import { csrfApplies, isAdminPath } from '../src/server.js';
import { ADMIN, memDb, testServer } from './helpers.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type Inject = Awaited<ReturnType<Awaited<ReturnType<typeof testServer>>['app']['inject']>>;

/** Cookie jar from a response: name -> value (deleted cookies map to ''). */
function jar(res: Inject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.cookies as Array<{ name: string; value: string }>) out[c.name] = c.value;
  return out;
}
const cookieHeader = (c: Record<string, string>) =>
  Object.entries(c)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');

/** Sign a wallet in through dev-login and return its cookie jar + bearer token. */
async function cookieLogin(app: Awaited<ReturnType<typeof testServer>>['app'], wallet = 'alice') {
  const res = await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } });
  expect(res.statusCode).toBe(200);
  const cookies = jar(res);
  expect(cookies[SESSION_COOKIE]).toBe(res.json().token);
  expect(cookies[CSRF_COOKIE]).toBe(res.json().csrf);
  return { cookies, token: res.json().token as string, csrf: res.json().csrf as string };
}

// ---------------------------------------------------------------- cookies + CSRF

describe('cookie sessions', () => {
  it('cookie helpers round-trip and set the right flags', () => {
    expect(parseCookies('a=1; b=hello%20world; c="q"; junk; =x')).toEqual({ a: '1', b: 'hello world', c: 'q' });
    const c = serializeCookie(SESSION_COOKIE, 'tok', { httpOnly: true, secure: true, maxAge: 60 });
    expect(c).toBe('mesh_session=tok; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    const gone = serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
    expect(gone).toMatch(/Max-Age=0/);
    expect(gone).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(gone).not.toMatch(/Secure/);
    expect(csrfOk({ [CSRF_COOKIE]: 'abc' }, 'abc')).toBe(true);
    expect(csrfOk({ [CSRF_COOKIE]: 'abc' }, 'abd')).toBe(false);
    expect(csrfOk({}, 'abc')).toBe(false);
    expect(csrfOk({ [CSRF_COOKIE]: 'abc' }, undefined)).toBe(false);
  });

  it('/auth/verify sets HttpOnly session + readable CSRF cookies; Secure follows COOKIE_SECURE', async () => {
    const { app } = await testServer({ env: { COOKIE_SECURE: true } });
    apps.push(app);
    const nonce = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'mockwallet_alice' } });
    const message = nonce.json().message as string;
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'mockwallet_alice', signature: MockAdapter.sign('mockwallet_alice', message), message } });
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'] as string[];
    expect(raw).toHaveLength(2);
    const session = raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const csrf = raw.find((c) => c.startsWith(`${CSRF_COOKIE}=`))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(new RegExp(`Max-Age=${7 * 86_400}`));
    expect(csrf).not.toMatch(/HttpOnly/); // the web app must read it
    expect(csrf).toMatch(/Secure/);
    expect(jar(res)[SESSION_COOKIE]).toBe(res.json().token); // bearer clients still get the token in the body
  });

  it('a cookie alone authenticates GETs; state changes need the CSRF header; bearer stays CSRF-free', async () => {
    const { app } = await testServer();
    apps.push(app);
    const { cookies, token, csrf } = await cookieLogin(app);
    const cookie = cookieHeader(cookies);

    // cookie session works for reads
    const me = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().wallet).toBe('alice');
    const who = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    // the web app on another origin cannot read the api-host cookie, so /auth/session echoes the token
    expect(who.json()).toMatchObject({ wallet: 'alice', via: 'cookie', csrf });
    expect((await app.inject({ method: 'GET', url: '/auth/session' })).statusCode).toBe(401);

    // POST /keys without the header → 403 csrf_mismatch, nothing created — and the rejection carries
    // CORS headers, so a browser sees the 403 instead of a "blocked by CORS policy" error
    const noCsrf = await app.inject({ method: 'POST', url: '/keys', headers: { cookie, origin: 'http://localhost:5173' }, payload: { name: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('csrf_mismatch');
    expect(noCsrf.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    // wrong header → 403
    expect((await app.inject({ method: 'POST', url: '/keys', headers: { cookie, [CSRF_HEADER]: 'nope' }, payload: { name: 'x' } })).statusCode).toBe(403);
    // header only, no cookie copy (attacker cannot set our cookie) → 403
    const noCookieCopy = cookieHeader({ [SESSION_COOKIE]: cookies[SESSION_COOKIE] });
    expect((await app.inject({ method: 'POST', url: '/keys', headers: { cookie: noCookieCopy, [CSRF_HEADER]: csrf }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/keys', headers: { cookie } })).json().keys).toHaveLength(0);

    // matching pair → 201; PATCH and DELETE likewise
    const created = await app.inject({ method: 'POST', url: '/keys', headers: { cookie, [CSRF_HEADER]: csrf }, payload: { name: 'x' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { cookie }, payload: { name: 'y' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { cookie, [CSRF_HEADER]: csrf }, payload: { name: 'y' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/keys/${id}`, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/keys/${id}`, headers: { cookie, [CSRF_HEADER]: csrf } })).statusCode).toBe(200);

    // bearer clients never need the header, even with a stale cookie attached
    expect((await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${token}`, cookie }, payload: { name: 'api' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${token}` }, payload: { name: 'api2' } })).statusCode).toBe(201);

    // /nodes/link is protected the same way (no body needed to prove the gate: 403 before validation)
    expect((await app.inject({ method: 'POST', url: '/nodes/link', headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/nodes/link', headers: { cookie, [CSRF_HEADER]: csrf }, payload: {} })).statusCode).toBe(400);

    // sign-in routes stay reachable with a stale cookie and no header (signature auth, not cookie auth)
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', headers: { cookie }, payload: { wallet: 'bob' } })).statusCode).toBe(200);
  });

  it('refresh works from the cookie and re-sets it; logout clears both cookies and needs CSRF', async () => {
    const { app } = await testServer();
    apps.push(app);
    const { cookies, csrf } = await cookieLogin(app);
    const cookie = cookieHeader(cookies);
    expect((await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie } })).statusCode).toBe(403);
    const fresh = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie, [CSRF_HEADER]: csrf } });
    expect(fresh.statusCode).toBe(200);
    const j = jar(fresh);
    expect(j[SESSION_COOKIE]).toBe(fresh.json().token);
    expect(j[CSRF_COOKIE]).toBe(fresh.json().csrf);
    expect(j[CSRF_COOKIE]).not.toBe(csrf);
    // bearer refresh still answers with a token (and cookies, harmless for API clients)
    expect((await app.inject({ method: 'POST', url: '/auth/refresh', headers: { authorization: `Bearer ${fresh.json().token}` } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(403);
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, [CSRF_HEADER]: csrf } });
    expect(out.statusCode).toBe(200);
    const cleared = out.headers['set-cookie'] as string[];
    expect(cleared.filter((c) => /Max-Age=0/.test(c))).toHaveLength(2);
    expect(cleared.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    expect(cleared.some((c) => c.startsWith(`${CSRF_COOKIE}=;`))).toBe(true);
    // without any cookie logout is a no-op 200 (bearer clients just drop the token)
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(200);
  });

  it('csrfApplies: safe methods, header auth, /v1 and signature routes are exempt', () => {
    const req = (method: string, url: string, headers: Record<string, string> = {}) => ({ method, url, headers }) as never;
    const cookie = `${SESSION_COOKIE}=x`;
    expect(csrfApplies(req('GET', '/keys', { cookie }))).toBe(false);
    expect(csrfApplies(req('POST', '/keys', { cookie }))).toBe(true);
    expect(csrfApplies(req('POST', '/keys?x=1', { cookie }))).toBe(true);
    expect(csrfApplies(req('POST', '/keys'))).toBe(false); // no cookie: nothing to protect
    expect(csrfApplies(req('POST', '/keys', { cookie, authorization: 'Bearer t' }))).toBe(false);
    expect(csrfApplies(req('POST', '/admin/run-epoch', { cookie: `${ADMIN_COOKIE}=x` }))).toBe(true);
    expect(csrfApplies(req('POST', '/admin/run-epoch', { cookie: `${ADMIN_COOKIE}=x`, 'x-admin-token': 't' }))).toBe(false);
    expect(csrfApplies(req('POST', '/admin/login', { cookie }))).toBe(false);
    expect(csrfApplies(req('POST', '/auth/verify', { cookie }))).toBe(false);
    expect(csrfApplies(req('POST', '/v1/chat/completions', { cookie }))).toBe(false);
    expect(csrfApplies(req('POST', '/auth/logout', { cookie }))).toBe(true);
    expect(csrfApplies(req('POST', '/stake', { cookie }))).toBe(true); // new session routes are covered automatically
  });

  it('CORS answers with credentials for an allowed origin only', async () => {
    const { app } = await testServer({ env: { CORS_ORIGINS: 'https://app.mesh' } });
    apps.push(app);
    const ok = await app.inject({ method: 'OPTIONS', url: '/keys', headers: { origin: 'https://app.mesh', 'access-control-request-method': 'POST', 'access-control-request-headers': `content-type, ${CSRF_HEADER}` } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.mesh');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers['access-control-allow-headers']).toLowerCase()).toContain(CSRF_HEADER);
    expect(String(ok.headers['access-control-expose-headers'] ?? '')).toContain('x-request-id');
    const bad = await app.inject({ method: 'GET', url: '/stats', headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ---------------------------------------------------------------- admin hardening

describe('admin hardening', () => {
  it('admin JWT is never a wallet session and vice versa', async () => {
    const secret = 'test-secret-test-secret-test-secret';
    const adm = await signAdminSession(secret);
    expect(await verifySession(secret, adm)).toBeNull();
    expect(await verifyAdminSession(secret, adm)).not.toBeNull();
    const wallet = await signSession(secret, 'admin', 'solana');
    expect(await verifyAdminSession(secret, wallet)).toBeNull();
    expect(await verifyAdminSession('other-secret-other-secret-other', adm)).toBeNull();
  });

  it('POST /admin/login sets an HttpOnly admin cookie that works with CSRF; logout clears it; everything is audited', async () => {
    const { app } = await testServer();
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/admin/login', headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/login', payload: { token: 'wrong' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/admin/login', headers: ADMIN });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'] as string[];
    const admCookie = raw.find((c) => c.startsWith(`${ADMIN_COOKIE}=`))!;
    expect(admCookie).toMatch(/HttpOnly/);
    expect(admCookie).not.toContain('test-admin'); // the cookie is a JWT, never the token
    const cookies = jar(login);
    const csrf = login.json().csrf as string;
    const cookie = cookieHeader(cookies);

    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/session', headers: { cookie } })).json()).toEqual({ ok: true, via: 'cookie' });
    expect((await app.inject({ method: 'GET', url: '/health/alerts', headers: { cookie } })).statusCode).toBe(503); // past the guard; alerts are off in tests
    expect((await app.inject({ method: 'GET', url: '/health/alerts' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: { cookie }, payload: { amountUsd: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/fake-fees', headers: { cookie, [CSRF_HEADER]: csrf }, payload: { amountUsd: 1 } })).statusCode).toBe(200);
    // a wallet session cookie is not an admin cookie
    const { cookies: wc } = await cookieLogin(app);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { cookie: cookieHeader(wc) } })).statusCode).toBe(401);
    // a forged admin cookie is rejected
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: { cookie: `${ADMIN_COOKIE}=${cookies[ADMIN_COOKIE]}x` } })).statusCode).toBe(401);

    const out = await app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie, [CSRF_HEADER]: csrf } });
    expect(out.statusCode).toBe(200);
    const outCookies = ([] as string[]).concat(out.headers['set-cookie'] as string | string[]);
    expect(outCookies.some((c) => c.startsWith(`${ADMIN_COOKIE}=;`) && /Max-Age=0/.test(c))).toBe(true);

    const actions = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json().recentAdminActions as Array<{ action: string; payload: Record<string, unknown> }>;
    const names = actions.map((a) => a.action);
    expect(names).toContain('admin-login');
    expect(names).toContain('admin-logout');
    expect(names).toContain('fake-fees');
    expect(names).toContain('dev-login');
    // the two failed logins and the 401s were recorded as denied
    expect(actions.filter((a) => a.action === 'admin-denied' && a.payload.status === 401).length).toBeGreaterThanOrEqual(4);
    // successful GET reads are not persisted (they would bury the list)
    expect(actions.some((a) => a.action === 'admin-call' && a.payload.method === 'GET')).toBe(false);
  });

  it('ADMIN_IP_ALLOWLIST blocks /admin/* and /health/alerts from other addresses, 403 is audited, public routes unaffected', async () => {
    const { app } = await testServer({ env: { ADMIN_IP_ALLOWLIST: '10.0.0.0/8, 192.168.1.5' } });
    apps.push(app);
    // inject's default peer is 127.0.0.1, which is not on the list
    const denied = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden' });
    expect(denied.json().requestId).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/health/alerts', headers: ADMIN })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/stats' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    // allowed peer
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN, remoteAddress: '10.4.5.6' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN, remoteAddress: '192.168.1.5' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN, remoteAddress: '192.168.1.6' })).statusCode).toBe(403);
    const actions = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN, remoteAddress: '10.4.5.6' })).json().recentAdminActions as Array<{ action: string; payload: Record<string, unknown> }>;
    expect(actions.filter((a) => a.action === 'admin-denied-ip' && a.payload.ip === '127.0.0.1').length).toBeGreaterThanOrEqual(2);
  });

  it('X-Forwarded-For is honoured only from TRUSTED_PROXY_CIDRS', async () => {
    const { app } = await testServer({ env: { ADMIN_IP_ALLOWLIST: '203.0.113.7/32', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' } });
    apps.push(app);
    const xff = { ...ADMIN, 'x-forwarded-for': '203.0.113.7' };
    // from the trusted proxy: the forwarded client is the allowed admin
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: xff, remoteAddress: '10.0.0.2' })).statusCode).toBe(200);
    // from an untrusted peer the header is ignored → the peer itself (not allowed) is the client
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: xff, remoteAddress: '198.51.100.9' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/overview', headers: xff })).statusCode).toBe(403); // 127.0.0.1 not trusted here
    // the default trusts loopback + private ranges
    expect(trustedProxyCidrs({ TRUSTED_PROXY_CIDRS: undefined })).toEqual(DEFAULT_TRUSTED_PROXY_CIDRS);
    expect(trustedProxyCidrs({ TRUSTED_PROXY_CIDRS: '*' })).toBeNull();
    expect(adminIpAllowlist({ ADMIN_IP_ALLOWLIST: undefined })).toEqual([]);
    expect(() => adminIpAllowlist({ ADMIN_IP_ALLOWLIST: 'not-an-ip' })).toThrow(/not an IP/);
    const env = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'y'.repeat(30), KEY_PEPPER: 'p'.repeat(40), AUTH_DOMAIN: 'api.mesh', CORS_ORIGINS: 'https://mesh', TRUSTED_PROXY_CIDRS: '*' });
    expect(productionProblems(env).join('\n')).toMatch(/TRUSTED_PROXY_CIDRS/);
  });

  it('geo-block headers are trusted only from the proxy', async () => {
    const { app } = await testServer({ env: { GEO_BLOCK_ENFORCE: true, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }, config: { ...(await import('./helpers.js')).testConfig, geoBlock: ['US'] } });
    apps.push(app);
    const hdr = { 'cf-ipcountry': 'US' };
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', headers: hdr, payload: { wallet: 'a' }, remoteAddress: '10.0.0.3' })).statusCode).toBe(451);
    // a direct client claiming a country is neither trusted nor blocked by its own header
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', headers: { 'cf-ipcountry': 'FR' }, payload: { wallet: 'a' }, remoteAddress: '10.0.0.3' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', headers: hdr, payload: { wallet: 'a' }, remoteAddress: '198.51.100.9' })).statusCode).toBe(200);
  });

  it('cidr helpers', () => {
    expect(parseCidrList(' 10.0.0.0/8,192.168.1.5 ::1 ')).toEqual(['10.0.0.0/8', '192.168.1.5/32', '::1/128']);
    expect(parseCidrList(undefined)).toEqual([]);
    const m = cidrMatcher(['10.0.0.0/8', '::1/128', '2001:db8::/32']);
    expect(m.has('10.255.0.1')).toBe(true);
    expect(m.has('::ffff:10.1.2.3')).toBe(true); // IPv4-mapped (dual-stack listener)
    expect(m.has('11.0.0.1')).toBe(false);
    expect(m.has('::1')).toBe(true);
    expect(m.has('2001:db8:1::5')).toBe(true);
    expect(m.has('garbage')).toBe(false);
    expect(m.has(undefined)).toBe(false);
    expect(() => cidrMatcher(['10.0.0.0/40'])).toThrow(/prefix/);
    expect(isAdminPath('/admin/overview')).toBe(true);
    expect(isAdminPath('/health/alerts')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/health')).toBe(false);
  });
});

// ---------------------------------------------------------------- peppered key hashes + request ids

describe('peppered API-key hashes', () => {
  it('new keys are HMAC-peppered; legacy sha256 rows resolve and are rehashed on first use', () => {
    const db = memDb();
    ensureWallet(db, 'w1', 'solana');
    const pepper = 'pepper-pepper-pepper-pepper-pepper';
    const fresh = createApiKey(db, 'w1', { name: 'new', pepper });
    const row = db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(fresh.id) as { key_hash: string };
    expect(isPepperedKeyHash(row.key_hash)).toBe(true);
    expect(row.key_hash).toBe(hashApiKey(fresh.key, pepper));
    expect(row.key_hash).not.toBe(hashApiKey(fresh.key));
    expect(hashApiKey(fresh.key, 'other-pepper-other-pepper')).not.toBe(row.key_hash);
    expect(lookupApiKey(db, fresh.key, pepper)?.id).toBe(fresh.id);
    expect(lookupApiKey(db, fresh.key)).toBeNull(); // without the pepper the peppered row is unreachable
    expect(lookupApiKey(db, fresh.key, 'other-pepper-other-pepper')).toBeNull();

    // legacy row (created before KEY_PEPPER existed)
    const legacy = createApiKey(db, 'w1', { name: 'old' });
    const before = (db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(legacy.id) as { key_hash: string }).key_hash;
    expect(isPepperedKeyHash(before)).toBe(false);
    expect(before).toBe(hashApiKey(legacy.key));
    const hit = lookupApiKey(db, legacy.key, pepper);
    expect(hit?.id).toBe(legacy.id);
    expect(hit?.key_hash.startsWith(KEY_HASH_V1)).toBe(true);
    const after = (db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(legacy.id) as { key_hash: string }).key_hash;
    expect(after).toBe(hashApiKey(legacy.key, pepper));
    // second lookup takes the fast path; the legacy hash no longer resolves
    expect(lookupApiKey(db, legacy.key, pepper)?.id).toBe(legacy.id);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE key_hash = ?`).get(before)).toEqual({ n: 0 });
    // revoked legacy rows are not resurrected by the migration path
    db.prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ?`).run(legacy.id);
    expect(lookupApiKey(db, legacy.key, pepper)).toBeNull();
  });

  it('end to end: a legacy key still works on /v1 and ends up peppered', async () => {
    const { app } = await testServer({ env: { KEY_PEPPER: 'pepper-pepper-pepper-pepper-pepper' } });
    apps.push(app);
    ensureWallet(app.ctx.db, 'legacy', 'solana');
    const { key, id } = createApiKey(app.ctx.db, 'legacy', { name: 'pre-pepper' });
    const models = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } });
    expect(models.statusCode).toBe(200);
    const row = app.ctx.db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(id) as { key_hash: string };
    expect(isPepperedKeyHash(row.key_hash)).toBe(true);
    // keys made through the API are peppered from the start
    const { token } = await cookieLogin(app, 'fresh');
    const created = await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const r2 = app.ctx.db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(created.json().id) as { key_hash: string };
    expect(isPepperedKeyHash(r2.key_hash)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${created.json().key}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${created.json().key}x` } })).statusCode).toBe(401);
  });
});

describe('request ids', () => {
  it('every response carries x-request-id; a proxy-supplied one is echoed; error bodies include it', async () => {
    const { app } = await testServer();
    apps.push(app);
    const a = await app.inject({ method: 'GET', url: '/stats' });
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const b = await app.inject({ method: 'GET', url: '/stats', headers: { 'x-request-id': 'proxy-abc-123' } });
    expect(b.headers['x-request-id']).toBe('proxy-abc-123');
    const notFound = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'proxy-404' } });
    expect(notFound.headers['x-request-id']).toBe('proxy-404');
    const tooBig = await app.inject({ method: 'POST', url: '/auth/nonce', headers: { 'x-request-id': 'big-1', 'content-type': 'application/json' }, payload: { wallet: 'x'.repeat(20_000) } });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().requestId).toBe('big-1');
    expect(tooBig.headers['x-request-id']).toBe('big-1');
  });
});
