import { MockAdapter } from '@mesh/chain-adapter';
import { parseTokenomics, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { PLEDGE_COMMITMENTS, pledgeMessage } from '../src/auth.js';
import { JOB_VIEW_FIELDS, JobBroker, sanitizeMessages } from '../src/network.js';
import { decideRoute, isTrustedNode, resolvePrivacy, trustedVia, type NodeRow } from '../src/routing.js';
import { OpenRouterUpstream, upstreamBody } from '../src/upstream.js';
import { ADMIN, memDb, testConfig, testServer } from './helpers.js';

/**
 * Privacy tiers (docs/PRIVACY.md): what a node is sent, how a request picks a tier, that `trusted`
 * never silently becomes `network`, the operator pledge, and the ZDR flag on upstream calls.
 */

/** Production-like privacy settings (default `trusted`), fast node timeouts. */
const trustedDefault: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 400, stallTimeoutMs: 300, jobTimeoutMs: 5000 },
  privacy: { ...testConfig.privacy, default: 'trusted', fallback: 'upstream_zdr', trustedWallets: ['mockwallet_allow'] },
};

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(config = trustedDefault, adapter = new MockAdapter()) {
  const { app } = await testServer({ config, context: { adapter } });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const login = async (wallet: string) => (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet } })).json().token as string;
  const jwt = await login('alice');
  const mkKey = async (body: Record<string, unknown> = {}) => (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` }, payload: body })).json() as { id: number; key: string };
  const { key } = await mkKey();
  const chat = (payload: unknown, headers: Record<string, string> = {}, apiKey = key) =>
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${apiKey}`, ...headers }, payload });
  return { app, adapter, jwt, key, mkKey, chat, login };
}

async function fakeNode(app: App, opts: { nodeId?: string; wallet: string; models?: string[] }) {
  const reg = await app.inject({
    method: 'POST',
    url: '/nodes/register',
    payload: { nodeId: opts.nodeId, wallet: opts.wallet, models: opts.models ?? ['llama3.1:8b'], chip: 'M3 Max', ramGb: 64, agentVersion: '0.3.0' },
  });
  expect(reg.statusCode).toBe(200);
  const id = reg.json().nodeId as string;
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  return {
    id,
    headers: h,
    pull: (wait = 1200) => app.inject({ method: 'GET', url: `/nodes/${id}/jobs/next?wait=${wait}`, headers: h }),
    chunk: (jobId: string, seq: number, delta: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/chunk`, headers: h, payload: { seq, delta } }),
    done: (jobId: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/done`, headers: h, payload: { promptTokens: 10, completionTokens: 20, finishReason: 'stop' } }),
    stats: () => app.inject({ method: 'GET', url: `/nodes/${id}`, headers: h }),
  };
}

/** Owner signs the pledge for a node with the mock adapter's deterministic signature. */
async function pledge(app: App, jwt: string, nodeId: string, wallet: string) {
  const get = await app.inject({ method: 'GET', url: `/nodes/${nodeId}/pledge`, headers: { authorization: `Bearer ${jwt}` } });
  expect(get.statusCode).toBe(200);
  const message = get.json().message as string;
  return app.inject({ method: 'POST', url: `/nodes/${nodeId}/pledge`, headers: { authorization: `Bearer ${jwt}` }, payload: { signature: MockAdapter.sign(wallet, message) } });
}

/** A node that is trusted via stake + pledge: mockwallet_alice is gold in the mock adapter. */
async function trustedNode(app: App, login: (w: string) => Promise<string>, nodeId = 'mac-trusted') {
  const n = await fakeNode(app, { nodeId, wallet: 'mockwallet_alice' });
  const ownerJwt = await login('mockwallet_alice');
  expect((await pledge(app, ownerJwt, n.id, 'mockwallet_alice')).statusCode).toBe(200);
  await app.ctx.stakes!.resolve('mockwallet_alice'); // warm the per-epoch tier cache the hot path reads
  return n;
}

function sse(body: string): Array<Record<string, any>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

