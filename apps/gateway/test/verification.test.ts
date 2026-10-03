import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeReputation } from '../src/routing.js';
import { compareOutputs, effectiveSampleRate, garbageFlags, shouldSample, similarity } from '../src/verification.js';
import { ADMIN, testConfig, testServer } from './helpers.js';

/**
 * Spot-check verification (verification.ts, docs/NODE_PROTOCOL.md §10). Every network job is sampled
 * here (sampleRate 1, rand pinned) so the check path runs deterministically; generous timeouts keep a
 * slow CI box from tripping the first-token timer.
 */
const cfg: TokenomicsConfig = {
  ...testConfig,
  routing: { ...testConfig.routing, preferNetwork: true, firstTokenTimeoutMs: 4000, stallTimeoutMs: 3000, jobTimeoutMs: 8000, reputationMinJobs: 5, minSuccessRate: 0.8 },
  verification: { enabled: true, sampleRate: 1, minJobsBeforeTrust: 20, mismatchPenalty: 3, quarantineAfterMismatches: 2 },
};

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) {
    const app = apps.pop()!;
    await app.ctx.verifier?.drain();
    await app.close();
  }
});

async function boot(config = cfg) {
  const { app } = await testServer({ holders: { alice: 10_000 }, config });
  apps.push(app);
  app.ctx.verifier!.rand = () => 0; // always below the rate → sampled whenever eligible
  await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token as string;
  const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
  const chat = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}`, ...headers }, payload });
  return { app, jwt, key, chat };
}

async function fakeNode(app: App, opts: { nodeId?: string; wallet?: string } = {}) {
  const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: opts.nodeId, wallet: opts.wallet ?? 'bob', models: ['llama3.1:8b'], chip: 'M3', ramGb: 32 } });
  expect(reg.statusCode).toBe(200);
  const id = reg.json().nodeId as string;
  const h = { authorization: `Bearer ${reg.json().nodeToken as string}` };
  return {
    id,
    headers: h,
    pull: (wait = 2000) => app.inject({ method: 'GET', url: `/nodes/${id}/jobs/next?wait=${wait}`, headers: h }),
    chunk: (jobId: string, seq: number, delta: string) => app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/chunk`, headers: h, payload: { seq, delta } }),
    done: (jobId: string, usage: Record<string, unknown> = { promptTokens: 40, completionTokens: 60, finishReason: 'stop' }) =>
      app.inject({ method: 'POST', url: `/nodes/${id}/jobs/${jobId}/done`, headers: h, payload: usage }),
    stats: () => app.inject({ method: 'GET', url: `/nodes/${id}`, headers: h }),
  };
}

const GOOD = 'The capital of France is Paris. It sits on the Seine and has been the capital since the tenth century.';
const GOOD_TOKENS = 24;

/** Node `n` claims the next job and answers `text` in two chunks. Returns the job view it received. */
async function serve(n: Awaited<ReturnType<typeof fakeNode>>, text: string, completionTokens = GOOD_TOKENS) {
  const job = (await n.pull()).json() as { jobId: string; params: Record<string, unknown>; [k: string]: unknown };
  expect(job.jobId).toBeTruthy();
  const mid = Math.floor(text.length / 2);
  await n.chunk(job.jobId, 0, text.slice(0, mid));
  await n.chunk(job.jobId, 1, text.slice(mid));
  await n.done(job.jobId, { promptTokens: 12, completionTokens, finishReason: 'stop' });
  return job;
}

function verifications(app: App) {
  return app.ctx.db.prepare(`SELECT * FROM verifications ORDER BY id`).all() as Array<{ job_id: string; check_job_id: string | null; primary_node: string; check_node: string; verdict: string; score: number | null; reasons: string }>;
}
function rewardStatus(app: App, jobId: string) {
  return (app.ctx.db.prepare(`SELECT status FROM node_rewards WHERE job_id = ?`).get(jobId) as { status: string } | undefined)?.status ?? null;
}

