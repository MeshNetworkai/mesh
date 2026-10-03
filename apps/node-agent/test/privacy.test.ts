import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient, type Job } from '../src/gateway.js';
import { createLogger } from '../src/log.js';
import { DEFAULT_KEEP_ALIVE, OLLAMA_PRIVACY_ENV, OllamaClient } from '../src/ollama.js';
import { runJob, scrubJob } from '../src/runner.js';
import { renderPlist } from '../src/service.js';
import { fakeGateway, fakeOllama } from './fakes.js';

/**
 * Node-side privacy (docs/PRIVACY.md): prompts and replies never reach a log line or disk, Ollama is
 * called with the privacy flags, and in-memory copies are dropped once a job is over.
 */

const PROMPT = 'SECRET_PROMPT_my_salary_is_42k';
const SYSTEM = 'SECRET_SYSTEM_do_not_reveal';
const REPLY = ['SECRET_REPLY_part_one', ' SECRET_REPLY_part_two'];

const job = (over: Partial<Job> = {}): Job => ({
  jobId: 'job_p1',
  model: 'llama3.1:8b',
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [{ type: 'text', text: PROMPT }] },
  ],
  params: { temperature: 0 },
  maxTokens: 32,
  deadlineMs: 10_000,
  attempt: 1,
  ...over,
});

describe('node agent privacy', () => {
  let ollama: ReturnType<typeof fakeOllama> | undefined;
  let gw: ReturnType<typeof fakeGateway> | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await Promise.all([ollama?.stop(), gw?.stop()]);
    if (dir) rmSync(dir, { recursive: true, force: true });
    ollama = gw = dir = undefined;
  });

  it('the log lines for a job carry ids, counts and timings only: no prompt, system or reply text', async () => {
    ollama = fakeOllama({ reply: REPLY, promptTokens: 9 });
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const lines: string[] = [];
    const res = await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1, log: (m) => lines.push(m) });
    expect(res.ok).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of [PROMPT, SYSTEM, ...REPLY.map((r) => r.trim()), 'salary', 'do_not_reveal']) expect(all).not.toContain(secret);
    // what IS there
    expect(all).toMatch(/job job_p1 done model=llama3\.1:8b tokens=9\+2 chunks=\d+ chars=\d+ \d+ms/);
    // the failure path logs the reason, never the content either
    ollama && (await ollama.stop());
    ollama = fakeOllama({ chatError: { status: 500, message: 'boom' } });
    const url2 = await ollama.start();
    const failLines: string[] = [];
    await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(url2), { log: (m) => failLines.push(m) });
    expect(failLines.join('\n')).not.toContain(PROMPT);
    expect(failLines.join('\n')).toMatch(/job job_p1 failed after \d+ms: .*boom/);
  });

  it('the file logger writes exactly the lines it is given, so a job leaves no message text in node.log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mesh-priv-'));
    const file = join(dir, 'node.log');
    const log = createLogger(file);
    ollama = fakeOllama({ reply: REPLY });
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1, log: (m) => log.info(m) });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('job job_p1 done');
    for (const secret of [PROMPT, SYSTEM, ...REPLY.map((r) => r.trim())]) expect(text).not.toContain(secret);
  });

  it('Ollama is called with keep_alive and nothing but model/messages/options/stream', async () => {
    ollama = fakeOllama({ reply: REPLY });
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    await runJob(job(), new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1 });
    const chat = ollama.requests.find((r) => r.path === '/api/chat')!;
    expect(Object.keys(chat.body).sort()).toEqual(['keep_alive', 'messages', 'model', 'options', 'stream']);
    expect(chat.body.keep_alive).toBe(DEFAULT_KEEP_ALIVE);
    // jobId and attempt stay between the agent and the gateway; Ollama never sees them
    expect(JSON.stringify(chat.body)).not.toContain('job_p1');
  });

  it('after a job the message buffers are scrubbed (contents emptied, arrays truncated)', async () => {
    ollama = fakeOllama({ reply: REPLY });
    gw = fakeGateway();
    const [ollamaUrl, gwUrl] = await Promise.all([ollama.start(), gw.start()]);
    const j = job();
    const userMsg = j.messages[1];
    const res = await runJob(j, new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(ollamaUrl), { batchMs: 1 });
    expect(res.ok).toBe(true);
    expect(j.messages).toHaveLength(0);
    expect(userMsg.content).toBe('');
    // the gateway still received the full reply before the scrub
    expect(gw.state.chunks.map((c) => c.delta).join('')).toBe(REPLY.join(''));
    // scrubbing is also applied on the failure path
    ollama && (await ollama.stop());
    ollama = fakeOllama({ chatError: { status: 404, message: 'missing' } });
    const url2 = await ollama.start();
    const j2 = job();
    await runJob(j2, new GatewayClient(gwUrl, gw.state.token), gw.state.nodeId, new OllamaClient(url2));
    expect(j2.messages).toHaveLength(0);
  });

  it('scrubJob empties every list it is handed', () => {
    const j = job();
    const extra = [{ role: 'user', content: 'copy' }];
    scrubJob(j, extra);
    expect(j.messages).toEqual([]);
    expect(extra).toEqual([]);
    scrubJob(job({ messages: undefined as unknown as Job['messages'] })); // tolerant of a malformed job
  });

  it('the launchd service and the detached ollama serve get the privacy env (no history file, no debug logging)', () => {
    expect(OLLAMA_PRIVACY_ENV).toEqual({ OLLAMA_NOHISTORY: '1', OLLAMA_DEBUG: '0' });
    const xml = renderPlist({ node: '/usr/local/bin/node', script: '/x/mesh-node.js', home: '/Users/o/.mesh' });
    expect(xml).toContain('<key>OLLAMA_NOHISTORY</key>\n    <string>1</string>');
    expect(xml).toContain('<key>OLLAMA_DEBUG</key>\n    <string>0</string>');
  });
});