/** Drives a node through one job and returns the client response. */
async function serve(n: Awaited<ReturnType<typeof fakeNode>>, client: Promise<any>) {
  const pulled = await n.pull(1500);
  expect(pulled.statusCode).toBe(200);
  const job = pulled.json();
  await n.chunk(job.jobId, 0, 'ok');
  await n.done(job.jobId);
  return { job, res: await client };
}

describe('anonymised jobs: what a node receives', () => {
  it('the job payload has exactly the protocol fields and nothing identifying the caller', async () => {
    const { app, chat, login } = await boot();
    const n = await trustedNode(app, login);
    const client = chat(
      {
        model: 'llama-3.1-8b',
        stream: true,
        max_tokens: 50,
        temperature: 0.1,
        user: 'end-user-4711', // OpenAI abuse-tracking id: must not travel to the node
        metadata: { session: 'sess_secret' },
        mesh: { privacy: 'trusted' },
        messages: [
          { role: 'system', content: 'You are terse.', name: 'ops-bot' },
          { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], name: 'alice' },
        ],
      },
      { 'user-agent': 'secret-client/1.0', 'x-forwarded-for': '203.0.113.9' },
    );
    const pulled = await n.pull(1500);
    expect(pulled.statusCode).toBe(200);
    const job = pulled.json();
    // exactly the documented keys, no more
    expect(Object.keys(job).sort()).toEqual([...JOB_VIEW_FIELDS].sort());
    expect(job.model).toBe('llama3.1:8b');
    expect(job.params).toEqual({ temperature: 0.1 });
    expect(job.maxTokens).toBe(50);
    expect(job.attempt).toBe(1);
    // messages are role + content only; non-text parts dropped
    expect(job.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    const raw = JSON.stringify(job);
    for (const leak of ['alice', 'ops-bot', 'end-user-4711', 'sess_secret', 'secret-client', '203.0.113.9', 'mesh_sk_', 'llama-3.1-8b', 'api_key', 'wallet', 'requestId', 'image_url', 'requester']) {
      expect(raw).not.toContain(leak);
    }
    // the internal requester wallet (owner rule) is stored on the row but never reaches the node
    expect(job).not.toHaveProperty('requester_wallet');
    expect(job).not.toHaveProperty('requesterWallet');
    expect([...JOB_VIEW_FIELDS]).not.toContain('requesterWallet');
    // the stored row is the same sanitised payload (what a DB dump would show)
    const row = app.ctx.db.prepare(`SELECT payload, requester_wallet FROM jobs WHERE job_id = ?`).get(job.jobId) as { payload: string; requester_wallet: string | null };
    expect(row.payload).not.toContain('ops-bot');
    expect(row.requester_wallet).toBe('alice');
    await n.chunk(job.jobId, 0, 'ok');
    await n.done(job.jobId);
    const res = await client;
    expect(res.statusCode).toBe(200);
  });

  it('sanitizeMessages keeps role/content, drops everything else and malformed entries', () => {
    expect(
      sanitizeMessages([
        { role: 'user', content: 'a', name: 'x', tool_call_id: 't1' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'input_audio', input_audio: {} }, 'junk'] },
        'not an object',
        { content: 'no role' },
      ]),
    ).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: null },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ]);
  });
});

