import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { depositsInfo } from '../deposits.js';
import { buyCredits, directSalesTotals } from '../direct-sales.js';
import { balanceMicros } from '../ledger.js';
import { MarketError, prepaidBalanceMicros } from '../market.js';
import { microsToUsd, usdToMicros } from '../money.js';

const BuyBody = z.object({ amountUsd: z.number().positive().max(1_000_000) });

/**
 * Direct credit sales (direct-sales.ts, docs/PRICING.md §7): buy credits from Mesh at face value with the
 * prepaid USD balance.
 *
 *   GET  /credits/config   public: is it on, the limits, the price, how the prepaid balance is funded
 *   POST /me/credits/buy   { amountUsd } → the purchase and both balances
 */
export async function creditsRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = ctx.config.directSales;
  const auth = requireSession(ctx);
  const gate = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (cfg.enabled) return;
    reply.code(404).send({ error: 'not_found', message: 'direct credit sales are disabled', statusCode: 404 });
    return reply;
  };

  app.get('/credits/config', { onRequest: gate, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async () => {
    const t = directSalesTotals(ctx.db);
    return {
      enabled: cfg.enabled,
      /** USD paid per $1 of credit: always face value. */
      pricePerUsd: 1,
      minUsd: cfg.minUsd,
      maxUsd: cfg.maxUsd,
      settlement: 'prepaid' as const,
      deposits: depositsInfo(ctx.config.marketplace.deposits),
      /** Days after which bought credit lapses, or null when credits do not expire. */
      creditExpiryDays: ctx.config.creditExpiry.enabled ? ctx.config.creditExpiry.days : null,
      soldUsd: microsToUsd(t.soldMicros),
      purchases: t.purchases,
    };
  });

  app.post('/me/credits/buy', { onRequest: gate, preHandler: auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = BuyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, chain } = sessionOf(req);
    try {
      const p = buyCredits(ctx.db, cfg, { wallet, chain, amountMicros: usdToMicros(parsed.data.amountUsd) });
      req.log.info({ wallet, creditsUsd: microsToUsd(p.creditsMicros) }, 'credits bought directly');
      return reply.code(201).send({
        id: p.id,
        creditsUsd: microsToUsd(p.creditsMicros),
        paidUsd: microsToUsd(p.paidMicros),
        created_at: p.createdAt,
        expires_at: ctx.config.creditExpiry.enabled ? p.createdAt + ctx.config.creditExpiry.days * 86_400 : null,
        creditBalanceUsd: microsToUsd(balanceMicros(ctx.db, wallet)),
        prepaidBalanceUsd: microsToUsd(prepaidBalanceMicros(ctx.db, wallet)),
      });
    } catch (err) {
      if (err instanceof MarketError) return reply.code(err.status).send({ error: err.code, message: err.message, statusCode: err.status });
      throw err;
    }
  });
}
