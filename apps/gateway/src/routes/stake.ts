import type { FastifyInstance } from 'fastify';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { StakeResolver } from '../staking.js';

/** Staking contract address the active adapter is wired to (EVM `staking` in the deploy json), else null. */
export function stakingContractOf(ctx: Pick<AppContext, 'adapter'>): string | null {
  const opts = (ctx.adapter as { opts?: { staking?: string } }).opts;
  return typeof opts?.staking === 'string' ? opts.staking : null;
}

export function stakeResolverOf(ctx: AppContext): StakeResolver {
  if (!ctx.stakes) ctx.stakes = new StakeResolver({ adapter: ctx.adapter, config: ctx.config });
  return ctx.stakes;
}

export async function stakeRoutes(app: FastifyInstance, ctx: AppContext) {
  const stakes = stakeResolverOf(ctx);

  /** Public: the tier table from config/tokenomics.json plus where staking lives. */
  app.get('/stake/tiers', async () => ({
    chain: ctx.config.chain,
    ticker: ctx.config.ticker,
    tiers: stakes.tiers(),
    /** True when the gateway can read positions (contract deployed + configured). */
    available: stakes.available,
    contract: stakingContractOf(ctx),
    epochSeconds: ctx.config.epochSeconds,
  }));

  /** Session: this wallet's position and tier, cached for the epoch. */
  app.get('/me/stake', { preHandler: requireSession(ctx) }, async (req) => {
    const { wallet } = sessionOf(req);
    const s = await stakes.resolve(wallet);
    return {
      wallet,
      staked: s.staked,
      tier: s.tier,
      tierIndex: s.tierIndex,
      multiplier: s.multiplier,
      lockDays: s.lockDays,
      lockEndsAt: s.lockEndsAt,
      nextTier: s.nextTier,
      available: s.available,
      contract: stakingContractOf(ctx),
      epoch: s.epoch,
    };
  });
}