describe('tier selection: header > body > key default > gateway default', () => {
  const cfg = trustedDefault.privacy;

  it('resolvePrivacy precedence and validation', () => {
    expect(resolvePrivacy({}, cfg)).toEqual({ tier: 'trusted', source: 'default' });
    expect(resolvePrivacy({ keyDefault: 'network' }, cfg)).toEqual({ tier: 'network', source: 'key' });
    expect(resolvePrivacy({ keyDefault: 'network', body: { mesh: { privacy: 'upstream_zdr' } } }, cfg)).toEqual({ tier: 'upstream_zdr', source: 'body' });
    expect(resolvePrivacy({ keyDefault: 'network', body: { mesh: { privacy: 'upstream_zdr' } }, header: 'Trusted' }, cfg)).toEqual({ tier: 'trusted', source: 'header' });
    expect(resolvePrivacy({ header: ['network', 'trusted'] }, cfg)).toEqual({ tier: 'network', source: 'header' });
    expect(resolvePrivacy({ header: 'public' }, cfg)).toMatchObject({ error: expect.stringContaining("unknown privacy tier 'public'") });
    expect(resolvePrivacy({ body: { mesh: { privacy: 42 } } }, cfg)).toMatchObject({ error: expect.stringContaining('body') });
    // a disabled tier is refused rather than mapped to another
    expect(resolvePrivacy({ header: 'network' }, { ...cfg, tiers: { ...cfg.tiers, network: false } })).toMatchObject({ error: expect.stringContaining('disabled') });
    // an invalid key default does not crash a request: it is refused too (the key route validates on write)
    expect(resolvePrivacy({ keyDefault: 'bogus' }, cfg)).toMatchObject({ error: expect.stringContaining('key') });
  });

  it('header beats body: X-Mesh-Privacy=network with body trusted is served by an untrusted node', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    const { res } = await serve(n, chat({ model: 'llama-3.1-8b', stream: true, mesh: { privacy: 'trusted' }, messages: [{ role: 'user', content: 'hi' }] }, { 'x-mesh-privacy': 'network' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-privacy']).toBe('network');
    expect(res.headers['x-mesh-served-by']).toBe('network node');
    const last = sse(res.body).at(-1)!;
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: 'plain', privacy: 'network', servedBy: 'network node' });
  });

  it('body beats the key default; the key default beats the gateway default', async () => {
    const { app, chat, mkKey, jwt } = await boot();
    const n = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    const { key: netKey, id } = await mkKey({ name: 'bulk', privacy: 'network' });
    expect((await app.inject({ method: 'GET', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().keys.find((k: any) => k.id === id).privacy).toBe('network');

    // key says network → the plain node serves it even though the gateway default is trusted
    const a = await serve(n, chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, netKey));
    expect(a.res.json().mesh).toMatchObject({ privacy: 'network', servedBy: 'network node' });

    // body says upstream_zdr → key default ignored, node never sees it
    const b = await chat({ model: 'llama-3.1-8b', stream: false, mesh: { privacy: 'upstream_zdr' }, messages: [{ role: 'user', content: 'hi' }] }, {}, netKey);
    expect(b.statusCode).toBe(200);
    expect(b.json().mesh).toEqual({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect(b.headers['x-mesh-privacy']).toBe('upstream_zdr');
    expect((await n.pull(0)).statusCode).toBe(204);
  });

  it('an unknown tier is a 400, never a guess', async () => {
    const { chat } = await boot();
    const r = await chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] }, { 'x-mesh-privacy': 'secret' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_privacy_tier');
  });

  it('PATCH /keys/:id {privacy} sets and clears the default; invalid values are rejected', async () => {
    const { app, jwt, mkKey } = await boot();
    const { id } = await mkKey({ name: 'k' });
    const H = { authorization: `Bearer ${jwt}` };
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, payload: { privacy: 'upstream_zdr' } })).json()).toMatchObject({ id, privacy: 'upstream_zdr' });
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, payload: { privacy: null } })).json()).toMatchObject({ id, privacy: null });
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, payload: { privacy: 'everyone' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/keys', headers: H, payload: { privacy: 'nope' } })).statusCode).toBe(400);
  });
});

