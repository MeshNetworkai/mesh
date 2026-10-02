import type { FastifyInstance } from 'fastify';
import { listApiKeys, publicKeyView } from '../auth.js';
import { requireSession, sessionOf, type AppContext } from '../context.js';
import { balanceMicros, nodeRewardsTotal, recentLedger } from '../ledger.js';
import { microsToUsd } from '../money.js';
import type { NodeRow } from '../routing.js';
import { walletSavings } from '../savings.js';
import { nodeStatsView } from './nodes.js';

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/me', { preHandler: requireSession(ctx) }, async (req) => {
    const { wallet, chain } = sessionOf(req);
    const micros = balanceMicros(ctx.db, wallet);
    return {
      wallet,
      chain,
      balance: { usd: microsToUsd(micros), usdMicros: micros },
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
