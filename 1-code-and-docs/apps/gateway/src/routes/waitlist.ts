import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canonicalWallet } from '../auth.js';
import { EMAIL_RE, betaView, joinWaitlist } from '../beta.js';
import type { AppContext } from '../context.js';
import { SMALL_BODY, fixedWindowLimiter } from './auth.js';

const JoinBody = z
  .object({
    wallet: z.string().trim().min(8).max(128).transform(canonicalWallet).optional(),
    email: z.string().trim().max(254).regex(EMAIL_RE, 'not an e-mail address').optional(),
  })
  .refine((b) => Boolean(b.wallet || b.email), { message: 'wallet or email is required' });

/** Public waitlist for the beta (docs/RUNBOOK.md "Public beta rollout"). */
export async function waitlistRoutes(app: FastifyInstance, ctx: AppContext) {
  const limiter = fixedWindowLimiter(ctx.env.WAITLIST_RATE_LIMIT, 60_000);
  const limit = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = limiter.hit(req.ip);
    reply.header('x-ratelimit-limit', String(ctx.env.WAITLIST_RATE_LIMIT));
    reply.header('x-ratelimit-remaining', String(r.remaining));
    if (!r.allowed) {
      reply.header('retry-after', String(Math.ceil(r.resetMs / 1000)));
      reply.code(429).send({ error: 'rate_limited', message: 'Too many waitlist requests; retry in a minute.', statusCode: 429 });
      return reply;
    }
  };

  app.post('/waitlist', { preHandler: limit, bodyLimit: SMALL_BODY }, async (req, reply) => {
    if (!ctx.config.beta.enabled) return reply.code(404).send({ error: 'not_found', message: 'the beta waitlist is closed', statusCode: 404 });
    const parsed = JoinBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const r = joinWaitlist(ctx.db, parsed.data);
    req.log.info({ id: r.id, position: r.position, alreadyListed: r.alreadyListed, hasWallet: Boolean(parsed.data.wallet), hasEmail: Boolean(parsed.data.email) }, 'waitlist join');
    return { ok: true, position: r.position, alreadyListed: r.alreadyListed, beta: betaView(ctx.config.beta) };
  });
}