describe('trusted tier never silently degrades to network', () => {
  it('default trusted + only an untrusted node online → upstream (ZDR), the node never gets the job', async () => {
    const { app, chat } = await boot();
    const n = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    const r = await chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'private' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-mesh-route']).toBe('mock');
    expect(r.headers['x-mesh-fallback']).toBe('no_trusted_node');
    expect(r.headers['x-mesh-privacy']).toBe('upstream_zdr');
    expect(r.headers['x-mesh-served-by']).toBe('upstream (ZDR)');
    const events = sse(r.body);
    expect(events.at(-1)!.mesh).toEqual({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect(events.at(-1)!.usage).toBeTruthy(); // final chunk still carries usage
    expect((await n.pull(0)).statusCode).toBe(204);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
  });

  it('explicit trusted with fallback=network still goes upstream; only the default may drop to network', async () => {
    const cfg: TokenomicsConfig = { ...trustedDefault, privacy: { ...trustedDefault.privacy, fallback: 'network' } };
    const { app, chat } = await boot(cfg);
    const n = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    // explicit (header): never network
    const explicit = await chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'x' }] }, { 'x-mesh-privacy': 'trusted' });
    expect(explicit.json().mesh).toEqual({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect((await n.pull(0)).statusCode).toBe(204);
    // default: the configured fallback applies and the plain node serves it, labelled honestly
    const { res } = await serve(n, chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'y' }] }));
    expect(res.json().mesh).toMatchObject({ route: 'node', privacy: 'network', servedBy: 'network node' });
  });

  it('a trusted node serves trusted requests; a trusted job queued while an untrusted node polls is not claimable by it', async () => {
    const { app, chat, login } = await boot();
    const plain = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    const trusted = await trustedNode(app, login);
    // Only the trusted node is a candidate; the plain one polling first must not take the job.
    const plainPoll = plain.pull(600);
    await new Promise((r) => setTimeout(r, 50));
    const client = chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'secret' }] });
    const got = await trusted.pull(1500);
    expect(got.statusCode).toBe(200);
    const job = got.json();
    await trusted.chunk(job.jobId, 0, 'ok');
    await trusted.done(job.jobId);
    const res = await client;
    expect((await plainPoll).statusCode).toBe(204); // the plain node's long-poll ran out empty
    expect(res.headers['x-mesh-served-by']).toBe('trusted node');
    const last = sse(res.body).at(-1)!;
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: trusted.id, privacy: 'trusted', servedBy: 'trusted node' });
    expect(last.usage.total_tokens).toBe(30);
    expect((app.ctx.db.prepare(`SELECT privacy FROM jobs WHERE job_id = ?`).get(job.jobId) as { privacy: string }).privacy).toBe('trusted');
  });

  it('broker: tryClaim refuses a trusted job for an untrusted node even when called directly (race safety)', () => {
    const db = memDb();
    const t = Math.floor(Date.now() / 1000);
    const node = (id: string): NodeRow => ({ node_id: id, wallet: 'w', url: '', models: '["llama3.1:8b"]', ram_gb: null, chip: null, busy: 0, created_at: t, last_seen: t, token_hash: null, agent_version: null, load_avg: null, pledge_at: null, pledge_signature: null, pledge_chain: null });
    for (const id of ['good', 'bad']) db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES (?, 'w', '', '["llama3.1:8b"]', ?, ?)`).run(id, t, t);
    const broker = new JobBroker(db, () => ({ minSuccessRate: 0.8, reputationMinJobs: 5 }), (n) => n.node_id === 'good');
    const { job } = broker.create({ model: 'm', tag: 'llama3.1:8b', wallet: 'alice', apiKeyId: 1, payload: { messages: [{ role: 'user', content: 'x' }], params: {} }, maxTokens: 10, deadlineMs: Date.now() + 5000, privacy: 'trusted' });
    expect(broker.tryClaim(job.job_id, 'bad', false)).toBeNull();
    expect(broker.get(job.job_id)!.status).toBe('queued');
    expect(broker.tryClaim(job.job_id, 'good', true)?.node_id).toBe('good');
    // pull() asks the trust callback itself
    const { job: j2 } = broker.create({ model: 'm', tag: 'llama3.1:8b', wallet: 'alice', apiKeyId: 1, payload: { messages: [], params: {} }, maxTokens: 10, deadlineMs: Date.now() + 5000, privacy: 'trusted' });
    return Promise.all([broker.pull(node('bad'), 0), broker.pull(node('good'), 0)]).then(([bad, good]) => {
      expect(bad).toBeNull();
      expect(good?.job_id).toBe(j2.job_id);
    });
  });

  it('after a trusted node fails before output, the retry only considers trusted nodes and the fallback stays ZDR', async () => {
    const { app, chat, login } = await boot();
    const plain = await fakeNode(app, { nodeId: 'plain', wallet: 'nobody' });
    const trusted = await trustedNode(app, login);
    const client = chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'secret' }] });
    const got = await trusted.pull(1500);
    expect(got.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/nodes/${trusted.id}/jobs/${got.json().jobId}/fail`, headers: trusted.headers, payload: { error: 'oom' } });
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-fallback']).toMatch(/node_error/);
    expect(res.json().mesh).toEqual({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect((await plain.pull(0)).statusCode).toBe(204);
  });

  it('decideRoute: non-network models go upstream with ZDR unless the caller settled for network', () => {
    const db = memDb();
    const deps = { db, config: trustedDefault, policy: app0Policy(), stakes: undefined };
    expect(decideRoute(deps, 'openai/gpt-4o')).toMatchObject({ target: 'openrouter', zdr: true, servedBy: 'upstream (ZDR)', privacy: 'upstream_zdr' });
    expect(decideRoute(deps, 'openai/gpt-4o', { tier: 'network', source: 'header' })).toMatchObject({ target: 'openrouter', zdr: false, servedBy: 'upstream', privacy: 'network' });
    expect(decideRoute(deps, 'llama-3.1-8b', { tier: 'upstream_zdr', source: 'body' })).toMatchObject({ target: 'openrouter', reason: 'upstream_requested', zdr: true });
  });
});