describe('verification: sampling + heuristics (pure)', () => {
  it('new nodes are sampled at 3× the rate (capped at 1); disabled config, checks and own trusted nodes are never sampled', () => {
    const c = { enabled: true, sampleRate: 0.05, minJobsBeforeTrust: 20 };
    expect(effectiveSampleRate(c, 0)).toBeCloseTo(0.15);
    expect(effectiveSampleRate(c, 19)).toBeCloseTo(0.15);
    expect(effectiveSampleRate(c, 20)).toBeCloseTo(0.05);
    expect(effectiveSampleRate({ ...c, sampleRate: 0.5 }, 0)).toBe(1);
    const base = { nodeJobs: 100, privacy: 'network' as const, ownNode: false, isCheck: false };
    expect(shouldSample(c, { ...base, rand: () => 0.04 })).toBe(true);
    expect(shouldSample(c, { ...base, rand: () => 0.06 })).toBe(false);
    expect(shouldSample(c, { ...base, nodeJobs: 3, rand: () => 0.1 })).toBe(true); // 3× for a new node
    expect(shouldSample({ ...c, enabled: false }, { ...base, rand: () => 0 })).toBe(false);
    expect(shouldSample(c, { ...base, isCheck: true, rand: () => 0 })).toBe(false);
    expect(shouldSample(c, { ...base, privacy: 'trusted', ownNode: true, rand: () => 0 })).toBe(false);
    expect(shouldSample(c, { ...base, privacy: 'trusted', ownNode: false, rand: () => 0 })).toBe(true); // someone else's trusted node is checked
    // Over many draws the hit rate is close to the configured one.
    let hits = 0;
    let x = 0.0001;
    for (let i = 0; i < 10_000; i++) {
      x = (x * 9301 + 49297) % 233280;
      if (shouldSample(c, { ...base, rand: () => x / 233280 })) hits++;
    }
    expect(hits / 10_000).toBeGreaterThan(0.03);
    expect(hits / 10_000).toBeLessThan(0.07);
  });

  it('garbage heuristics flag empty, non-UTF8, repeated runs and noise; normal prose passes', () => {
    expect(garbageFlags('')).toEqual(['empty']);
    expect(garbageFlags('   \n ')).toEqual(['empty']);
    expect(garbageFlags('��� ok ��')).toContain('non_utf8');
    expect(garbageFlags('a'.repeat(80))).toContain('repeated_char_run');
    expect(garbageFlags('the the the the the the the the the the the the the the')).toContain('repeated_words');
    expect(garbageFlags('!@#$%^&*()_+!@#$%^&*()_+!@#$%^&*()_+!@#$%^&*()_+!@#$%^&*()_+')).toContain('low_alnum');
    expect(garbageFlags(GOOD)).toEqual([]);
    expect(garbageFlags('42')).toEqual([]);
    expect(garbageFlags('const x = { a: [1, 2, 3] };')).toEqual([]);
  });

  it('similarity + compareOutputs: same text ok, paraphrase at most suspect, unrelated + wrong token count or garbage = mismatch', () => {
    expect(similarity(GOOD, GOOD)).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity(GOOD, '')).toBe(0);
    const paraphrase = 'Paris is the capital of France. The city lies on the Seine and became the capital in the tenth century.';
    expect(similarity(GOOD, paraphrase)).toBeGreaterThan(0.1);
    expect(compareOutputs({ text: GOOD, completionTokens: 24 }, { text: GOOD, completionTokens: 24 })).toMatchObject({ verdict: 'ok', score: 1 });
    expect(compareOutputs({ text: GOOD, completionTokens: 24 }, { text: paraphrase, completionTokens: 25 }).verdict).not.toBe('mismatch');
    // Different wording, sane token count: suspect, never a penalty.
    const other = 'Berlin is the capital of Germany and lies on the river Spree in the north east of the country.';
    expect(compareOutputs({ text: other, completionTokens: 24 }, { text: GOOD, completionTokens: 24 }).verdict).toBe('suspect');
    // Unrelated output AND a token count off by more than 50%: mismatch.
    const far = compareOutputs({ text: other, completionTokens: 300 }, { text: GOOD, completionTokens: 24 });
    expect(far.verdict).toBe('mismatch');
    expect(far.reasons.join(' ')).toMatch(/token_count_300_vs_24/);
    // Garbage from the primary is a mismatch on its own, whatever the check said.
    expect(compareOutputs({ text: 'x'.repeat(100), completionTokens: 24 }, { text: GOOD, completionTokens: 24 })).toMatchObject({ verdict: 'mismatch' });
    expect(compareOutputs({ text: '', completionTokens: 24 }, { text: GOOD, completionTokens: 24 }).reasons).toContain('primary_empty');
    // Claimed tokens that cannot match the text (500 tokens for 4 characters).
    expect(compareOutputs({ text: 'yes.', completionTokens: 500 }, { text: 'yes.', completionTokens: 2 }).verdict).toBe('mismatch');
  });
});

