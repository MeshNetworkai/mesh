#!/usr/bin/env node
/**
 * Mesh relay load test: gateway + N fake nodes + M concurrent chat requests, all in one process
 * (plus the gateway child). No Ollama, no OpenRouter, no chain: the gateway runs with the mock
 * adapter and the offline mock upstream, nodes register unsigned (NODES_REQUIRE_SIGNATURE=false)
 * and answer every job with a fake stream of TOKENS chunks. Spot-check verification is off
 * (VERIFICATION_ENABLED=false) so the job count is exactly the request count.
 *
 *   node scripts/loadtest/relay.mjs                      # N=20 nodes, M=200 requests
 *   N=50 M=1000 node scripts/loadtest/relay.mjs
 *   node scripts/loadtest/relay.mjs --nodes 20 --requests 200 --tokens 300 --json out.json
 *
 * Options (flag or env):
 *   --nodes N          NODES          fake nodes to register                       (20)
 *   --parallel P       PARALLEL       maxParallel each fake node advertises and serves at once (1)
 *   --requests M       REQUESTS       chat requests to fire                        (200)
 *   --concurrency C    CONCURRENCY    max in-flight client requests (default: M, i.e. all at once)
 *   --tokens T         TOKENS         completion chunks each node streams per job  (300)
 *   --chunk-delay ms   CHUNK_DELAY_MS pause between chunks on the node side        (0)
 *   --model name       MODEL          client-facing model; must be a networkModels key (mesh/mock)
 *   --port P           PORT           gateway port                                 (8798)
 *   --log-level L      LOG_LEVEL      gateway pino level                           (warn)
 *   --gateway URL      GATEWAY_URL    use an already-running gateway instead of spawning one
 *   --admin-token T    ADMIN_TOKEN    admin token for that gateway                 (loadtest-admin)
 *   --json FILE                       also write the full result object to FILE
 *
 * Output: p50 / p95 / p99 first-token latency and total latency, route split (node vs upstream
 * fallback and why), throughput, failures, per-node job counts, gateway-side job table summary.
 * Exit code 1 when any request failed, so it can gate a CI job.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// ---------------------------------------------------------------------------- options
const argv = process.argv.slice(2);
const flag = (name, env, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  if (env && process.env[env] !== undefined && process.env[env] !== '') return process.env[env];
  return def;
};
const num = (v) => Number(v);
const opts = {
  nodes: num(flag('nodes', 'NODES', process.env.N ?? 20)),
  parallel: num(flag('parallel', 'PARALLEL', 1)),
  requests: num(flag('requests', 'REQUESTS', process.env.M ?? 200)),
  tokens: num(flag('tokens', 'TOKENS', 300)),
  chunkDelayMs: num(flag('chunk-delay', 'CHUNK_DELAY_MS', 0)),
  model: flag('model', 'MODEL', 'mesh/mock'),
  port: num(flag('port', 'PORT', 8798)),
  logLevel: flag('log-level', 'LOG_LEVEL', 'warn'),
  gateway: flag('gateway', 'GATEWAY_URL', null),
  adminToken: flag('admin-token', 'ADMIN_TOKEN', 'loadtest-admin'),
  json: flag('json', null, null),
};
opts.concurrency = num(flag('concurrency', 'CONCURRENCY', opts.requests));
if (!Number.isInteger(opts.parallel) || opts.parallel < 1) {
  console.error(`--parallel must be a whole number >= 1 (got ${opts.parallel})`);
  process.exit(2);
}
// Node agents long-poll up to this long (docs/NODE_PROTOCOL.md). Short here so shutdown is quick.
const POLL_WAIT_MS = 5_000;
const HEARTBEAT_EVERY_MS = 20_000;
const HOLDER_WALLET = 'loadtest_holder';
const STARTER_CREDIT_USD = 100;

// ---------------------------------------------------------------------------- helpers
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0] ?? null, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? null, mean: s.length ? Math.round((sum / s.length) * 10) / 10 : null };
};
const fmt = (ms) => (ms === null || ms === undefined ? '-' : `${Math.round(ms)}ms`);
const log = (...a) => console.error(`[loadtest ${new Date().toISOString().slice(11, 23)}]`, ...a);

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------- gateway
async function spawnGateway() {
  const tsx = resolve(root, 'apps/gateway/node_modules/.bin/tsx');
  if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx}; run pnpm install`);
  for (const p of ['packages/config/dist/index.js', 'packages/chain-adapter/dist/index.js']) {
    if (!existsSync(resolve(root, p))) throw new Error(`${p} missing; run: pnpm --filter @mesh/config --filter @mesh/chain-adapter build`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mesh-loadtest-'));
  const env = {
    ...process.env,
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    MESH_DB_PATH: join(dir, 'mesh.db'),
    MESH_ADAPTER: 'mock',
    EPOCH_CRON: 'off',
    JWT_SECRET: 'loadtest-secret-loadtest-secret-loadtest',
    ADMIN_TOKEN: opts.adminToken,
    AUTH_DOMAIN: `127.0.0.1:${opts.port}`,
    OPENROUTER_API_KEY: '', // -> offline mock upstream
    NODES_REQUIRE_SIGNATURE: 'false', // unsigned {wallet} registration
    NODE_REGISTER_RATE_LIMIT: '1000000',
    V1_RATE_LIMIT: '1000000', // default 120/min per key would 429 the burst
    STATS_CACHE_MS: '0',
    GEO_BLOCK_ENFORCE: 'false',
    ALERTS_ENABLED: 'false',
    VERIFICATION_ENABLED: 'false', // no spot-check re-runs: jobs == requests, nodes are never quarantined mid-test
    CORS_ORIGINS: '*',
    LOG_LEVEL: opts.logLevel,
    NODE_ENV: 'development',
  };
  const child = spawn(tsx, ['src/index.ts'], { cwd: resolve(root, 'apps/gateway'), env, stdio: ['ignore', 'inherit', 'inherit'] });
  const url = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return {
    url,
    dir,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------- fake node
class FakeNode {
  constructor(base, i, tag) {
    this.base = base;
    this.i = i;
    this.tag = tag;
    this.wallet = `loadtest_node_${i}`;
    this.jobs = 0;
    this.running = 0;
    this.maxRunning = 0;
    this.maxParallel = 1;
    this.chunkPosts = [];
    this.errors = [];
    this.stopped = false;
  }

  async register() {
    const r = await jsonFetch(`${this.base}/nodes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: this.wallet, chip: 'loadtest', ramGb: 16, models: [this.tag], agentVersion: 'loadtest', maxParallel: opts.parallel }),
    });
    this.id = r.nodeId;
    // The gateway may cap maxParallel (routing.maxParallelPerNode); serve what it accepted.
    this.maxParallel = Math.max(1, Math.min(opts.parallel, r.maxParallel ?? opts.parallel));
    this.auth = { authorization: `Bearer ${r.nodeToken}`, 'content-type': 'application/json' };
  }

  async heartbeat() {
    // `busy` is a pin (docs/NODE_PROTOCOL.md §2): only pin when every slot is taken; the gateway counts running jobs itself.
    await jsonFetch(`${this.base}/nodes/${this.id}/heartbeat`, {
      method: 'POST',
      headers: this.auth,
      body: JSON.stringify({ models: [this.tag], busy: this.running >= this.maxParallel, maxParallel: this.maxParallel }),
    });
  }

  async serve(job) {
    const path = `${this.base}/nodes/${this.id}/jobs/${job.jobId}`;
    for (let seq = 0; seq < opts.tokens; seq++) {
      const t0 = performance.now();
      const res = await fetch(`${path}/chunk`, { method: 'POST', headers: this.auth, body: JSON.stringify({ seq, delta: seq === 0 ? 'tok' : ' tok' }) });
      this.chunkPosts.push(performance.now() - t0);
      if (res.status === 409) return; // client gone / job abandoned: stop generating
      if (!res.ok) throw new Error(`chunk -> ${res.status}`);
      if (opts.chunkDelayMs > 0) await sleep(opts.chunkDelayMs);
    }
    const done = await fetch(`${path}/done`, { method: 'POST', headers: this.auth, body: JSON.stringify({ promptTokens: 24, completionTokens: opts.tokens, finishReason: 'stop' }) });
    if (done.ok) this.jobs++;
    else if (done.status !== 409) throw new Error(`done -> ${done.status}`); // 409 job_not_running / empty_output: gateway already closed it
  }

  /** One poll->serve worker per slot: a node with maxParallel P keeps up to P long-polls parked and P jobs streaming. */
  async worker() {
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.base}/nodes/${this.id}/jobs/next?wait=${POLL_WAIT_MS}`, { headers: this.auth });
        if (res.status === 204) continue;
        if (!res.ok) throw new Error(`jobs/next -> ${res.status}`);
        const job = await res.json();
        this.running++;
        this.maxRunning = Math.max(this.maxRunning, this.running);
        try {
          await this.serve(job);
        } finally {
          this.running--;
        }
      } catch (e) {
        if (this.stopped) break;
        this.errors.push(e.message);
        await sleep(200);
      }
    }
  }

  async run() {
    this.hb = setInterval(() => this.heartbeat().catch((e) => this.errors.push(`heartbeat: ${e.message}`)), HEARTBEAT_EVERY_MS);
    await Promise.all(Array.from({ length: this.maxParallel }, () => this.worker()));
    clearInterval(this.hb);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hb);
  }
}

// ---------------------------------------------------------------------------- client request
async function chat(base, apiKey, i) {
  const out = { i, status: null, route: null, fallback: null, firstTokenMs: null, totalMs: null, chunks: 0, finish: null, error: null, costUsd: null };
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      // The fake nodes are unstaked and unpledged, so they are not `trusted` (the default privacy tier,
      // docs/PRIVACY.md): ask for `network` explicitly or every request would fall through to the upstream.
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-mesh-privacy': 'network' },
      body: JSON.stringify({ model: opts.model, stream: true, max_tokens: opts.tokens, messages: [{ role: 'user', content: `load test request ${i}` }] }),
    });
    out.status = res.status;
    out.route = res.headers.get('x-mesh-route');
    out.fallback = res.headers.get('x-mesh-fallback');
    if (!res.ok) {
      out.error = `http ${res.status}: ${(await res.text()).slice(0, 200)}`;
      out.totalMs = performance.now() - t0;
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = ev.choices?.[0];
          if (choice?.delta?.content && out.firstTokenMs === null) out.firstTokenMs = performance.now() - t0;
          if (choice?.delta?.content) out.chunks++;
          if (choice?.finish_reason) out.finish = choice.finish_reason;
          if (ev.error) out.error = ev.error.message ?? JSON.stringify(ev.error);
          if (ev.usage?.cost !== undefined) out.costUsd = ev.usage.cost;
        }
      }
    }
    out.totalMs = performance.now() - t0;
    if (out.finish !== 'stop' && !out.error) out.error = `finish_reason=${out.finish}`;
    if (out.firstTokenMs === null && !out.error) out.error = 'no content chunks';
  } catch (e) {
    out.error = e.message;
    out.totalMs = performance.now() - t0;
  }
  return out;
}

async function runPool(n, concurrency, fn) {
  const results = new Array(n);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results;
}

// ---------------------------------------------------------------------------- main
async function main() {
  log(`nodes=${opts.nodes} parallel=${opts.parallel} requests=${opts.requests} concurrency=${opts.concurrency} tokens/job=${opts.tokens} chunkDelay=${opts.chunkDelayMs}ms model=${opts.model}`);
  const gw = opts.gateway ? { url: opts.gateway.replace(/\/$/, ''), stop: async () => {} } : await spawnGateway();
  const base = gw.url;
  const admin = { 'x-admin-token': opts.adminToken, 'content-type': 'application/json' };
  const nodes = [];
  let exitCode = 0;
  try {
    // Which Ollama tag do the nodes have to advertise for opts.model?
    const policy = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'config/model-policy.json'), 'utf8'));
    const tag = Array.isArray(policy.networkModels) ? opts.model : policy.networkModels?.[opts.model];
    if (!tag) throw new Error(`model ${opts.model} is not in config/model-policy.json networkModels; nodes could never serve it`);

    // Holder with credits + an API key.
    await jsonFetch(`${base}/admin/starter-credit`, { method: 'POST', headers: admin, body: JSON.stringify({ wallet: HOLDER_WALLET, amountUsd: STARTER_CREDIT_USD }) });
    const { token: jwt } = await jsonFetch(`${base}/admin/dev-login`, { method: 'POST', headers: admin, body: JSON.stringify({ wallet: HOLDER_WALLET }) });
    const { key: apiKey } = await jsonFetch(`${base}/keys`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'loadtest' }) });

    // Nodes.
    const tReg0 = performance.now();
    for (let i = 0; i < opts.nodes; i++) {
      const n = new FakeNode(base, i, tag);
      await n.register();
      nodes.push(n);
    }
    const registerMs = performance.now() - tReg0;
    for (const n of nodes) n.run();
    await sleep(300); // let every node park a long-poll before the burst
    const online = await jsonFetch(`${base}/nodes`);
    const accepted = nodes[0]?.maxParallel ?? 1;
    if (accepted < opts.parallel) log(`gateway capped maxParallel at ${accepted} (asked ${opts.parallel}; routing.maxParallelPerNode)`);
    log(`registered ${nodes.length} nodes in ${fmt(registerMs)}; gateway reports online=${online.online} idle=${online.idle} slots=${online.slots ?? '?'}`);

    // The burst.
    const t0 = performance.now();
    const results = await runPool(opts.requests, opts.concurrency, (i) => chat(base, apiKey, i));
    const wallMs = performance.now() - t0;

    // Give in-flight node POSTs a beat, then stop nodes.
    await sleep(200);
    for (const n of nodes) n.stop();

    // Gateway-side view.
    const nodesAfter = await jsonFetch(`${base}/nodes`);
    const statsAfter = await jsonFetch(`${base}/stats`).catch(() => null);

    // ---- aggregate
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const byRoute = {};
    for (const r of results) {
      // x-mesh-route is `node:<id>` or the upstream name (`openrouter` | `mock`).
      const k = r.route ? (r.route.startsWith('node:') ? 'node' : `upstream:${r.route}`) : 'none';
      byRoute[k] = (byRoute[k] ?? 0) + 1;
    }
    const fallbackReasons = {};
    for (const r of results) if (r.fallback) fallbackReasons[r.fallback] = (fallbackReasons[r.fallback] ?? 0) + 1;
    const nodeOk = ok.filter((r) => r.route?.startsWith('node:'));
    const upstreamOk = ok.filter((r) => r.route && !r.route.startsWith('node:'));
    const firstToken = stats(ok.map((r) => r.firstTokenMs).filter((x) => x !== null));
    const firstTokenNode = stats(nodeOk.map((r) => r.firstTokenMs).filter((x) => x !== null));
    const firstTokenUpstream = stats(upstreamOk.map((r) => r.firstTokenMs).filter((x) => x !== null));
    const total = stats(ok.map((r) => r.totalMs));
    const totalNode = stats(nodeOk.map((r) => r.totalMs));
    const totalUpstream = stats(upstreamOk.map((r) => r.totalMs));
    const chunkPost = stats(nodes.flatMap((n) => n.chunkPosts));
    const tokensOut = ok.reduce((a, r) => a + r.chunks, 0);
    const errorKinds = {};
    for (const r of failed) {
      const k = r.error.slice(0, 80);
      errorKinds[k] = (errorKinds[k] ?? 0) + 1;
    }
    const nodeErrors = nodes.flatMap((n) => n.errors.map((e) => `${n.id}: ${e}`));
    const perNodeJobs = nodes.map((n) => n.jobs);
    const perNodeMaxRunning = nodes.map((n) => n.maxRunning);

    const result = {
      config: { ...opts, tag, pollWaitMs: POLL_WAIT_MS },
      wallMs: Math.round(wallMs),
      throughput: { requestsPerSec: Math.round((ok.length / wallMs) * 1000 * 10) / 10, tokensPerSec: Math.round((tokensOut / wallMs) * 1000) },
      requests: { total: results.length, ok: ok.length, failed: failed.length, byRoute, fallbackReasons, errorKinds },
      latencyMs: { firstToken, firstTokenNode, firstTokenUpstream, total, totalNode, totalUpstream, nodeChunkPost: chunkPost },
      nodes: {
        count: nodes.length,
        maxParallel: accepted,
        registerMs: Math.round(registerMs),
        jobsDone: perNodeJobs.reduce((a, b) => a + b, 0),
        perNodeJobs,
        min: Math.min(...perNodeJobs),
        max: Math.max(...perNodeJobs),
        /** Highest number of jobs any node had streaming at once (should reach maxParallel under load). */
        peakConcurrentPerNode: Math.max(...perNodeMaxRunning),
        errors: nodeErrors.slice(0, 20),
        errorCount: nodeErrors.length,
      },
      gateway: { nodes: nodesAfter, stats: statsAfter && { jobs24h: statsAfter.jobs24h, servedByNetwork24h: statsAfter.servedByNetwork24h, servedByNetworkPercent: statsAfter.servedByNetworkPercent, networkTokens24h: statsAfter.networkTokens24h } },
    };

    // ---- print
    const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);
    console.log('\nMesh relay load test');
    line('nodes / requests / concurrency', `${opts.nodes} / ${opts.requests} / ${opts.concurrency}`);
    line('maxParallel per node (peak seen)', `${accepted} (${result.nodes.peakConcurrentPerNode})`);
    line('tokens per job / chunk delay', `${opts.tokens} / ${opts.chunkDelayMs}ms`);
    line('wall time', fmt(wallMs));
    line('throughput', `${result.throughput.requestsPerSec} req/s, ${result.throughput.tokensPerSec} tokens/s to clients`);
    line('ok / failed', `${ok.length} / ${failed.length}`);
    line('route split', JSON.stringify(byRoute));
    if (Object.keys(fallbackReasons).length) line('fallback reasons (x-mesh-fallback)', JSON.stringify(fallbackReasons));
    console.log('\n  latency                              p50       p95       p99       max      (n)');
    const row = (k, s) => console.log(`  ${k.padEnd(34)} ${fmt(s.p50).padEnd(9)} ${fmt(s.p95).padEnd(9)} ${fmt(s.p99).padEnd(9)} ${fmt(s.max).padEnd(8)} (${s.n})`);
    row('first token (all ok)', firstToken);
    row('first token (node route)', firstTokenNode);
    row('first token (upstream fallback)', firstTokenUpstream);
    row('total (all ok)', total);
    row('total (node route)', totalNode);
    row('total (upstream fallback)', totalUpstream);
    row('node -> gateway chunk POST', chunkPost);
    console.log('');
    line('node jobs done (sum, min..max/node)', `${result.nodes.jobsDone}, ${result.nodes.min}..${result.nodes.max}`);
    line('gateway /nodes jobs24h / served', `${nodesAfter.jobs24h} / ${nodesAfter.servedByNetwork24h} (${nodesAfter.servedByNetworkPercent}% of requests)`);
    if (nodeErrors.length) line('node-side errors', `${nodeErrors.length} (first: ${nodeErrors[0]})`);
    if (failed.length) {
      console.log('\n  failures:');
      for (const [k, v] of Object.entries(errorKinds)) console.log(`    ${v}x ${k}`);
      exitCode = 1;
    }
    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify({ ...result, samples: results }, null, 2));
      log(`wrote ${opts.json}`);
    }
  } finally {
    for (const n of nodes) n.stop();
    await gw.stop();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