function app0Policy() {
  return { allow: [], deny: [], networkModels: { 'llama-3.1-8b': 'llama3.1:8b' } };
}

describe('owner rule: your own Macs are trusted for your own requests', () => {
  // The API key in boot() belongs to wallet `alice`; a node registered with wallet `alice` is "her" Mac.
  it("a plain node owned by the requesting wallet serves a trusted request, labelled 'your node'", async () => {
    const { app, chat } = await boot();
    const other = await fakeNode(app, { nodeId: 'someone-else', wallet: 'bob' });
    const mine = await fakeNode(app, { nodeId: 'my-mac', wallet: 'alice' });
    const row = (id: string) => app.ctx.db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(id) as NodeRow;
    // diagnostics: owner only for the requester's wallet; nothing wallet-wide
    expect(trustedVia(app.ctx, row('my-mac'), 'alice')).toBe('owner');
    expect(trustedVia(app.ctx, row('my-mac'))).toBeNull();
    expect(trustedVia(app.ctx, row('my-mac'), 'bob')).toBeNull();
    expect(isTrustedNode(app.ctx, row('someone-else'), 'alice')).toBe(false);
    expect(decideRoute(app.ctx, 'llama-3.1-8b', { tier: 'trusted', source: 'header' }, { requesterWallet: 'alice' })).toMatchObject({ target: 'node', candidates: ['my-mac'], privacy: 'trusted', requesterWallet: 'alice' });
    expect(decideRoute(app.ctx, 'llama-3.1-8b', { tier: 'trusted', source: 'header' }, { requesterWallet: 'carol' })).toMatchObject({ target: 'openrouter', reason: 'no_trusted_node' });

    // the other wallet's node polls first and must not get the job
    const otherPoll = other.pull(600);
    await new Promise((r) => setTimeout(r, 50));
    const { job, res } = await serve(mine, chat({ model: 'llama-3.1-8b', stream: true, messages: [{ role: 'user', content: 'secret' }] }, { 'x-mesh-privacy': 'trusted' }));
    expect((await otherPoll).statusCode).toBe(204);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-mesh-privacy']).toBe('trusted');
    expect(res.headers['x-mesh-served-by']).toBe('your node');
    const last = sse(res.body).at(-1)!;
    expect(last.mesh).toMatchObject({ route: 'node', nodeId: 'my-mac', privacy: 'trusted', servedBy: 'your node' });
    // the node saw the protocol fields only
    expect(Object.keys(job).sort()).toEqual([...JOB_VIEW_FIELDS].sort());
    expect(JSON.stringify(job)).not.toContain('alice');
    const stored = app.ctx.db.prepare(`SELECT privacy, requester_wallet, node_id FROM jobs WHERE job_id = ?`).get(job.jobId) as { privacy: string; requester_wallet: string; node_id: string };
    expect(stored).toEqual({ privacy: 'trusted', requester_wallet: 'alice', node_id: 'my-mac' });

    // non-stream: same label in the JSON body
    const b = await serve(mine, chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'again' }] }));
    expect(b.res.json().mesh).toMatchObject({ route: 'node', nodeId: 'my-mac', privacy: 'trusted', servedBy: 'your node' });
    expect(b.res.headers['x-mesh-served-by']).toBe('your node');
  });

  it("another wallet's plain node never serves it; with the owner node offline the fallback is unchanged (ZDR upstream)", async () => {
    const { app, chat } = await boot();
    const other = await fakeNode(app, { nodeId: 'someone-else', wallet: 'bob' });
    await fakeNode(app, { nodeId: 'my-mac', wallet: 'alice' });
    // my Mac went offline (stale heartbeat)
    app.ctx.db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = 'my-mac'`).run(Math.floor(Date.now() / 1000) - 3600);
    const r = await chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'private' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-mesh-fallback']).toBe('no_trusted_node');
    expect(r.json().mesh).toEqual({ route: 'mock', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' });
    expect((await other.pull(0)).statusCode).toBe(204);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
  });

  it('a genuinely trusted node serving the request is still labelled "trusted node", not "your node"', async () => {
    const { app, chat, login } = await boot();
    const trusted = await trustedNode(app, login);
    const { res } = await serve(trusted, chat({ model: 'llama-3.1-8b', stream: false, messages: [{ role: 'user', content: 'x' }] }));
    expect(res.json().mesh).toMatchObject({ nodeId: trusted.id, privacy: 'trusted', servedBy: 'trusted node' });
  });

  it('broker: the claim SQL admits the owner node and refuses others, even when called directly', () => {
    const db = memDb();
    const t = Math.floor(Date.now() / 1000);
    const node = (id: string, wallet: string): NodeRow => ({ node_id: id, wallet, url: '', models: '["llama3.1:8b"]', ram_gb: null, chip: null, busy: 0, created_at: t, last_seen: t, token_hash: null, agent_version: null, load_avg: null, pledge_at: null, pledge_signature: null, pledge_chain: null });
    for (const [id, w] of [['mine', 'alice'], ['theirs', 'bob']]) db.prepare(`INSERT INTO nodes (node_id, wallet, url, models, created_at, last_seen) VALUES (?, ?, '', '["llama3.1:8b"]', ?, ?)`).run(id, w, t, t);
    const broker = new JobBroker(db, () => ({ minSuccessRate: 0.8, reputationMinJobs: 5 })); // nobody is trusted via the callback
    const mk = (requesterWallet: string | null) =>
      broker.create({ model: 'm', tag: 'llama3.1:8b', wallet: 'alice', apiKeyId: 1, payload: { messages: [{ role: 'user', content: 'x' }], params: {} }, maxTokens: 10, deadlineMs: Date.now() + 5000, privacy: 'trusted', requesterWallet }).job;
    const j1 = mk('alice');
    expect(broker.tryClaim(j1.job_id, 'theirs', false)).toBeNull();
    expect(broker.get(j1.job_id)!.status).toBe('queued');
    expect(broker.tryClaim(j1.job_id, 'mine', false)?.node_id).toBe('mine');
    // without a requester wallet the owner rule does not apply
    const j2 = mk(null);
    expect(broker.tryClaim(j2.job_id, 'mine', false)).toBeNull();
    expect(broker.tryClaim(j2.job_id, 'theirs', false)).toBeNull();
    // pull() path: only the owner's node finds it
    db.prepare(`UPDATE nodes SET busy = 0`).run();
    const j3 = mk('alice');
    return Promise.all([broker.pull(node('theirs', 'bob'), 0), broker.pull(node('mine', 'alice'), 0)]).then(([theirs, mine]) => {
      expect(theirs).toBeNull();
      expect(mine?.job_id).toBe(j3.job_id);
    });
  });
});

describe('operator pledge', () => {
  it('GET returns the exact text; POST by the owner stores pledge_at + signature; wrong signer / other wallet / node token are refused', async () => {
    const { app, login } = await boot();
    const n = await fakeNode(app, { nodeId: 'mac-1', wallet: 'mockwallet_bob' });
    const bob = await login('mockwallet_bob');
    const H = { authorization: `Bearer ${bob}` };
    const get = await app.inject({ method: 'GET', url: '/nodes/mac-1/pledge', headers: H });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ nodeId: 'mac-1', wallet: 'mockwallet_bob', signed: false, trusted: false, requiredStakeTier: 'gold' });
    const message = get.json().message as string;
    expect(message).toBe(pledgeMessage({ domain: 'test.mesh', uri: 'https://test.mesh', wallet: 'mockwallet_bob', nodeId: 'mac-1' }));
    for (const c of PLEDGE_COMMITMENTS) expect(message).toContain(c);
    expect(message).toContain('Node ID: mac-1');

    // another wallet's session: 401 on both
    const mallory = await login('mallory');
    expect((await app.inject({ method: 'GET', url: '/nodes/mac-1/pledge', headers: { authorization: `Bearer ${mallory}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-1/pledge', headers: { authorization: `Bearer ${mallory}` }, payload: { signature: MockAdapter.sign('mallory', message) } })).statusCode).toBe(401);
    // the node token is not a session
    expect((await app.inject({ method: 'GET', url: '/nodes/mac-1/pledge', headers: n.headers })).statusCode).toBe(401);
    // wrong signer / a signature for another node id
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-1/pledge', headers: H, payload: { signature: MockAdapter.sign('mallory', message) } })).json().error).toBe('bad_signature');
    const otherMsg = pledgeMessage({ domain: 'test.mesh', uri: 'https://test.mesh', wallet: 'mockwallet_bob', nodeId: 'mac-2' });
    expect((await app.inject({ method: 'POST', url: '/nodes/mac-1/pledge', headers: H, payload: { signature: MockAdapter.sign('mockwallet_bob', otherMsg) } })).json().error).toBe('bad_signature');
    expect((await app.inject({ method: 'POST', url: '/nodes/ghost/pledge', headers: H, payload: { signature: 'x' } })).statusCode).toBe(404);

    const ok = await app.inject({ method: 'POST', url: '/nodes/mac-1/pledge', headers: H, payload: { signature: MockAdapter.sign('mockwallet_bob', message) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ signed: true, chain: 'solana', trusted: false, trustedVia: null, stakeOk: false });
    const row = app.ctx.db.prepare(`SELECT pledge_at, pledge_signature, pledge_chain FROM nodes WHERE node_id = 'mac-1'`).get() as { pledge_at: number; pledge_signature: string; pledge_chain: string };
    expect(row.pledge_at).toBeGreaterThan(0);
    expect(row.pledge_signature).toBe(MockAdapter.sign('mockwallet_bob', message));
    expect(row.pledge_chain).toBe('solana');
    // visible on the stats view too
    expect((await n.stats()).json().pledge).toMatchObject({ signed: true, trusted: false });
  });

  it('trusted = allowlisted wallet, OR gold stake + pledge; silver + pledge and gold without pledge are not', async () => {
    const { app, login } = await boot();
    const allow = await fakeNode(app, { nodeId: 'allow', wallet: 'mockwallet_allow' });
    const gold = await fakeNode(app, { nodeId: 'gold', wallet: 'mockwallet_alice' });
    const silver = await fakeNode(app, { nodeId: 'silver', wallet: 'mockwallet_bob' });
    await app.ctx.stakes!.resolveMany(['mockwallet_alice', 'mockwallet_bob', 'mockwallet_allow']);
    const row = (id: string) => app.ctx.db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(id) as NodeRow;

    expect(isTrustedNode(app.ctx, row('allow'))).toBe(true);
    expect((await allow.stats()).json().pledge).toMatchObject({ trusted: true, trustedVia: 'allowlist', allowlisted: true, signed: false });
    expect(isTrustedNode(app.ctx, row('gold'))).toBe(false); // no pledge yet
    expect((await gold.stats()).json().pledge).toMatchObject({ trusted: false, stakeOk: true, stakeTier: 'gold' });

    expect((await pledge(app, await login('mockwallet_alice'), 'gold', 'mockwallet_alice')).json()).toMatchObject({ trusted: true, trustedVia: 'stake+pledge' });
    expect(isTrustedNode(app.ctx, row('gold'))).toBe(true);

    expect((await pledge(app, await login('mockwallet_bob'), 'silver', 'mockwallet_bob')).json()).toMatchObject({ signed: true, trusted: false, stakeTier: 'silver', stakeOk: false });
    expect(isTrustedNode(app.ctx, row('silver'))).toBe(false);

    // a config that names a non-existent stake tier only trusts the allowlist
    const odd = { ...app.ctx, config: { ...app.ctx.config, privacy: { ...app.ctx.config.privacy, trustedMinStakeTier: 'platinum' } } };
    expect(isTrustedNode(odd, row('gold'))).toBe(false);
    expect(isTrustedNode(odd, row('allow'))).toBe(true);
  });

  it('the pledge text cannot be used to sign in or register (different first line)', async () => {
    const { parseLoginMessage } = await import('../src/auth.js');
    expect(parseLoginMessage(pledgeMessage({ domain: 'test.mesh', uri: 'https://test.mesh', wallet: 'w', nodeId: 'n' }))).toBeNull();
  });
});

