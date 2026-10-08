import { MockAdapter } from '@mesh/chain-adapter';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { NONCE_TTL_SEC, NonceStore, canonicalWallet, loginMessage, parseLoginMessage, signSession, verifySession } from '../src/auth.js';
import { prepaidBalanceMicros } from '../src/market.js';
import { ADMIN, memDb, testServer } from './helpers.js';

describe('NonceStore (SQLite)', () => {
  it('is single use and expires after 5 minutes', () => {
    const store = new NonceStore(memDb());
    const t0 = 1_700_000_000;
    const issued = store.issue('w1', 'mesh.test', t0);
    expect(issued.expiresAt - issued.issuedAt).toBe(NONCE_TTL_SEC);
    expect(store.consume('w1', issued.nonce, t0 + 10)?.nonce).toBe(issued.nonce);
    expect(store.consume('w1', issued.nonce, t0 + 11)).toBeNull(); // used

    const late = store.issue('w1', 'mesh.test', t0);
    expect(store.consume('w1', late.nonce, t0 + NONCE_TTL_SEC + 1)).toBeNull(); // expired

    const a = store.issue('w2', 'mesh.test', t0);
    expect(store.consume('w1', a.nonce, t0)).toBeNull(); // wrong wallet
    expect(store.consume('w2', undefined, t0)?.nonce).toBe(a.nonce); // newest live nonce for wallet
    expect(store.consume('w2', undefined, t0)).toBeNull();
  });
});

describe('sign-in message', () => {
  it('has SIWE fields and round-trips through the parser', () => {
    const msg = loginMessage({ domain: 'mesh.test', uri: 'https://mesh.test', wallet: 'abc', nonce: 'n0nce', issuedAt: 1_700_000_000, expiresAt: 1_700_000_300 });
    expect(msg.split('\n')[0]).toBe('mesh.test wants you to sign in with your wallet:');
    expect(msg).toContain('\nURI: https://mesh.test\nVersion: 1\nNonce: n0nce\nIssued At: 2023-11-14T22:13:20.000Z\nExpiration Time: 2023-11-14T22:18:20.000Z');
    expect(parseLoginMessage(msg)).toEqual({ domain: 'mesh.test', wallet: 'abc', nonce: 'n0nce', issuedAt: 1_700_000_000 });
    expect(parseLoginMessage('hello')).toBeNull();
  });
});

describe('/auth flow', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it('verify checks domain, nonce and issued-at; nonce is single use; refresh issues a new 7d token', async () => {
    const { app } = await testServer();
    apps.push(app);
    const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'alice' } });
    const { nonce, message } = n.json();

    // tampered domain in echoed message
    const tampered = message.replace('test.mesh wants', 'evil.site wants');
    const bad = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: MockAdapter.sign('alice', tampered), message: tampered } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('domain_mismatch');

    // tampered issued-at: message no longer equals the issued one -> nonce is consumed, request rejected
    const shifted = message.replace(/Issued At: .*/, 'Issued At: 2020-01-01T00:00:00.000Z');
    const bad2 = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: MockAdapter.sign('alice', shifted), message: shifted } });
    expect(bad2.statusCode).toBe(400);
    expect(bad2.json().error).toBe('message_mismatch');

    // nonce consumed by the failed attempt -> single use
    const replay = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: MockAdapter.sign('alice', message), nonce, message } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('nonce_missing');

    // happy path with a fresh nonce, echoing message + nonce
    const n2 = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'alice' } });
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { wallet: 'alice', signature: MockAdapter.sign('alice', n2.json().message), nonce: n2.json().nonce, message: n2.json().message },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().expiresInSec).toBe(7 * 86_400);
    const token = ok.json().token as string;
    const s = await verifySession('test-secret-test-secret-test-secret', token);
    expect(s?.wallet).toBe('alice');

    // same nonce again -> rejected
    const again = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'alice', signature: MockAdapter.sign('alice', n2.json().message), nonce: n2.json().nonce } });
    expect(again.statusCode).toBe(400);

    // refresh
    await new Promise((r) => setTimeout(r, 1100));
    const ref = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { authorization: `Bearer ${token}` } });
    expect(ref.statusCode).toBe(200);
    expect(ref.json().token).not.toBe(token);
    expect((await verifySession('test-secret-test-secret-test-secret', ref.json().token))?.wallet).toBe('alice');
    const noAuth = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(noAuth.statusCode).toBe(401);
    const garbage = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { authorization: 'Bearer nope' } });
    expect(garbage.statusCode).toBe(401);
  });

  it('a real EVM wallet signs the issued message and logs in', async () => {
    const { app } = await testServer();
    apps.push(app);
    const account = privateKeyToAccount(generatePrivateKey());
    const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: account.address } });
    const signature = await account.signMessage({ message: n.json().message });
    const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: account.address, signature, chain: 'evm', message: n.json().message } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().chain).toBe('evm');
  });

  it('an EVM address is one account in any letter case: checksummed, lowercase and upper-case all sign in as the lowercase wallet', async () => {
    const { app } = await testServer();
    apps.push(app);
    const account = privateKeyToAccount(generatePrivateKey());
    const lower = account.address.toLowerCase();
    expect(account.address).not.toBe(lower); // viem reports the checksummed spelling
    for (const spelling of [account.address, lower, `0X${account.address.slice(2).toUpperCase()}`]) {
      const n = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: spelling } })).json();
      expect(n.wallet).toBe(lower);
      expect(n.message).toContain(lower);
      const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: spelling, signature: await account.signMessage({ message: n.message }), chain: 'evm', message: n.message } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().wallet).toBe(lower);
    }
    expect(app.ctx.db.prepare(`SELECT wallet FROM wallets`).all()).toEqual([{ wallet: lower }]);
    // a session issued before wallets were canonical (the old spelling in the token) is the same account
    const old = await signSession(app.ctx.env.JWT_SECRET, account.address, 'evm');
    expect((await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${old}` } })).json().wallet).toBe(lower);
    // admin tools that take a pasted address land on the same account too
    await app.inject({ method: 'POST', url: '/admin/prepaid', headers: ADMIN, payload: { wallet: account.address, amountUsd: 5, note: 'pasted checksummed' } });
    expect(prepaidBalanceMicros(app.ctx.db, lower)).toBe(5_000_000);
    // a key that is not an EVM address is case-sensitive and left as it is
    expect(canonicalWallet(' So1anaKeyIsCaseSensitive1111111111111111111 ')).toBe('So1anaKeyIsCaseSensitive1111111111111111111');
  });

  it('rate limits /auth/* per IP', async () => {
    const { app } = await testServer({ env: { AUTH_RATE_LIMIT: 3 } });
    apps.push(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'spam' } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'spam', signature: 'x' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited', statusCode: 429 });
    // other IPs unaffected
    const other = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'spam' }, remoteAddress: '10.9.9.9' });
    expect(other.statusCode).toBe(200);
  });
});
