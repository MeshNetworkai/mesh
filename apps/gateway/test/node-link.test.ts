import { MockAdapter } from '@mesh/chain-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/db.js';
import { LINK_CODE_ALPHABET, LINK_CODE_TTL_SEC, hashLinkCode, normalizeLinkCode } from '../src/routes/nodes.js';
import { ADMIN, memDb, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** Signed gateway (config default), as in production. */
async function signedServer(env: Record<string, unknown> = {}) {
  const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined, ...env } });
  apps.push(app);
  return app;
}

const login = async (app: App, wallet: string) => (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token as string;

/** Browser side: challenge → wallet signs → POST /nodes/link. */
async function link(app: App, wallet: string, opts: { signer?: string; jwtWallet?: string } = {}) {
  const jwt = await login(app, opts.jwtWallet ?? wallet);
  const ch = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet } });
  expect(ch.statusCode).toBe(200);
  const { nonce, message } = ch.json();
  return app.inject({
    method: 'POST',
    url: '/nodes/link',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { nonce, signature: MockAdapter.sign(opts.signer ?? wallet, message), chain: 'solana' },
  });
}

const registerWith = (app: App, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/nodes/register', payload: { chip: 'M3 Max', ramGb: 64, models: ['llama3.1:8b'], agentVersion: '0.3.0', ...body }, headers });

describe('node link codes', () => {
  it('happy path: browser links, Mac registers with the code and no wallet; code is bound to the signer', async () => {
    const app = await signedServer();
    const linked = await link(app, 'mockwallet_bob');
    expect(linked.statusCode).toBe(200);
    const { code, expiresAt, expiresInSec, wallet } = linked.json();
    expect(wallet).toBe('mockwallet_bob');
    expect(code).toHaveLength(8);
    for (const ch of code) expect(LINK_CODE_ALPHABET).toContain(ch);
    expect(expiresInSec).toBe(LINK_CODE_TTL_SEC);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // The agent sends the code with a dash and in lower case; the gateway normalises it.
    const reg = await registerWith(app, { linkCode: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    expect(body.wallet).toBe('mockwallet_bob');
    expect(body.walletVerified).toBe(true);
    expect(body.linked).toBe(true);
    expect(body.nodeToken).toMatch(/^mesh_nt_/);

    // The node shows up under bob's wallet.
    const jwt = await login(app, 'mockwallet_bob');
    const mine = await app.inject({ method: 'GET', url: '/me/nodes', headers: { authorization: `Bearer ${jwt}` } });
    expect(mine.json().nodes.map((n: { nodeId: string }) => n.nodeId)).toContain(body.nodeId);
    // The node token works and the stats view reports the linked wallet.
    const stats = await app.inject({ method: 'GET', url: `/nodes/${body.nodeId}`, headers: { authorization: `Bearer ${body.nodeToken}` } });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().wallet).toBe('mockwallet_bob');
  });

  it('a code is single use: the second register with it is 400 link_code_used', async () => {
    const app = await signedServer();
    const { code } = (await link(app, 'mockwallet_bob')).json();
    expect((await registerWith(app, { linkCode: code })).statusCode).toBe(200);
    const again = await registerWith(app, { linkCode: code });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('link_code_used');
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json().total).toBe(1);
  });

  it('an expired code is 400 link_code_expired; an unknown one is link_code_invalid', async () => {
    const db = memDb();
    const { app } = await testServer({ env: { NODES_REQUIRE_SIGNATURE: undefined }, context: { db } });
    apps.push(app);
    const { code } = (await link(app, 'mockwallet_bob')).json();
    // age the code past its 15-minute window
    db.prepare(`UPDATE node_link_codes SET expires_at = ? WHERE code_hash = ?`).run(nowSec() - 1, hashLinkCode(code));
    const late = await registerWith(app, { linkCode: code });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe('link_code_expired');
    const unknown = await registerWith(app, { linkCode: 'ZZZZZZZZ' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('link_code_invalid');
    expect((await app.inject({ method: 'GET', url: '/nodes' })).json().total).toBe(0);
  });

  it('wrong wallet: the signature must come from the signed-in wallet, and --wallet must match the code', async () => {
    const app = await signedServer();
    // mallory signs bob's challenge
    const forged = await link(app, 'mockwallet_bob', { signer: 'mallory' });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe('bad_signature');
    // bob's session cannot link a challenge issued to another wallet (nonce is bound to the wallet)
    const crossed = await link(app, 'mallory', { jwtWallet: 'mockwallet_bob' });
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json().error).toBe('nonce_missing');
    // a valid code used with an explicit, different wallet is refused and stays unused
    const { code } = (await link(app, 'mockwallet_bob')).json();
    const mismatch = await registerWith(app, { linkCode: code, wallet: 'mallory' });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('link_code_wallet_mismatch');
    const ok = await registerWith(app, { linkCode: code, wallet: 'mockwallet_bob' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().wallet).toBe('mockwallet_bob');
  });

  it('requires a session, a valid registration nonce, and is rate limited per IP and per wallet', async () => {
    const app = await signedServer({ NODE_REGISTER_RATE_LIMIT: 4 });
    expect((await app.inject({ method: 'POST', url: '/nodes/link', payload: { nonce: 'x', signature: 'y' } })).statusCode).toBe(401);
    const jwt = await login(app, 'mockwallet_bob');
    // a /auth nonce is not a registration challenge
    const authNonce = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'mockwallet_bob' } })).json();
    const wrongDomain = await app.inject({ method: 'POST', url: '/nodes/link', headers: { authorization: `Bearer ${jwt}` }, payload: { nonce: authNonce.nonce, signature: MockAdapter.sign('mockwallet_bob', authNonce.message) } });
    expect(wrongDomain.statusCode).toBe(400);
    expect(wrongDomain.json().error).toBe('nonce_missing');
    // /nodes/link shares the per-IP registration budget with /challenge (1 link call so far → 2 challenges + 1 link = 3 of 4)
    expect((await link(app, 'mockwallet_bob')).statusCode).toBe(200);
    const limited = await app.inject({ method: 'POST', url: '/nodes/register/challenge', payload: { wallet: 'mockwallet_bob' } });
    expect(limited.statusCode).toBe(429);
  });

  it('caps live codes per wallet; an unsigned register still fails on a signed gateway', async () => {
    const app = await signedServer();
    for (let i = 0; i < 5; i++) expect((await link(app, 'mockwallet_bob')).statusCode).toBe(200);
    const sixth = await link(app, 'mockwallet_bob');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too_many_link_codes');
    const unsigned = await registerWith(app, { wallet: 'mockwallet_bob' });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error).toBe('signature_required');
    const neither = await registerWith(app, {});
    expect(neither.statusCode).toBe(400);
  });

  it('re-registering a stored nodeId with a link code still needs the node token, and the code survives the refusal', async () => {
    const app = await signedServer();
    const { code } = (await link(app, 'mockwallet_bob')).json();
    const first = await registerWith(app, { linkCode: code, nodeId: 'mac-1' });
    expect(first.statusCode).toBe(200);
    const { code: code2 } = (await link(app, 'mockwallet_bob')).json();
    const noToken = await registerWith(app, { linkCode: code2, nodeId: 'mac-1' });
    expect(noToken.statusCode).toBe(409);
    expect(noToken.json().error).toBe('node_exists');
    const withToken = await registerWith(app, { linkCode: code2, nodeId: 'mac-1' }, { authorization: `Bearer ${first.json().nodeToken}` });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json().nodeToken).not.toBe(first.json().nodeToken);
  });

  it('legacy unsigned flow still works when NODES_REQUIRE_SIGNATURE=false and reports wallet', async () => {
    const { app } = await testServer();
    apps.push(app);
    const r = await registerWith(app, { wallet: 'mockwallet_bob' });
    expect(r.statusCode).toBe(200);
    expect(r.json().wallet).toBe('mockwallet_bob');
    expect(r.json().walletVerified).toBe(false);
    expect(r.json().linked).toBe(false);
  });

  it('normalises and hashes codes consistently', () => {
    expect(normalizeLinkCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeLinkCode(' abcd efgh ')).toBe('ABCDEFGH');
    expect(hashLinkCode('abcd-efgh')).toBe(hashLinkCode('ABCDEFGH'));
    expect(hashLinkCode('ABCDEFGH')).not.toBe(hashLinkCode('ABCDEFGJ'));
  });
});
