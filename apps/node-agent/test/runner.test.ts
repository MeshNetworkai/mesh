import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient, type Job } from '../src/gateway.js';
import { OllamaClient } from '../src/ollama.js';
import { MAX_FAIL_REASON_CHARS, deadlineBudget, runJob, sanitizeReason, toOllamaMessages, toOllamaOptions, usageFromFinal } from '../src/runner.js';
import { fakeGateway, fakeOllama } from './fakes.js';

const job = (over: Partial<Job> = {}): Job => ({
  jobId: 'job_1',
  model: 'llama3.1:8b',
  messages: [{ role: 'user', content: 'hi' }],
  params: { temperature: 0.2 },
  maxTokens: 64,
  deadlineMs: 10_000,
  ...over,
});

describe('runJob', () => {
  let ollama: ReturnType<typeof fakeOllama>;
  let gw: ReturnType<typeof fakeGateway>;
  let ollamaUrl: string;
  let gwUrl: string;

  afterEach(async () => {
    await Promise.all([ollama?.stop(), gw?.stop()]);
  });

  it('streams Ollama deltas as ordered chunks and reports done with token counts', async () => {
    ollama = fakeOllama({ reply: ['Hello', ' from', ' the', ' mesh', '.'], delayMs: 5, promptTokens: 17 });
    gw = fakeGateway();
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const gateway = new GatewayClient(gwUrl, gw.state.token);

    const res = await runJob(job(), gateway, gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1 });

    expect(res.ok).toBe(true);
    expect(res.promptTokens).toBe(17);
    expect(res.completionTokens).toBe(5);
    expect(res.finishReason).toBe('stop');
    // Chunks arrive in seq order and reassemble to the full reply.
    const seqs = gw.state.chunks.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(0);
    expect(gw.state.chunks.map((c) => c.delta).join('')).toBe('Hello from the mesh.');
    expect(gw.state.done).toEqual([{ jobId: 'job_1', body: { promptTokens: 17, completionTokens: 5, finishReason: 'stop' } }]);
    expect(gw.state.failed).toHaveLength(0);
    // Ollama got the mapped request.
    const chat = ollama.requests.find((r) => r.path === '/api/chat')!;
    expect(chat.body.stream).toBe(true);
    expect(chat.body.model).toBe('llama3.1:8b');
    expect(chat.body.options).toEqual({ temperature: 0.2, num_predict: 64 });
  });

  it('batches small deltas into fewer chunks than tokens', async () => {
    const reply = Array.from({ length: 40 }, (_, i) => `t${i} `);
    ollama = fakeOllama({ reply, delayMs: 0 });
    gw = fakeGateway();
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const res = await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 40 });
    expect(res.ok).toBe(true);
    expect(gw.state.chunks.length).toBeLessThan(reply.length);
    expect(gw.state.chunks.map((c) => c.delta).join('')).toBe(reply.join(''));
  });

  it('reports fail when Ollama errors', async () => {
    ollama = fakeOllama({ chatError: { status: 404, message: "model 'nope' not found" } });
    gw = fakeGateway();
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const res = await runJob(job({ model: 'nope' }), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl));
    expect(res.ok).toBe(false);
    expect(gw.state.done).toHaveLength(0);
    expect(gw.state.failed).toHaveLength(1);
    expect(gw.state.failed[0].error).toMatch(/not found/);
  });

  it('honours deadlineMs: aborts a slow stream and reports fail', async () => {
    ollama = fakeOllama({ reply: Array.from({ length: 50 }, () => 'x'), delayMs: 40 });
    gw = fakeGateway();
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const started = Date.now();
    const res = await runJob(job({ deadlineMs: 150 }), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/deadline/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(gw.state.failed[0].error).toMatch(/deadline/);
  });

  it('stops generating on 409 job_not_running and does not POST fail', async () => {
    ollama = fakeOllama({ reply: Array.from({ length: 30 }, () => 'y'), delayMs: 10 });
    gw = fakeGateway({ chunkStatus: 409 });
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const res = await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer running/);
    expect(gw.state.done).toHaveLength(0);
    expect(gw.state.failed).toHaveLength(0);
    expect(res.durationMs).toBeLessThan(250); // did not wait for all 30 tokens
  });

  it('retries a chunk once on a transient 5xx with the same seq', async () => {
    ollama = fakeOllama({ reply: ['a', 'b'] });
    gw = fakeGateway({ chunkStatus: 503 });
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    // First chunk POST fails with 503; the fake flips to healthy, so the retry lands.
    const gateway = new GatewayClient(gwUrl, gw.state.token);
    const orig = gw.state;
    let calls = 0;
    gw.server.prependListener('request', () => {
      calls++;
      if (calls >= 2) orig.chunkStatus = undefined;
    });
    const res = await runJob(job(), gateway, gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1000 });
    expect(res.ok).toBe(true);
    expect(gw.state.chunks).toEqual([{ jobId: 'job_1', seq: 0, delta: 'ab' }]);
  });
});

