import { afterEach, describe, expect, it } from 'vitest';
import { sampleActivity, sampleConfigured, sampleFleet, sampleInfo, sampleMachines, sampleNodeCount } from '../src/sample-data.js';
import { ADMIN, testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];
const N = 254;
const NOW = 1_800_000_000;

/** A real node, registered the way the protocol tests do it (unsigned registration is on in TEST_ENV). */
async function registerNode(app: App) {
  const r = await app.inject({ method: 'POST', url: '/nodes/register', payload: { wallet: 'operator', chip: 'Apple M2', ramGb: 16, models: ['llama3.1:8b'], agentVersion: 'test' } });
  expect(r.statusCode).toBe(200);
}

describe('sample data (MESH_SAMPLE_NODES): test mode before the token launch', () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });
  const server = async (env: Record<string, unknown> = {}) => {
    const { app } = await testServer({ env });
    apps.push(app);
    return app;
  };
  /** The operator's view of the gateway: what a request with admin credentials is answered with. */
  const operatorView = (app: App) => Object.create(app.ctx, { sampleViewer: { value: true } }) as App['ctx'];
  const get = async (app: App, url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

  it('is off by default, for an operator too: no sample field, nothing added', async () => {
    const app = await server();
    expect(sampleConfigured(app.ctx)).toBe(0);
    for (const headers of [{}, ADMIN]) {
      const stats = (await get(app, '/stats', headers)).json();
      expect(stats.sample).toBeNull();
      expect(stats).toMatchObject({ nodesOnline: 0, requestsLast24h: 0, jobs24h: 0, networkTokens24h: 0, spendLast24hUsd: 0, creditsUsedUsd: 0 });
      expect((await get(app, '/nodes', headers)).json()).toMatchObject({ sample: null, online: 0, total: 0, chips: {}, models: {} });
      expect((await get(app, '/status', headers)).json()).toMatchObject({ sample: null, fleet: [], fleetOnline: 0 });
      expect((await get(app, '/report', headers)).json()).toMatchObject({ sample: null, nodeRewards: 0 });
    }
  });

  it('a signed-in operator sees N simulated Macs on top of the real count on every stats endpoint; nothing is written', async () => {
    const app = await server({ MESH_SAMPLE_NODES: N });
    await registerNode(app);
    const counts = `SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM requests_log) AS requests, (SELECT COUNT(*) FROM credits_ledger) AS ledger, (SELECT COUNT(*) FROM node_rewards) AS rewards`;
    const rowsBefore = app.ctx.db.prepare(counts).get();

    const res = await get(app, '/stats', ADMIN);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const stats = res.json();
    expect(stats.sample).toMatchObject({ nodes: N });
    expect(stats.nodesOnline).toBe(N + 1); // 254 + the actual number
    expect(stats.requestsLast24h).toBeGreaterThan(50_000);
    expect(stats.servedByNetwork24h).toBe(stats.jobs24h);
    expect(stats.servedByNetworkPercent).toBeGreaterThan(55);
    expect(stats.servedByNetworkPercent).toBeLessThan(70);
    expect(stats.networkTokens24h).toBeGreaterThan(stats.jobs24h * 1000);
    expect(stats.spendLast24hUsd).toBeGreaterThan(0);
    expect(stats.usageShareToHolders24hUsd).toBeGreaterThan(0);
    // the hourly chart adds up to the 24 h figure it sits under (the window and the buckets differ by under an hour)
    const charted = (stats.series24h as Array<{ requests: number }>).reduce((a, b) => a + b.requests, 0);
    expect(Math.abs(charted - stats.requestsLast24h) / stats.requestsLast24h).toBeLessThan(0.06);

    const nodes = (await get(app, '/nodes', ADMIN)).json();
    expect(nodes.sample).toMatchObject({ nodes: N });
    expect(nodes).toMatchObject({ online: N + 1, total: N + 1 });
    expect(Object.values(nodes.chips as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(N + 1);
    expect(nodes.models['llama3.1:8b']).toBe(N + 1); // every simulated Mac runs the first network model
    expect(nodes.idle + nodes.busy).toBe(N + 1);

    const status = (await get(app, '/status', ADMIN)).json();
    expect(status.fleetOnline).toBe(N + 1);
    expect(status.components.find((c: { key: string }) => c.key === 'network').detail).toBe(`${N + 1} of ${N + 1} registered Macs online (${N} simulated)`);
    expect(status.fleet).toHaveLength(200);
    expect(status.fleet.filter((f: { id: string }) => f.id.startsWith('sim_')).length).toBeGreaterThan(190);

    const report = (await get(app, '/report', ADMIN)).json();
    expect(report.sample).toMatchObject({ nodes: N });
    expect(report.nodeRewards).toBeGreaterThan(0);
    expect(report.last7d.requests).toBeGreaterThan(stats.requestsLast24h * 5);
    expect(report.totals.nodePayouts.paidUsd).toBeGreaterThan(0);
    expect(report.totals.nodePayouts.paidUsd + report.totals.nodePayouts.pendingUsd).toBeCloseTo(report.nodeRewards, 4);
    expect((await get(app, '/report/weekly/' + report.byWeek.at(-1).isoWeek, ADMIN)).json().sample).toMatchObject({ nodes: N });

    const models = (await get(app, '/v1/models', ADMIN)).json();
    expect(models.data.find((m: { id: string }) => m.id === 'llama-3.1-8b').online).toBe(N + 1);

    // the admin console's own numbers stay real, and it says the mode is on
    const overview = (await get(app, '/admin/overview', ADMIN)).json();
    expect(overview.sampleNodes).toBe(N);
    expect(overview.totals.requests).toBe(0);
    expect((await get(app, '/health')).json().sampleNodes).toBe(N);

    // nothing was written: the database holds the one real node and no simulated activity
    expect(app.ctx.db.prepare(counts).get()).toEqual(rowsBefore);
    expect(rowsBefore).toEqual({ nodes: 1, requests: 0, ledger: 0, rewards: 0 });
  });

  it('a visitor gets the real figures on the same URLs, before and after an operator has looked', async () => {
    const app = await server({ MESH_SAMPLE_NODES: N, STATS_CACHE_MS: 60_000 });
    await registerNode(app);
    const real = async () => {
      const res = await get(app, '/stats');
      expect(res.headers['cache-control']).toMatch(/^public/);
      expect(res.headers.vary).toMatch(/cookie/i);
      expect(res.json()).toMatchObject({ sample: null, nodesOnline: 1, requestsLast24h: 0, jobs24h: 0 });
      expect((await get(app, '/nodes')).json()).toMatchObject({ sample: null, online: 1, total: 1 });
      const status = (await get(app, '/status')).json();
      expect(status).toMatchObject({ sample: null, fleetOnline: 1 });
      expect(status.fleet.some((f: { id: string }) => f.id.startsWith('sim_'))).toBe(false);
      expect((await get(app, '/report')).json()).toMatchObject({ sample: null, nodeRewards: 0 });
      expect((await get(app, '/v1/models')).json().data.find((m: { id: string }) => m.id === 'llama-3.1-8b').online).toBe(1);
    };
    await real();
    // an operator looks at every page (their answers are not cached or shared)...
    for (const url of ['/stats', '/nodes', '/status', '/report']) expect((await get(app, url, ADMIN)).json().sample).toMatchObject({ nodes: N });
    // ...and the visitor still gets the real figures; so does a wrong admin token or an ordinary wallet session
    await real();
    expect((await get(app, '/stats', { 'x-admin-token': 'not-the-token' })).json()).toMatchObject({ sample: null, nodesOnline: 1 });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    expect((await get(app, '/stats', { authorization: `Bearer ${jwt}` })).json()).toMatchObject({ sample: null, nodesOnline: 1 });
  });

  it('the admin cookie from POST /admin/login is what a browser carries: with it the stats are the operator view', async () => {
    const app = await server({ MESH_SAMPLE_NODES: N });
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { token: ADMIN['x-admin-token'] } });
    expect(login.statusCode).toBe(200);
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    expect((await get(app, '/stats', { cookie })).json()).toMatchObject({ sample: { nodes: N }, nodesOnline: N });
    expect((await get(app, '/stats')).json()).toMatchObject({ sample: null, nodesOnline: 0 });
  });

  it('is ignored once the gateway is on the live chain adapter, for an operator too', async () => {
    const app = await server({ MESH_SAMPLE_NODES: N });
    app.ctx.adapterStatus = 'evm (pons)';
    expect(sampleConfigured(app.ctx)).toBe(0);
    expect(sampleNodeCount(operatorView(app))).toBe(0);
    expect(sampleInfo(operatorView(app))).toBeNull();
    const stats = (await get(app, '/stats', ADMIN)).json();
    expect(stats).toMatchObject({ sample: null, tokenLive: true, nodesOnline: 0, requestsLast24h: 0 });
    expect((await get(app, '/nodes', ADMIN)).json()).toMatchObject({ sample: null, online: 0 });
    expect((await get(app, '/health')).json().sampleNodes).toBe(0);
  });

  it('is deterministic: the same clock gives the same machines and the same activity, and windows add up', async () => {
    const app = await server({ MESH_SAMPLE_NODES: N });
    expect(sampleNodeCount(app.ctx)).toBe(0); // the gateway's own context never includes them
    expect(sampleActivity(app.ctx, NOW - 86_400, NOW, NOW).requests).toBe(0);
    const ctx = operatorView(app);
    expect(sampleNodeCount(ctx)).toBe(N);
    expect(sampleMachines(ctx, NOW)).toEqual(sampleMachines(ctx, NOW));
    expect(sampleMachines(ctx, NOW)).toHaveLength(N);
    expect(new Set(sampleMachines(ctx, NOW).map((m) => m.chip)).size).toBeGreaterThan(8);
    expect(sampleFleet(ctx, NOW).nodes).toBe(N);

    const day = sampleActivity(ctx, NOW - 86_400, NOW, NOW);
    expect(sampleActivity(ctx, NOW - 86_400, NOW, NOW)).toEqual(day);
    const halves = [sampleActivity(ctx, NOW - 86_400, NOW - 43_200, NOW), sampleActivity(ctx, NOW - 43_200, NOW, NOW)];
    expect(Math.abs(halves[0].requests + halves[1].requests - day.requests)).toBeLessThanOrEqual(1); // rounding only
    // a reward never exceeds the configured share of what the request was billed
    expect(day.rewardMicros).toBeLessThanOrEqual(day.spendMicros);
    // nothing in the future, nothing older than the 30-day history
    expect(sampleActivity(ctx, NOW, NOW + 86_400, NOW).requests).toBe(0);
    expect(sampleActivity(ctx, 0, NOW - 31 * 86_400, NOW).requests).toBe(0);
    expect(sampleActivity(ctx, 0, NOW, NOW).requests).toBe(sampleActivity(ctx, NOW - 30 * 86_400, NOW, NOW).requests);
  });
});
