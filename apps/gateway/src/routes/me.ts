import type { FastifyInstance } from 'fastify';
import { listApiKeys, publicKeyView } from '../auth.js';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { expireWallet, expiryOutlook, nonTransferableMicros } from '../expiry.js';
import { balanceMicros, nodeRewardsTotal, recentLedger } from '../ledger.js';
import { microsToUsd } from '../money.js';
import { walletHold } from '../reserve.js';
import type { NodeRow } from '../routing.js';
import { walletSavings } from '../savings.js';
import { nodeStatsView } from './nodes.js';

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/me', { preHandler: requireSession(ctx) }, async (req) => {
    const { wallet, chain } = sessionOf(req);
    expireWallet(ctx.db, wallet, ctx.config.creditExpiry, undefined, ctx.reservations.reserved(walletHold(wallet)));
    const micros = balanceMicros(ctx.db, wallet);
    const locked = ctx.config.starterCredits.transferable ? 0 : nonTransferableMicros(ctx.db, wallet);
    return {
      wallet,
      chain,
      balance: { usd: microsToUsd(micros), usdMicros: micros },
      /** Credit expiry (docs/PRICING.md §6): what lapses next and how much of the balance is inside its last 7 / 30 days. */
      expiry: expiryOutlook(ctx.db, wallet, ctx.config.creditExpiry),
      /** Unused starter credit: spendable on requests, not sellable on the marketplace (0 when starter credit is transferable). */
      nonTransferableUsd: microsToUsd(locked),
      ledger: recentLedger(ctx.db, wallet, 20).map((r) => ({
        id: r.id,
        kind: r.kind,
        deltaUsd: microsToUsd(r.delta_usd_micros),
        deltaUsdMicros: r.delta_usd_micros,
        ref: r.ref,
        created_at: r.created_at,
      })),
      apiKeys: listApiKeys(ctx.db, wallet).map(publicKeyView),
      /** Network credits: what this wallet saved because Mesh nodes served its requests. */
      savings: walletSavings(ctx.db, wallet),
    };
  });

  /** Nodes registered under this wallet, with the same stats as GET /nodes/:id. */
  app.get('/me/nodes', { preHandler: requireSession(ctx) }, async (req) => {
    const { wallet } = sessionOf(req);
    const rows = ctx.db.prepare(`SELECT * FROM nodes WHERE wallet = ? ORDER BY last_seen DESC`).all(wallet) as NodeRow[];
    const total = nodeRewardsTotal(ctx.db, { wallet });
    return {
      wallet,
      nodes: rows.map((n) => nodeStatsView(ctx, n)),
      earnedUsdTotal: microsToUsd(total.usdMicros),
      rewardUsdPerMTokens: ctx.config.nodeRewards.usdPerMTokens,
    };
  });
}