describe('upstream ZDR flag', () => {
  it('upstreamBody adds provider.data_collection=deny only under zdr, merges a client provider object, strips `mesh`', () => {
    const body = { model: 'openai/gpt-4o', messages: [], mesh: { privacy: 'trusted' }, provider: { order: ['OpenAI'] } };
    expect(upstreamBody(body, { zdr: true })).toEqual({ model: 'openai/gpt-4o', messages: [], provider: { order: ['OpenAI'], data_collection: 'deny' }, usage: { include: true } });
    expect(upstreamBody(body)).toEqual({ model: 'openai/gpt-4o', messages: [], provider: { order: ['OpenAI'] }, usage: { include: true } });
    expect(upstreamBody({ model: 'm', messages: [] }, { zdr: true }).provider).toEqual({ data_collection: 'deny' });
    // a client cannot opt out of ZDR by sending data_collection: allow on a ZDR request
    expect((upstreamBody({ model: 'm', messages: [], provider: { data_collection: 'allow' } }, { zdr: true }).provider as any).data_collection).toBe('deny');
  });

  it('OpenRouterUpstream.chat sends the flag on the wire', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'gen', choices: [], usage: {} });
    };
    const up = new OpenRouterUpstream('sk-or-test', { fetchImpl });
    await up.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }], mesh: { privacy: 'upstream_zdr' } }, { zdr: true });
    await up.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, { zdr: false });
    await up.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0].provider).toEqual({ data_collection: 'deny' });
    expect(calls[0]).not.toHaveProperty('mesh');
    expect(calls[1]).not.toHaveProperty('provider');
    expect(calls[2]).not.toHaveProperty('provider');
  });

  it('the gateway asks for ZDR on trusted/upstream_zdr requests and not on explicit network ones', async () => {
    const seen: Array<{ zdr?: boolean }> = [];
    const { app } = await testServer({
      config: trustedDefault,
      context: {
        upstream: {
          name: 'mock',
          chat: async (_body, opts) => {
            seen.push(opts ?? {});
            return Response.json({ id: 'x', model: 'openai/gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
          },
          models: async () => Response.json({ data: [] }),
        },
      },
    });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key;
    const go = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}`, ...headers }, payload: { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] } });
    expect((await go({})).json().mesh.servedBy).toBe('upstream (ZDR)');
    expect((await go({ 'x-mesh-privacy': 'upstream_zdr' })).json().mesh.servedBy).toBe('upstream (ZDR)');
    expect((await go({ 'x-mesh-privacy': 'network' })).json().mesh.servedBy).toBe('upstream');
    expect(seen.map((o) => o.zdr)).toEqual([true, true, false]);
  });
});

describe('config', () => {
  it('privacy defaults parse from a tokenomics file without the block; invalid tiers are rejected', () => {
    const raw = JSON.parse(JSON.stringify(testConfig)) as Record<string, any>;
    delete raw.privacy;
    const c = parseTokenomics(raw);
    expect(c.privacy).toEqual({ default: 'trusted', fallback: 'upstream_zdr', trustedWallets: [], trustedMinStakeTier: 'gold', tiers: { trusted: true, network: true, upstream_zdr: true } });
    expect(() => parseTokenomics({ ...raw, privacy: { default: 'public' } })).toThrow();
    expect(() => parseTokenomics({ ...raw, privacy: { fallback: 'trusted' } })).toThrow();
  });
});
