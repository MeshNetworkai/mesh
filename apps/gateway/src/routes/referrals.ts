import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { nowSec } from '../db.js';
import { claimReferral, referralSummary, syncPoints, truncateWallet, type ClaimError } from '../points.js';

const CLAIM_ERRORS: Record<ClaimError, { status: number; message: string }> = {
  invalid_code: { status: 400, message: 'Referral codes are 6 letters or digits.' },
  unknown_code: { status: 404, message: 'No wallet has that referral code.' },
  self_referral: { status: 400, message: 'You cannot claim your own code.' },
  already_referred: { status: 409, message: 'This wallet already claimed a referral code.' },
  circular_referral: { status: 400, message: 'That wallet was referred by you; referrals cannot point both ways.' },
  disabled: { status: 403, message: 'The points programme is not enabled.' },
};

/** Where a referral link lands: the web app (first CORS origin) or, failing that, the auth URI. */
export function referralLinkBase(env: AppContext['env']): string {
  const origins = env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter((s) => s && s !== '*') ?? [];
  const base = origins[0] ?? env.AUTH_URI ?? `https://${env.AUTH_DOMAIN}`;
  return base.replace(/\/$/, '');
}

export function referralLink(env: AppContext['env'], code: string): string {
  return `${referralLinkBase(env)}/?ref=${encodeURIComponent(code)}`;
}

export async function referralRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = () => ctx.config.points;

  /** The signed-in wallet's code, share link and what it has earned from referrals. */
  app.get('/me/referral', { preHandler: requireSession(ctx) }, async (req) => {
    const { wallet } = sessionOf(req);
    syncPoints(ctx.db, cfg());
    const s = referralSummary(ctx.db, cfg(), wallet);
    return {
      wallet,
      code: s.code,
      link: referralLink(ctx.env, s.code),
      referred: s.referred,
      pointsEarned: s.pointsEarned,
      pointsFromSignups: s.pointsFromSignups,
      pointsFromShare: s.pointsFromShare,
      referredBy: s.referredBy ? truncateWallet(s.referredBy) : null,
      perReferralSignup: s.perReferralSignup,
      referralSharePercent: s.referralSharePercent,
      generatedAt: nowSec(),
    };
  });

  const ClaimBody = z.object({ code: z.string().min(1).max(32) });
  /** Bind the signed-in wallet to a referrer, once. */
  app.post(
    '/referrals/claim',
    { preHandler: requireSession(ctx), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = ClaimBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
      const { wallet } = sessionOf(req);
      const r = claimReferral(ctx.db, cfg(), { wallet, code: parsed.data.code });
      if (!r.ok) {
        const e = CLAIM_ERRORS[r.error];
        return reply.code(e.status).send({ error: r.error, message: e.message, statusCode: e.status });
      }
      return { wallet, referrer: truncateWallet(r.referrer), referrerPointsAwarded: r.pointsAwarded, sharePercent: cfg().referralShareBps / 100 };
    },
  );
}
