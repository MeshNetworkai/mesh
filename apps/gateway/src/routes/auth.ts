import { verifierFor, type Chain } from '@mesh/chain-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NONCE_TTL_SEC, SESSION_TTL_SEC, loginMessage, parseLoginMessage, signSession } from '../auth.js';
import { betaView, inviteRequired, isAdmitted, redeemInvite } from '../beta.js';
import { clearSessionCookies, resolveSession, setSessionCookies, type AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { ensureWallet } from '../ledger.js';
import { maybeGrantStarter } from '../starter.js';

/** Auth bodies are tiny; anything bigger is abuse. */
export const SMALL_BODY = 16 * 1024;

const NonceBody = z.object({ wallet: z.string().min(1).max(128) });
const VerifyBody = z.object({
  wallet: z.string().min(1).max(128),
  signature: z.string().min(1),
  chain: z.enum(['solana', 'evm']).optional(),
  /** Optional: the nonce from /auth/nonce (defaults to the newest live one for the wallet). */
  nonce: z.string().min(1).max(64).optional(),
  /** Optional: the exact message the wallet signed; must equal what the server issued. */
  message: z.string().max(2000).optional(),
  /** Beta: invite code for a wallet that has never been admitted (config.beta.inviteRequired). */
  invite: z.string().trim().min(1).max(64).optional(),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  // One shared per-IP bucket for every /auth/* route (the rate-limit plugin keeps a
  // counter per route, which would let a client multiply the budget by route count).
  const limiter = fixedWindowLimiter(ctx.env.AUTH_RATE_LIMIT, 60_000);
  const authLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = limiter.hit(req.ip);
    reply.header('x-ratelimit-limit', String(ctx.env.AUTH_RATE_LIMIT));
    reply.header('x-ratelimit-remaining', String(r.remaining));
    if (!r.allowed) {
      reply.header('retry-after', String(Math.ceil(r.resetMs / 1000)));
      reply.code(429).send({ error: 'rate_limited', message: 'Too many auth requests; retry in a minute.', statusCode: 429 });
      return reply;
    }
  };
  const domain = ctx.env.AUTH_DOMAIN;
  const uri = ctx.env.AUTH_URI;

  app.post('/auth/nonce', { preHandler: authLimit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = NonceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const issued = ctx.nonces.issue(parsed.data.wallet, domain);
    const message = loginMessage({ domain, uri, wallet: issued.wallet, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt });
    return {
      wallet: issued.wallet,
      nonce: issued.nonce,
      domain,
      issuedAt: new Date(issued.issuedAt * 1000).toISOString(),
      expiresAt: new Date(issued.expiresAt * 1000).toISOString(),
      expiresInSec: NONCE_TTL_SEC,
      message,
    };
  });

  app.post('/auth/verify', { preHandler: authLimit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, signature } = parsed.data;
    const chain: Chain = parsed.data.chain ?? ctx.adapter.chain;

    // If the client echoes the message, sanity-check its fields before touching the nonce
    // so a tampered domain/wallet gives a precise error rather than "bad signature".
    let nonceHint = parsed.data.nonce;
    if (parsed.data.message) {
      const fields = parseLoginMessage(parsed.data.message);
      if (!fields) return reply.code(400).send({ error: 'bad_message', message: 'message is not a Mesh sign-in message' });
      if (fields.domain !== domain) return reply.code(400).send({ error: 'domain_mismatch', message: `message domain must be ${domain}` });
      if (fields.wallet !== wallet) return reply.code(400).send({ error: 'wallet_mismatch', message: 'message wallet differs from request wallet' });
      if (nonceHint && fields.nonce !== nonceHint) return reply.code(400).send({ error: 'nonce_mismatch' });
      nonceHint = fields.nonce;
    }

    const issued = ctx.nonces.consume(wallet, nonceHint);
    if (!issued) {
      return reply.code(400).send({ error: 'nonce_missing', message: 'nonce missing, expired (5 min) or already used; request a new one' });
    }
    if (issued.domain !== domain) return reply.code(400).send({ error: 'domain_mismatch', message: `nonce was issued for ${issued.domain}` });

    const expected = loginMessage({ domain, uri, wallet, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt });
    if (parsed.data.message && parsed.data.message !== expected) {
      return reply.code(400).send({ error: 'message_mismatch', message: 'signed message differs from the issued one (issued-at or nonce altered)' });
    }

    // The active adapter verifies for its own chain; a different chain gets the
    // real verifier for that chain (so an EVM wallet can log in to a Solana-config gateway).
    const verify =
      chain === ctx.adapter.chain ? ctx.adapter.verifyWalletSignature.bind(ctx.adapter) : verifierFor(chain);
    if (!verify(wallet, expected, signature)) {
      return reply.code(401).send({ error: 'bad_signature', message: 'signature does not match the issued sign-in message' });
    }

    // ---- beta gate: the signature is good, but is this wallet allowed in yet? (docs/RUNBOOK.md) ----
    const beta = ctx.config.beta;
    if (inviteRequired(beta) && !isAdmitted(ctx.db, wallet)) {
      if (!parsed.data.invite) {
        return reply.code(403).send({ error: 'invite_required', message: `Mesh is in ${beta.label.toLowerCase()}: this wallet needs an invite code to sign in. Join the waitlist or enter your code.`, statusCode: 403, beta: betaView(beta) });
      }
      const r = redeemInvite(ctx.db, wallet, parsed.data.invite);
      if (!r.ok) {
        req.log.info({ wallet, reason: r.reason }, 'invite code rejected');
        return reply.code(403).send({ error: 'invite_invalid', message: r.reason === 'exhausted' ? 'This invite code has no uses left.' : 'Unknown invite code.', statusCode: 403, reason: r.reason, beta: betaView(beta) });
      }
      req.log.info({ wallet, code: r.code }, 'wallet admitted to the beta with an invite code');
    }

    ensureWallet(ctx.db, wallet, chain);
    ctx.db.prepare(`UPDATE wallets SET last_login = ? WHERE wallet = ?`).run(nowSec(), wallet);

    // ---- post-sign-in hook: starter credits on first connect (starter.ts, docs/SWITCHING.md) ----
    // Once per wallet, capped network-wide and per IP; a failure here must never fail the sign-in.
    let starter: { amountUsd: number; balanceUsd: number } | null = null;
    try {
      const r = await maybeGrantStarter(ctx, { wallet, chain, ip: req.ip });
      if (r.granted) {
        starter = { amountUsd: r.amountUsd, balanceUsd: r.balanceUsd };
        req.log.info({ wallet, amountUsd: r.amountUsd, ledgerId: r.ledgerId }, 'starter credit granted on first sign-in');
      } else if (r.reason !== 'already_granted' && r.reason !== 'disabled') {
        req.log.info({ wallet, reason: r.reason }, 'starter credit skipped');
      }
    } catch (err) {
      req.log.warn({ err, wallet }, 'starter credit grant failed; sign-in continues');
    }

    const token = await signSession(ctx.env.JWT_SECRET, wallet, chain);
    // Browser clients get the session as an HttpOnly cookie (+ CSRF cookie); API clients keep using the token.
    const csrf = setSessionCookies(ctx.env, reply, token);
    return { token, wallet, chain, expiresIn: '7d', expiresInSec: SESSION_TTL_SEC, csrf, admitted: !inviteRequired(beta) || isAdmitted(ctx.db, wallet), starter };
  });

  /** Exchange a valid (unexpired) session (bearer or cookie) for a fresh 7-day one; re-sets the cookies. */
  app.post('/auth/refresh', { preHandler: authLimit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    const session = await resolveSession(ctx, req);
    if (!session) return reply.code(401).send({ error: 'unauthorized', message: 'valid session token required' });
    const fresh = await signSession(ctx.env.JWT_SECRET, session.wallet, session.chain);
    const csrf = setSessionCookies(ctx.env, reply, fresh);
    return { token: fresh, wallet: session.wallet, chain: session.chain, expiresIn: '7d', expiresInSec: SESSION_TTL_SEC, csrf };
  });

  /** Who am I (cookie or bearer)? The web app calls this on boot instead of keeping the JWT around. */
  app.get('/auth/session', async (req, reply) => {
    const session = await resolveSession(ctx, req);
    if (!session) return reply.code(401).send({ error: 'unauthorized', message: 'no session' });
    return { wallet: session.wallet, chain: session.chain, exp: session.exp ?? null, via: session.via };
  });

  /** Clears the session + CSRF cookies. JWTs are stateless, so a bearer client simply discards its token. */
  app.post('/auth/logout', { bodyLimit: SMALL_BODY }, async (_req, reply) => {
    clearSessionCookies(ctx.env, reply);
    return { ok: true };
  });
}

/** Minimal fixed-window counter keyed by string (IP). Single-instance; fine behind one gateway. */
export function fixedWindowLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; windowStart: number }>();
  return {
    hit(key: string, now = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
      let e = hits.get(key);
      if (!e || now - e.windowStart >= windowMs) {
        e = { n: 0, windowStart: now };
        hits.set(key, e);
        if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.windowStart >= windowMs) hits.delete(k);
      }
      e.n += 1;
      return { allowed: e.n <= max, remaining: Math.max(0, max - e.n), resetMs: e.windowStart + windowMs - now };
    },
  };
}