describe('runJob failure paths', () => {
  let ollama: ReturnType<typeof fakeOllama>;
  let gw: ReturnType<typeof fakeGateway>;
  afterEach(async () => {
    await Promise.all([ollama?.stop(), gw?.stop()]);
  });
  const run = (j: Job, opts = {}) => runJob(j, new GatewayClient(gw.state.token ? gwUrl : gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1, ...opts });
  let ollamaUrl = '';
  let gwUrl = '';
  const boot = async (o: Parameters<typeof fakeOllama>[0], g: Parameters<typeof fakeGateway>[0] = {}) => {
    ollama = fakeOllama(o);
    gw = fakeGateway(g);
    [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
  };

  it('an Ollama error line mid-stream POSTs fail (not done) and keeps the chunks already sent', async () => {
    await boot({ reply: ['a', 'b', 'c', 'd'], streamErrorAfter: 2, delayMs: 2 });
    const res = await run(job());
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('failed');
    expect(gw.state.done).toHaveLength(0);
    expect(gw.state.failed).toHaveLength(1);
    expect(gw.state.failed[0].error).toMatch(/runner process has terminated/);
    expect(gw.state.chunks.map((c) => c.delta).join('')).toBe('ab');
  });

  it('a connection dropped mid-stream POSTs fail with a reason that names no text', async () => {
    await boot({ reply: ['x', 'y', 'z'], dropAfter: 1, delayMs: 2 });
    const res = await run(job());
    expect(res.ok).toBe(false);
    expect(gw.state.failed).toHaveLength(1);
    expect(gw.state.failed[0].error).toMatch(/stream ended unexpectedly|aborted|terminated/);
  });

  it('garbage in the stream is reported without echoing the bytes (JSON.parse messages quote input)', async () => {
    await boot({ reply: ['x', 'y', 'z'], garbageAfter: 1, delayMs: 2 });
    const res = await run(job());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/malformed JSON on line 2/);
    expect(res.error).not.toContain('SECRET_GARBAGE_LINE');
    expect(gw.state.failed[0].error).not.toContain('SECRET_GARBAGE');
  });

  it('a stalled Ollama (headers, then silence) fails after stallMs instead of hanging forever', async () => {
    await boot({ hang: true });
    const started = Date.now();
    const res = await run(job({ deadlineMs: null }), { stallMs: 120 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/produced nothing for 0s/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(gw.state.failed).toHaveLength(1);
  });

  it('an empty reply is reported as a failure, never as done', async () => {
    await boot({ reply: [] });
    const res = await run(job());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no output/);
    expect(gw.state.done).toHaveLength(0);
    expect(gw.state.failed).toHaveLength(1);
  });

  it('409 empty_output from /done is logged and swallowed: no /fail, no throw', async () => {
    await boot({ reply: ['hi'] }, { doneStatus: { status: 409, error: 'empty_output' } });
    const lines: string[] = [];
    const res = await run(job(), { log: (m: string) => lines.push(m) });
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('gateway_rejected');
    expect(gw.state.failed).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/abandoned .*empty_output/);
  });

  it('409 job_not_running from /done (job cancelled while we finished) does not POST fail', async () => {
    await boot({ reply: ['hi'] }, { doneStatus: { status: 409, error: 'job_not_running' } });
    const res = await run(job());
    expect(res.outcome).toBe('gateway_rejected');
    expect(gw.state.failed).toHaveLength(0);
  });

  it('missing Ollama counts fall back to a chars/4 estimate, capped by maxTokens', async () => {
    await boot({ reply: ['twelve chars', ' and twelve.'], omitCounts: true });
    const res = await run(job({ maxTokens: 4 }));
    expect(res.ok).toBe(true);
    expect(res.completionTokens).toBe(4); // 24 chars -> 6, capped to maxTokens 4
    expect(res.promptTokens).toBe(1); // 'hi' -> ceil(2/4) = 1
    expect(gw.state.done[0].body).toMatchObject({ promptTokens: 1, completionTokens: 4 });
  });

  it('a malformed job (no messages / no model) is failed cleanly and never rejects', async () => {
    await boot({ reply: ['x'] });
    const bad = await run({ jobId: 'j_bad', model: 'm', messages: undefined as unknown as Job['messages'] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no messages/);
    expect(gw.state.failed.map((f) => f.jobId)).toEqual(['j_bad']);
    const worse = await run({} as Job);
    expect(worse.ok).toBe(false);
    expect(worse.error).toMatch(/malformed job/);
  });

  it('a Retry-After on a transient chunk failure is honoured on the single retry', async () => {
    await boot({ reply: ['a'] }, { failNext: { count: 1, status: 503, retryAfter: '0' } });
    const res = await run(job());
    expect(res.ok).toBe(true);
    expect(gw.state.chunks).toHaveLength(1);
  });
});

describe('mapping helpers', () => {
  it('sanitizeReason flattens control characters and caps the length the gateway accepts', () => {
    expect(sanitizeReason('a\r\nb\u0000c')).toBe('a b c');
    expect(sanitizeReason('')).toBe('unknown error');
    const long = sanitizeReason('x'.repeat(2000));
    expect(long.length).toBeLessThanOrEqual(MAX_FAIL_REASON_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('usageFromFinal prefers Ollama counts and estimates only what is missing', () => {
    expect(usageFromFinal({ promptTokens: 10, completionTokens: 20, doneReason: 'stop' }, 400, 400, 1000)).toEqual({ promptTokens: 10, completionTokens: 20 });
    expect(usageFromFinal({ promptTokens: null, completionTokens: null, doneReason: 'stop' }, 400, 9, null)).toEqual({ promptTokens: 100, completionTokens: 3 });
    expect(usageFromFinal({ promptTokens: null, completionTokens: 50, doneReason: 'length' }, 0, 200, 32)).toEqual({ promptTokens: 0, completionTokens: 32 });
  });

  it('flattens OpenAI content arrays', () => {
    expect(
      toOllamaMessages([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] },
        { role: 'assistant', content: null },
      ]),
    ).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'ab' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('maps params + maxTokens to Ollama options and drops unknowns', () => {
    expect(toOllamaOptions({ temperature: 0.7, top_p: 0.9, stop: 'END', foo: 1, max_tokens: 10 }, 256)).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      stop: ['END'],
      num_predict: 256,
    });
    expect(toOllamaOptions({ max_tokens: 10 }, null)).toEqual({ num_predict: 10 });
    expect(toOllamaOptions(undefined, undefined)).toEqual({});
  });

  it('treats deadlineMs as absolute when it looks like a unix-ms timestamp', () => {
    const now = 1_700_000_000_000;
    expect(deadlineBudget(30_000, now)).toBe(30_000);
    expect(deadlineBudget(now + 5000, now)).toBe(5000);
    expect(deadlineBudget(null, now)).toBeNull();
    expect(deadlineBudget(0, now)).toBeNull();
  });
});
