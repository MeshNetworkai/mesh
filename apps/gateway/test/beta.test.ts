import { MockAdapter } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { generateInviteCode, normalizeInviteCode } from '../src/beta.js';
import { ADMIN, testConfig, testServer } from './helpers.js';

/** Public beta gating (beta.ts, routes/auth.ts, routes/waitlist.ts, routes/admin.ts). */
const betaConfig: TokenomicsConfig = { ...testConfig, beta: { enabled: true, label: 'Beta', inviteRequired: true, batchSize: 2 } };

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(config = betaConfig) {
  const { app } = await testServer({ config, env: { WAITLIST_RATE_LIMIT: 1000 } });
  apps.push(app);
  /** Full signed sign-in for `wallet`, optionally with an invite code. */
  const signIn = async (wallet: string, invite?: string) => {
    const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet } });
    const { message } = n.json();
    return app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature: MockAdapter.sign(wallet, message), message, ...(invite ? { invite } : {}) } });
  };
  return { app, signIn };
}

describe('beta: invite codes', () => {
  it('codes are 10 chars without 0/O/1/I and normalise case + separators', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(normalizeInviteCode(code.toLowerCase().replace('-', ' '))).toBe(code);
    expect(normalizeInviteCode('abcde fghjk')).toBe('ABCDE-FGHJK');
    expect(normalizeInviteCode('short')).toBe('SHORT');
  });

  it('stats + overview expose the beta flag; /auth/verify without a code → 403 invite_required, bad code → invite_invalid, valid code admits once and is consumed', async () => {
    const { app, signIn } = await boot();
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats.beta).toEqual({ enabled: true, label: 'Beta', inviteRequired: true });

    const denied = await signIn('wallet_a');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'invite_required', beta: { enabled: true, inviteRequired: true } });
    expect(denied.headers['set-cookie']).toBeUndefined();

    const bad = await signIn('wallet_a', 'NOPE-NOPE');
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ error: 'invite_invalid', reason: 'invalid' });

    // Admin mints one code with 2 uses.
    const minted = await app.inject({ method: 'POST', url: '/admin/invites', headers: ADMIN, payload: { count: 1, uses: 2 } });
    expect(minted.statusCode).toBe(200);
    const [code] = minted.json().codes as string[];
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const ok = await signIn('wallet_a', code.toLowerCase());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ wallet: 'wallet_a', admitted: true });
    expect(ok.headers['set-cookie']).toBeDefined();
    // Admitted for good: the next sign-in needs no code, and the code is not consumed again.
    expect((await signIn('wallet_a')).statusCode).toBe(200);
    expect((await signIn('wallet_a', code)).statusCode).toBe(200);
    expect((app.ctx.db.prepare(`SELECT uses_left FROM invite_codes WHERE code = ?`).get(code) as { uses_left: number }).uses_left).toBe(1);

    // Second use goes to another wallet; a third wallet finds it exhausted.
    expect((await signIn('wallet_b', code)).statusCode).toBe(200);
    const exhausted = await signIn('wallet_c', code);
    expect(exhausted.statusCode).toBe(403);
    expect(exhausted.json()).toMatchObject({ error: 'invite_invalid', reason: 'exhausted' });

    const ov = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json();
    expect(ov.beta).toMatchObject({ enabled: true, inviteRequired: true, batchSize: 2, admitted: 2, liveCodes: 0 });
    expect(app.ctx.db.prepare(`SELECT action FROM admin_actions WHERE action = 'invites'`).all()).toHaveLength(1);
  });

  it('node registration requires an admitted reward wallet; dev-login admits (demo/e2e); /admin/admit admits by hand', async () => {
    const { app } = await boot();
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'operator', models: ['llama3.1:8b'] } });
    expect(reg.statusCode).toBe(403);
    expect(reg.json().error).toBe('invite_required');

    expect((await app.inject({ method: 'POST', url: '/admin/admit', headers: ADMIN, payload: { wallet: 'operator' } })).json()).toMatchObject({ admitted: true });
    expect((await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'operator', models: ['llama3.1:8b'] } })).statusCode).toBe(200);

    const dev = await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'dev_wallet' } });
    expect(dev.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'dev_wallet', models: ['llama3.1:8b'] } })).statusCode).toBe(200);
  });

  it('beta off (or inviteRequired false): everything is open and the waitlist is closed', async () => {
    const { app, signIn } = await boot({ ...betaConfig, beta: { ...betaConfig.beta, inviteRequired: false } });
    expect((await signIn('anyone')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/stats' })).json().beta).toEqual({ enabled: true, label: 'Beta', inviteRequired: false });
    const { app: off } = await boot({ ...betaConfig, beta: { ...betaConfig.beta, enabled: false } });
    expect((await off.inject({ method: 'POST', url: '/waitlist', payload: { email: 'a@b.co' } })).statusCode).toBe(404);
    expect((await off.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'anyone', models: ['llama3.1:8b'] } })).statusCode).toBe(200);
  });
});

