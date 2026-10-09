import cron from 'node-cron';
import { recordError } from './db.js';
import { runEpoch } from './jobs/distribute.js';
import { runHousekeeping } from './jobs/housekeeping.js';
import { microsToUsd } from './money.js';
import { sampleConfigured } from './sample-data.js';
import { buildServer } from './server.js';

async function main() {
  const app = await buildServer();
  const { env, config, adapter, upstream } = app.ctx;

  if (env.EPOCH_CRON !== 'off') {
    if (!cron.validate(env.EPOCH_CRON)) throw new Error(`invalid EPOCH_CRON: ${env.EPOCH_CRON}`);
    cron.schedule(env.EPOCH_CRON, async () => {
      try {
        const r = await runEpoch(app.ctx);
        app.log.info(
          { epochStart: r.epochStart, status: r.status, feesUsd: microsToUsd(r.feesUsdMicros), holders: r.eligibleHolders },
          'epoch run',
        );
      } catch (err) {
        app.log.error({ err }, 'epoch run failed');
        // alerts.ts watches for this code (failed_sweep).
        recordError(app.ctx.db, { route: 'cron run-epoch', status: 500, code: 'epoch_failed', message: (err as Error).message ?? String(err) });
      }
      // Lapse credit past its window and read the reserve, whether or not the sweep went through.
      try {
        const h = await runHousekeeping(app.ctx);
        app.log.info({ nodePayoutWallets: h.nodePayoutWallets, nodePayoutUsd: microsToUsd(h.nodePayoutUsdMicros), expiredWallets: h.expiredWallets, expiredUsd: microsToUsd(h.expiredUsdMicros), reserve: h.reserveSource, reserveHeldUsd: h.reserveHeldUsdMicros === null ? null : microsToUsd(h.reserveHeldUsdMicros) }, 'housekeeping');
        for (const w of h.sweepWarnings) app.log.warn({ warning: w }, 'sweep left fees unswept');
      } catch (err) {
        app.log.error({ err }, 'housekeeping failed');
        recordError(app.ctx.db, { route: 'cron housekeeping', status: 500, code: 'housekeeping_failed', message: (err as Error).message ?? String(err) });
      }
    });
  }

  app.ctx.alerts?.start(env.ALERT_CHECK_INTERVAL_MS);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    {
      token: `${config.name} (${config.ticker})`,
      chain: config.chain,
      adapter: app.ctx.adapterStatus ?? env.MESH_ADAPTER,
      upstream: upstream.name,
      epochCron: env.EPOCH_CRON,
      db: env.MESH_DB_PATH,
      adapterChain: adapter.chain,
      alerts: app.ctx.alerts ? app.ctx.alerts.sender.name : 'off',
      nodesRequireSignature: env.NODES_REQUIRE_SIGNATURE ?? config.nodes.requireSignature,
    },
    'mesh gateway up',
  );
  // Test mode: say at startup whether it is in effect.
  if (env.MESH_SAMPLE_NODES > 0) {
    const active = sampleConfigured(app.ctx);
    if (active > 0) app.log.warn({ sampleNodes: active }, 'test mode: a signed-in operator sees simulated Macs added to the stats (MESH_SAMPLE_NODES); visitors get the real figures');
    else app.log.warn({ requested: env.MESH_SAMPLE_NODES }, 'MESH_SAMPLE_NODES is set but ignored: the gateway is on the live chain adapter');
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
