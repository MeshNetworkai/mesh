import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export const close = (server: Server) =>
  new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export interface FakeOllamaOptions {
  /** Tokens to stream for every chat. */
  reply?: string[];
  delayMs?: number;
  promptTokens?: number;
  /** Return this HTTP error for /api/chat. */
  chatError?: { status: number; message: string };
  models?: string[];
  /** After this many tokens, send an in-stream `{error}` line (Ollama runner crash mid-reply). */
  streamErrorAfter?: number;
  /** After this many tokens, cut the connection without a final line. */
  dropAfter?: number;
  /** After this many tokens, write garbage that is not JSON. */
  garbageAfter?: number;
  /** Omit prompt_eval_count / eval_count from the final line (older Ollama, cached prompt). */
  omitCounts?: boolean;
  /** Hang after the headers: no tokens ever (stall). */
  hang?: boolean;
}

/** Speaks enough of Ollama's HTTP API for the agent: /api/tags, /api/pull, streamed /api/chat. */
export function fakeOllama(opts: FakeOllamaOptions = {}) {
  const reply = opts.reply ?? ['Hello', ' from', ' the', ' mesh', '.'];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const concurrency = { now: 0, max: 0 };
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const body = req.method === 'POST' ? await readJson(req) : {};
    requests.push({ path, body });
    if (path === '/api/tags') return json(res, 200, { models: (opts.models ?? ['llama3.1:8b']).map((name) => ({ name })) });
    if (path === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 50 }) + '\n');
      res.write(JSON.stringify({ status: 'success' }) + '\n');
      return res.end();
    }
    if (path === '/api/chat') {
      if (opts.chatError) return json(res, opts.chatError.status, { error: opts.chatError.message });
      concurrency.now++;
      concurrency.max = Math.max(concurrency.max, concurrency.now);
      const release = () => {
        concurrency.now--;
      };
      res.on('close', release);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (opts.hang) {
        res.flushHeaders();
        return; // never writes; the client closes it
      }
      let i = 0;
      for (const tok of reply) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (res.destroyed) return;
        if (opts.streamErrorAfter !== undefined && i === opts.streamErrorAfter) {
          res.write(JSON.stringify({ error: 'runner process has terminated: signal: killed' }) + '\n');
          return res.end();
        }
        if (opts.dropAfter !== undefined && i === opts.dropAfter) return res.destroy();
        if (opts.garbageAfter !== undefined && i === opts.garbageAfter) {
          res.write('this is not json SECRET_GARBAGE_LINE\n');
          return res.end();
        }
        res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: tok }, done: false }) + '\n');
        i++;
      }
      const finalLine: Record<string, unknown> = { model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' };
      if (!opts.omitCounts) {
        finalLine.prompt_eval_count = opts.promptTokens ?? 12;
        finalLine.eval_count = reply.length;
      }
      res.write(JSON.stringify(finalLine) + '\n');
      return res.end();
    }
    json(res, 404, { error: 'not found' });
  });
  return { server, requests, concurrency, start: () => listen(server), stop: () => close(server) };
}

export interface FakeGatewayState {
  registrations: Array<Record<string, unknown>>;
  heartbeats: Array<Record<string, unknown>>;
  chunks: Array<{ jobId: string; seq: number; delta: string }>;
  done: Array<{ jobId: string; body: Record<string, unknown> }>;
  failed: Array<{ jobId: string; error: string }>;
  polls: number;
  queue: Array<Record<string, unknown>>;
  token: string;
  nodeId: string;
  /** Make /chunk fail with this status (tests the fail path). */
  chunkStatus?: number;
  /** Make /done answer this status with this error code (e.g. 409 empty_output). */
  doneStatus?: { status: number; error: string };
  /** Answer the next N calls to any authenticated route with this status (5xx / 429 injection). */
  failNext?: { count: number; status: number; retryAfter?: string };
  /** Long-polls parked right now and the most seen at once. */
  pollsInFlight: number;
  maxPollsInFlight: number;
  /** How long an empty poll is held (ms). */
  pollHoldMs: number;
  /** Reject bearer tokens that do not match `token`. */
  strictAuth: boolean;
  /** Wallet reported back by /nodes/register. */
  wallet: string;
  /** When set, /nodes/register requires a link code (signed gateway); this is the one live code. */
  linkCode?: string;
  /** Codes already consumed (a second use is 400 link_code_used). */
  usedLinkCodes: string[];
}