describe('beta: waitlist', () => {
  it('POST /waitlist takes a wallet or an e-mail, is idempotent, validates, rate-limits per IP; admin lists and admits the oldest n with one-use codes', async () => {
    const { app, signIn } = await boot();
    expect((await app.inject({ method: 'POST', url: '/waitlist', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/waitlist', payload: { email: 'not-an-email' } })).statusCode).toBe(400);

    const first = await app.inject({ method: 'POST', url: '/waitlist', payload: { email: 'First@Example.com' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, position: 1, alreadyListed: false, beta: { enabled: true } });
    const second = await app.inject({ method: 'POST', url: '/waitlist', payload: { wallet: 'wallet_second' } });
    expect(second.json()).toMatchObject({ position: 2, alreadyListed: false });
    const third = await app.inject({ method: 'POST', url: '/waitlist', payload: { email: 'third@example.com' } });
    expect(third.json()).toMatchObject({ position: 3 });
    // Same e-mail (different case) is the same entry.
    expect((await app.inject({ method: 'POST', url: '/waitlist', payload: { email: 'first@example.com' } })).json()).toMatchObject({ position: 1, alreadyListed: true });

    const list = (await app.inject({ method: 'GET', url: '/admin/waitlist', headers: ADMIN })).json();
    expect(list.counts).toMatchObject({ total: 3, waiting: 3, invited: 0, admitted: 0 });
    expect(list.entries.map((e: { email: string | null; wallet: string | null }) => e.email ?? e.wallet)).toEqual(['first@example.com', 'wallet_second', 'third@example.com']);
    expect(list.entries[0].code).toBeNull();

    // Admit the default batch (batchSize 2): oldest two get codes; the wallet entry is admitted directly.
    const admitted = await app.inject({ method: 'POST', url: '/admin/waitlist/admit', headers: ADMIN, payload: {} });
    expect(admitted.statusCode).toBe(200);
    const body = admitted.json();
    expect(body).toMatchObject({ requested: 2, admitted: 2, counts: { waiting: 1, invited: 2, admitted: 1 } });
    const [e1, e2] = body.entries as Array<{ email: string | null; wallet: string | null; code: string }>;
    expect(e1.email).toBe('first@example.com');
    expect(e1.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(e2.wallet).toBe('wallet_second');
    // The e-mail entry's code admits exactly one wallet (we send it; delivery is out of scope).
    expect((await signIn('mail_user', e1.code)).statusCode).toBe(200);
    expect((await signIn('freeloader', e1.code)).json()).toMatchObject({ error: 'invite_invalid', reason: 'exhausted' });
    // The waitlisted wallet signs in without typing anything.
    expect((await signIn('wallet_second')).statusCode).toBe(200);
    expect((await signIn('third_user')).statusCode).toBe(403);
    // Admitting again takes the remaining entry; a further call admits nothing.
    expect((await app.inject({ method: 'POST', url: '/admin/waitlist/admit', headers: ADMIN, payload: { n: 5 } })).json()).toMatchObject({ admitted: 1, counts: { waiting: 0 } });
    expect((await app.inject({ method: 'POST', url: '/admin/waitlist/admit', headers: ADMIN, payload: { n: 5 } })).json()).toMatchObject({ admitted: 0 });
    const waiting = (await app.inject({ method: 'GET', url: '/admin/waitlist?status=waiting', headers: ADMIN })).json();
    expect(waiting.entries).toHaveLength(0);
    // The waitlist row remembers which wallet redeemed the e-mail code.
    expect((app.ctx.db.prepare(`SELECT wallet FROM waitlist WHERE email = 'first@example.com'`).get() as { wallet: string }).wallet).toBe('mail_user');

    // Public: no admin token → 401; rate limit on the public endpoint.
    expect((await app.inject({ method: 'GET', url: '/admin/waitlist' })).statusCode).toBe(401);
    const { app: tight } = await testServer({ config: betaConfig, env: { WAITLIST_RATE_LIMIT: 2 } });
    apps.push(tight);
    expect((await tight.inject({ method: 'POST', url: '/waitlist', payload: { email: 'a@b.co' } })).statusCode).toBe(200);
    expect((await tight.inject({ method: 'POST', url: '/waitlist', payload: { email: 'c@d.co' } })).statusCode).toBe(200);
    const limited = await tight.inject({ method: 'POST', url: '/waitlist', payload: { email: 'e@f.co' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