describe('verification: gateway flow', () => {
  it('ok: a sampled job is re-run on the second node at temperature 0 with the same anonymised payload; verdict ok, reward kept, stats exposed', async () => {
    const { app, chat } = await boot();
    const a = await fakeNode(app, { nodeId: 'node_a', wallet: 'bob' });
    const b = await fakeNode(app, { nodeId: 'node_b', wallet: 'carol' });

    const aPull = a.pull(3000);
    await new Promise((r) => setTimeout(r, 30));
    const client = chat({ model: 'llama-3.1-8b', temperature: 0.7, messages: [{ role: 'user', content: 'capital of France?' }] });
    const primary = (await aPull).json() as { jobId: string; params: Record<string, unknown> };
    expect(primary.params.temperature).toBe(0.7);
    // b starts waiting before a finishes: the check job (created after the reply) lands on b.
    const bPull = b.pull(4000);
    await a.chunk(primary.jobId, 0, GOOD.slice(0, 40));
    await a.chunk(primary.jobId, 1, GOOD.slice(40));
    await a.done(primary.jobId, { promptTokens: 12, completionTokens: GOOD_TOKENS, finishReason: 'stop' });
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe(GOOD);

    const check = (await bPull).json() as Record<string, unknown> & { jobId: string; params: Record<string, unknown>; messages: unknown[] };
    expect(check.jobId).not.toBe(primary.jobId);
    expect(check.params.temperature).toBe(0); // the re-run is deterministic
    expect(check.messages).toEqual([{ role: 'user', content: 'capital of France?' }]);
    // A check job looks exactly like any other job to the node: nothing marks it, nothing new is revealed.
    expect(Object.keys(check).sort()).toEqual(['attempt', 'deadlineMs', 'jobId', 'maxTokens', 'messages', 'model', 'params']);
    await b.chunk(check.jobId, 0, GOOD);
    await b.done(check.jobId, { promptTokens: 12, completionTokens: GOOD_TOKENS, finishReason: 'stop' });
    await app.ctx.verifier!.drain();

    const rows = verifications(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: primary.jobId, check_job_id: check.jobId, primary_node: 'node_a', check_node: 'node_b', verdict: 'ok', score: 1 });
    expect(rewardStatus(app, primary.jobId)).toBe('accrued');
    expect(rewardStatus(app, check.jobId)).toBe('accrued'); // the check node is paid for its work
    // The check job is marked internally only.
    expect((app.ctx.db.prepare(`SELECT check_of FROM jobs WHERE job_id = ?`).get(check.jobId) as { check_of: string }).check_of).toBe(primary.jobId);
    // Nobody was billed for the check: exactly one usage row.
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM requests_log`).get() as { n: number }).n).toBe(1);

    const stats = (await a.stats()).json();
    expect(stats.verification).toMatchObject({ checked: 1, ok: 1, suspect: 0, mismatch: 0, lastVerdict: 'ok', quarantined: false, enabled: true, sampleRate: 1 });
    expect(stats.reputation.mismatches).toBe(0);
    // Checks themselves are never sampled (b served a check, not a client job).
    expect((await b.stats()).json().verification.checked).toBe(0);
  });

  it('garbage detect: a node returning noise is checked against the upstream when it is the only node; mismatch → reward withheld + reputation penalty', async () => {
    const { app, chat } = await boot();
    const a = await fakeNode(app, { nodeId: 'node_a' });
    const aPull = a.pull(3000);
    await new Promise((r) => setTimeout(r, 30));
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const job = (await aPull).json() as { jobId: string };
    await a.chunk(job.jobId, 0, '������������');
    await a.done(job.jobId, { promptTokens: 5, completionTokens: 21, finishReason: 'stop' });
    expect((await client).statusCode).toBe(200);
    await app.ctx.verifier!.drain();

    const [row] = verifications(app);
    expect(row).toMatchObject({ job_id: job.jobId, primary_node: 'node_a', check_node: 'upstream:mock', check_job_id: null, verdict: 'mismatch' });
    expect(JSON.parse(row.reasons)).toContain('primary_non_utf8');
    expect(rewardStatus(app, job.jobId)).toBe('withheld');
    // The accrual went back to the treasury: net node-reward liability is zero.
    const accrual = (app.ctx.db.prepare(`SELECT COALESCE(SUM(usd_micros),0) AS v FROM treasury_ledger WHERE kind = 'node_reward_accrual'`).get() as { v: number }).v;
    expect(accrual).toBe(0);
    // Withheld rewards count for nothing on the node page or the admin totals.
    const stats = (await a.stats()).json();
    expect(stats.earnedUsdTotal).toBe(0);
    expect(stats.verification).toMatchObject({ checked: 1, mismatch: 1, lastVerdict: 'mismatch', quarantined: false });
    // One done job + one mismatch × penalty 3 → 1 success out of 4 scored.
    const rep = nodeReputation(app.ctx.db, 'node_a', { minSuccessRate: 0.8, reputationMinJobs: 5, mismatchPenalty: 3 });
    expect(rep).toMatchObject({ jobs: 4, done: 1, failed: 3, mismatches: 1, successRate: 0.25, eligible: true }); // below reputationMinJobs still
    expect(stats.reputation).toMatchObject({ jobs: 4, mismatches: 1 });
  });

  it('mismatch (unrelated answer + inflated token count) is penalised; a merely different answer is only suspect', async () => {
    const { app, chat } = await boot();
    const a = await fakeNode(app, { nodeId: 'node_a' });
    const run = async (text: string, completionTokens: number) => {
      const aPull = a.pull(3000);
      await new Promise((r) => setTimeout(r, 30));
      const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
      const job = (await aPull).json() as { jobId: string };
      await a.chunk(job.jobId, 0, text);
      await a.done(job.jobId, { promptTokens: 5, completionTokens, finishReason: 'stop' });
      expect((await client).statusCode).toBe(200);
      await app.ctx.verifier!.drain();
      return job.jobId;
    };
    // The mock upstream answers ~21 tokens of "Hello from the Mesh mock upstream…".
    const suspectJob = await run('Berlin is the capital of Germany and lies on the river Spree in the north east of the country.', 22);
    const mismatchJob = await run('Berlin is the capital of Germany and lies on the river Spree in the north east of the country.', 400);
    const rows = verifications(app);
    expect(rows.map((r) => [r.job_id, r.verdict])).toEqual([
      [suspectJob, 'suspect'],
      [mismatchJob, 'mismatch'],
    ]);
    expect(rewardStatus(app, suspectJob)).toBe('accrued');
    expect(rewardStatus(app, mismatchJob)).toBe('withheld');
  });

  it('quarantine: repeated mismatches exclude the node from routing and pulls until an admin clears it', async () => {
    const { app, chat } = await boot();
    const a = await fakeNode(app, { nodeId: 'node_a' });
    for (let i = 0; i < 2; i++) {
      const aPull = a.pull(3000);
      await new Promise((r) => setTimeout(r, 30));
      const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: `q${i}` }] });
      const job = (await aPull).json() as { jobId: string };
      await a.chunk(job.jobId, 0, 'z'.repeat(120)); // garbage
      await a.done(job.jobId, { promptTokens: 5, completionTokens: 30, finishReason: 'stop' });
      expect((await client).statusCode).toBe(200);
      await app.ctx.verifier!.drain();
    }
    const stats = (await a.stats()).json();
    expect(stats.verification).toMatchObject({ checked: 2, mismatch: 2, quarantined: true });
    expect(stats.verification.quarantineReason).toMatch(/2 verification mismatches/);
    expect(stats.quarantined).toBe(true);
    expect(stats.reputation.eligible).toBe(false);
    // Pulls get nothing even with a job queued; the request falls back to the upstream.
    const fallback = await chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'after quarantine' }] });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers['x-mesh-route']).toBe('mock');
    expect((await a.pull(0)).statusCode).toBe(204);

    // Admin overview shows it; clearing restores routing.
    const ov = (await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN })).json();
    expect(ov.verification).toMatchObject({ checked: 2, mismatch: 2, quarantinedNodes: 1 });
    expect(ov.nodes.find((n: { nodeId: string }) => n.nodeId === 'node_a')).toMatchObject({ quarantined: true, verification: { mismatch: 2 } });
    expect((await app.inject({ method: 'POST', url: '/admin/nodes/nope/quarantine/clear', headers: ADMIN })).statusCode).toBe(404);
    const clear = await app.inject({ method: 'POST', url: '/admin/nodes/node_a/quarantine/clear', headers: ADMIN });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({ nodeId: 'node_a', quarantined: false });
    expect((await a.stats()).json().quarantined).toBe(false);
    const audit = app.ctx.db.prepare(`SELECT action FROM admin_actions WHERE action = 'quarantine-clear'`).all();
    expect(audit).toHaveLength(1);
    // Reputation still carries the mismatches (2 done + 2×3 penalties = 8 scored, 25%): the node is below minSuccessRate and gets no jobs
    // until newer good jobs lift it. Manual quarantine works the other way round too.
    const rep = nodeReputation(app.ctx.db, 'node_a', { minSuccessRate: 0.8, reputationMinJobs: 5, mismatchPenalty: 3 });
    expect(rep).toMatchObject({ jobs: 8, done: 2, mismatches: 2, eligible: false });
    const q = await app.inject({ method: 'POST', url: '/admin/nodes/node_a/quarantine', headers: ADMIN, payload: { reason: 'operator asked' } });
    expect(q.json()).toMatchObject({ quarantined: true });
    expect((await a.stats()).json().verification.quarantineReason).toBe('admin: operator asked');
  });

  it('own-node never sampled: a trusted job served by the requester’s own Mac is not re-checked, even at sampleRate 1', async () => {
    const trusted: TokenomicsConfig = { ...cfg, privacy: { ...cfg.privacy, default: 'trusted' } };
    const { app, chat } = await boot(trusted);
    const own = await fakeNode(app, { nodeId: 'node_own', wallet: 'alice' }); // alice is the API key's wallet
    const other = await fakeNode(app, { nodeId: 'node_other', wallet: 'bob' });
    const ownPull = own.pull(3000);
    await new Promise((r) => setTimeout(r, 30));
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'secret' }] }, { 'x-mesh-privacy': 'trusted' });
    const job = (await ownPull).json() as { jobId: string };
    await own.chunk(job.jobId, 0, GOOD);
    await own.done(job.jobId, { promptTokens: 5, completionTokens: GOOD_TOKENS, finishReason: 'stop' });
    const res = await client;
    expect(res.statusCode).toBe(200);
    expect(res.json().mesh.servedBy).toBe('your node');
    await app.ctx.verifier!.drain();
    expect(verifications(app)).toHaveLength(0);
    // No check job was queued for anyone: the other (untrusted) node sees nothing.
    expect((await other.pull(0)).statusCode).toBe(204);
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE check_of IS NOT NULL`).get() as { n: number }).n).toBe(0);
  });

  it('sampling: with sampleRate 0 (or verification disabled) nothing is checked; GET /nodes/:id still reports the stats block', async () => {
    const { app, chat } = await boot({ ...cfg, verification: { ...cfg.verification, sampleRate: 0 } });
    const a = await fakeNode(app, { nodeId: 'node_a' });
    const aPull = a.pull(3000);
    await new Promise((r) => setTimeout(r, 30));
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const job = (await aPull).json() as { jobId: string };
    await a.chunk(job.jobId, 0, GOOD);
    await a.done(job.jobId);
    expect((await client).statusCode).toBe(200);
    await app.ctx.verifier!.drain();
    expect(verifications(app)).toHaveLength(0);
    expect((await a.stats()).json().verification).toMatchObject({ checked: 0, enabled: true, sampleRate: 0, quarantined: false });
  });

  it('inconclusive: when the check cannot run (second node fails and the upstream errors) nothing is penalised', async () => {
    const { app, chat } = await boot();
    // Make the upstream fail for the check call only (the primary was served by a node).
    const realChat = app.ctx.upstream.chat.bind(app.ctx.upstream);
    app.ctx.upstream.chat = async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
    const a = await fakeNode(app, { nodeId: 'node_a' });
    const aPull = a.pull(3000);
    await new Promise((r) => setTimeout(r, 30));
    const client = chat({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
    const job = (await aPull).json() as { jobId: string };
    await a.chunk(job.jobId, 0, 'q'.repeat(100));
    await a.done(job.jobId);
    expect((await client).statusCode).toBe(200);
    await app.ctx.verifier!.drain();
    app.ctx.upstream.chat = realChat;
    const [row] = verifications(app);
    expect(row).toMatchObject({ verdict: 'inconclusive', check_node: 'none', score: null });
    expect(rewardStatus(app, job.jobId)).toBe('accrued');
  });
});