/** Implements the node protocol surface the agent uses. Jobs are served from `state.queue`. */
export function fakeGateway(init: Partial<FakeGatewayState> = {}) {
  const state: FakeGatewayState = {
    registrations: [],
    heartbeats: [],
    chunks: [],
    done: [],
    failed: [],
    polls: 0,
    queue: [],
    token: 'tok_test',
    nodeId: 'node_test',
    strictAuth: true,
    wallet: 'walletFromGateway',
    usedLinkCodes: [],
    pollsInFlight: 0,
    maxPollsInFlight: 0,
    pollHoldMs: 60,
    ...init,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (path === '/nodes/register' && req.method === 'POST') {
      state.registrations.push(body);
      let wallet = typeof body.wallet === 'string' ? body.wallet : state.wallet;
      let linked = false;
      if (typeof body.linkCode === 'string') {
        const code = body.linkCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (state.usedLinkCodes.includes(code)) return json(res, 400, { error: 'link_code_used', message: 'already used' });
        if (code !== state.linkCode) return json(res, 400, { error: 'link_code_invalid', message: 'unknown link code' });
        wallet = state.wallet;
        linked = true;
      } else if (state.linkCode) {
        return json(res, 401, { error: 'signature_required', message: 'Registration must be signed by the reward wallet' });
      }
      if (typeof body.nodeId === 'string') {
        // Re-claiming an id needs its current token; then the token rotates. A refusal does not consume the code.
        if (body.nodeId !== state.nodeId || req.headers.authorization !== `Bearer ${state.token}`) return json(res, 409, { error: 'node_exists' });
        state.token = `${state.token}_rotated`;
        if (linked) state.usedLinkCodes.push(state.linkCode!);
        return json(res, 200, { nodeId: state.nodeId, nodeToken: state.token, wallet, walletVerified: linked, linked });
      }
      if (linked) state.usedLinkCodes.push(state.linkCode!);
      return json(res, 200, { nodeId: state.nodeId, nodeToken: state.token, wallet, walletVerified: linked, linked, heartbeatEverySec: 20, offlineAfterSec: 90, pollMaxWaitMs: 25000 });
    }
    const m = path.match(/^\/nodes\/([^/]+)(\/.*)?$/);
    if (!m) return json(res, 404, { error: 'not_found' });
    const auth = req.headers.authorization;
    if (state.strictAuth && auth !== `Bearer ${state.token}`) return json(res, 401, { error: 'unauthorized', message: 'bad node token' });
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    if (id !== state.nodeId) return json(res, 404, { error: 'node_not_found' });
    if (state.failNext && state.failNext.count > 0) {
      state.failNext.count--;
      if (state.failNext.retryAfter) res.setHeader('retry-after', state.failNext.retryAfter);
      return json(res, state.failNext.status, { error: state.failNext.status === 429 ? 'rate_limited' : 'unavailable' });
    }
    if (rest === '/heartbeat') {
      state.heartbeats.push(body);
      return json(res, 200, { ok: true, maxParallel: typeof body.maxParallel === 'number' ? Math.min(body.maxParallel as number, 4) : 1 });
    }
    if (rest === '/jobs/next') {
      state.polls++;
      const job = state.queue.shift();
      if (!job) {
        // Short "long poll" so tests stay quick.
        state.pollsInFlight++;
        state.maxPollsInFlight = Math.max(state.maxPollsInFlight, state.pollsInFlight);
        await new Promise((r) => setTimeout(r, state.pollHoldMs));
        state.pollsInFlight--;
        res.writeHead(204);
        return res.end();
      }
      return json(res, 200, job);
    }
    const jm = rest.match(/^\/jobs\/([^/]+)\/(chunk|done|fail)$/);
    if (jm) {
      const jobId = decodeURIComponent(jm[1]);
      if (jm[2] === 'chunk') {
        if (state.chunkStatus) return json(res, state.chunkStatus, { error: 'chunk_rejected' });
        state.chunks.push({ jobId, seq: body.seq as number, delta: body.delta as string });
      } else if (jm[2] === 'done') {
        if (state.doneStatus) return json(res, state.doneStatus.status, { error: state.doneStatus.error, message: state.doneStatus.error });
        state.done.push({ jobId, body });
      } else state.failed.push({ jobId, error: body.error as string });
      return json(res, 200, { ok: true });
    }
    if (rest === '' || rest === '/') {
      return json(res, 200, {
        nodeId: id,
        status: 'online',
        uptimePct24h: 99.2,
        jobs24h: state.done.length,
        tokens24h: 1234,
        earnedUsd24h: 0.42,
        earnedUsdTotal: 3.14,
        lastSeen: Math.floor(Date.now() / 1000),
      });
    }
    json(res, 404, { error: 'not_found' });
  });
  return { server, state, start: () => listen(server), stop: () => close(server) };
}
