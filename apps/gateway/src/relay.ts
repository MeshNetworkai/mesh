import { upstreamModelFor } from '@mesh/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { AppContext } from './context.js';
import { nowSec, recordError } from './db.js';
import { addNodeReward, nodeRewardMicros } from './ledger.js';
import { microsToUsd } from './money.js';
import type { JobUsage } from './network.js';
import { syncPoints } from './points.js';
import { decideRoute, eligibleNodes, type PrivacyChoice, type RouteDecision } from './routing.js';
import { listCostMicros, savedMicros } from './savings.js';
import { applyMultiplier } from './staking.js';
import { getNode } from './routes/nodes.js';
import { SseUsageScanner, UpstreamError, costMicros, describeUpstreamError, normalizeUsage, type Usage } from './upstream.js';
import { recordUsageShare } from './usage-share.js';

/**
 * Chat relay shared by `/v1/chat/completions` (API-key accounts) and `/v1/guest/chat` (treasury-paid
 * guests): route decision, node network leg with one retry, upstream fallback, SSE pass-through and
 * usage accounting. Who pays is abstracted behind `ChatAccount`; the wire shape is identical.
 */

/** Sampling params forwarded to a node verbatim (OpenAI names; the node maps them to Ollama options). */
const NODE_PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'repeat_penalty', 'response_format'] as const;

/** Micro-USD charged to the user for a network-served request: flat price per 1M total tokens. */
export function networkCostMicros(totalTokens: number, networkPricePerMTokens: number): number {
  // Round up: a tiny answer costs at least one micro-dollar, never nothing (observed: 20 tokens at
  // $0.02/M rounded to $0 and the request was free).
  return totalTokens > 0 ? Math.max(1, Math.ceil(totalTokens * networkPricePerMTokens)) : 0;
}

export function openaiError(reply: FastifyReply, status: number, message: string, type: string, code?: string) {
  return reply.code(status).send({ error: { message, type, code: code ?? null, param: null } });
}

export interface RecordInput {
  model: string;
  usage: Usage | null;
  /** `node:<id>` or the upstream name. */
  upstream: string;
  latencyMs: number;
  stream: boolean;
  /** Network-served requests: the flat network price and the list price it replaced. */
  network?: { costMicros: number; listCostMicros: number };
}

/** Who a relayed request is billed to. */
export interface ChatAccount {
  /** Wallet the job is queued under (`jobs.wallet`) and the owner-rule requester; a sentinel for guests. */
  wallet: string;
  apiKeyId: number | null;
  /** Write the request log / ledgers once usage is known; returns micro-USD charged (0 when free to the caller). */
  record(input: RecordInput): number;
  /** Credit balance for `x-mesh-balance-usd` on non-stream responses; omitted → header not sent. */
  balanceMicros?(): number;
  /**
   * The caller really pays (credits debited): the margin on the request may feed the usage-revenue
   * share (usage-share.ts). Absent/false for treasury-paid guests, which never contribute.
   */
  paid?: boolean;
}

/**
 * Usage-revenue share hook (usage-share.ts): books `holderBps` of a paid request's positive margin into
 * the next holder pool. `billed` is what the account was charged, `cost` what the request cost Mesh.
 * No-op unless the account pays and usageShare is enabled.
 */
function shareUsageMargin(ctx: AppContext, account: ChatAccount, input: { source: 'network' | 'upstream'; ref: string; model: string; billed: number; cost: number }) {
  if (!account.paid || !ctx.config.usageShare.enabled || input.billed <= 0) return null;
  return recordUsageShare(ctx.db, ctx.config.usageShare, { source: input.source, ref: input.ref, wallet: account.wallet, model: input.model, billedMicros: input.billed, costMicros: input.cost });
}

export interface RelayOptions {
  account: ChatAccount;
  body: Record<string, unknown>;
  model: string;
  privacy: PrivacyChoice;
  stream: boolean;
  started: number;
  /** Force the upstream leg to ZDR providers regardless of what the tier implies. */
  zdr?: boolean;
}

type NetworkOutcome = { kind: 'served' } | { kind: 'errored' } | { kind: 'fallback'; reason: string; jobId: string };

/** Why the request ended up where it did (final-chunk `mesh.routeReason`): idle node, queued behind busy nodes, or the upstream and why. */
export type RouteReason = 'node' | 'queued_then_node' | 'queue_timeout' | 'queue_full' | RouteDecision['reason'] | 'node_failed';

/** A header value that can never carry a CR/LF or other control character (node-supplied error text ends up in `x-mesh-fallback`). */
export function headerSafe(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
}

/**
 * Fires once when the client goes away before the response has ended. `IncomingMessage` 'close' is not
 * enough on its own: since Node 16 it fires when the request body has been consumed, and behind a reverse
 * proxy the signal that matters is the connection closing under us. Listen on the response and the
 * socket too, and treat any of them closing before `writableEnded` as the client being gone.
 */
export function onClientGone(req: FastifyRequest, reply: FastifyReply, cb: () => void): void {
  let fired = false;
  const raw = reply.raw;
  const fire = () => {
    if (fired || raw.writableEnded) return;
    fired = true;
    cb();
  };
  raw.on('close', fire);
  req.raw.on('aborted', fire);
  req.raw.socket?.on('close', fire);
}

/**
 * SSE writer with backpressure: when the socket buffer is full, wait for `drain` — or for the
 * connection to close, so a client that goes away mid-wait can never park the handler forever
 * (`raw.write` on a destroyed socket returns false and no `drain` ever follows).
 */
export function sseWriter(raw: ServerResponse): (text: string) => Promise<void> {
  return async (text: string) => {
    if (!text || raw.writableEnded || raw.destroyed) return;
    if (raw.write(text) || raw.destroyed) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        raw.off('drain', done);
        raw.off('close', done);
        resolve();
      };
      raw.once('drain', done);
      raw.once('close', done);
    });
  };
}

let upstreamSeq = 0;
/** Unique ref for an upstream-served request's usage-share row (there is no job id on that leg). */
function upstreamRef(account: ChatAccount, started: number): string {
  upstreamSeq = (upstreamSeq + 1) % 1_000_000;
  return `usage:up:${account.wallet}:${started.toString(36)}:${process.pid.toString(36)}:${upstreamSeq.toString(36)}`;
}

/** Map a failed upstream Response to our own error; never charges. */
export async function upstreamFailure(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, res: Response) {
  const detail = await describeUpstreamError(res);
  const status = res.status >= 500 || res.status < 400 ? 502 : res.status;
  const code = res.status === 429 ? 'upstream_rate_limited' : res.status === 404 ? 'model_not_found' : 'upstream_error';
  req.log.warn({ upstreamStatus: res.status, detail }, 'upstream returned an error');
  recordError(ctx.db, { route: req.url, status, code, message: `upstream ${res.status}: ${detail}` });
  return openaiError(reply, status, `Upstream (${ctx.upstream.name}) error ${res.status}: ${detail}`, 'upstream_error', code);
}

export function upstreamThrow(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, err: unknown) {
  const kind = err instanceof UpstreamError ? err.kind : 'network';
  const message =
    kind === 'timeout'
      ? `Upstream (${ctx.upstream.name}) timed out after ${ctx.env.UPSTREAM_TIMEOUT_MS}ms. You were not charged.`
      : `Upstream (${ctx.upstream.name}) is unreachable. You were not charged.`;
  req.log.error({ err }, 'upstream request failed');
  recordError(ctx.db, { route: req.url, status: 502, code: `upstream_${kind}`, message: (err as Error).message });
  return openaiError(reply, 502, message, 'upstream_error', `upstream_${kind}`);
}

/**
 * Serve one chat completion through the node network: queue a job, wait for a node to claim it and
 * stream chunks back as OpenAI SSE (or buffer for non-stream). On a failure before anything reached
 * the client the job is retried once on another node, else the caller falls back to the upstream.
 * Once partial output was sent there is no fallback: the error is surfaced in-stream.
 */
async function serveFromNetwork(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  account: ChatAccount,
  body: Record<string, unknown>,
  model: string,
  route: RouteDecision & { tag: string },
  stream: boolean,
  started: number,
): Promise<NetworkOutcome> {
  const { tag, trustedOnly } = route;
  const queued = route.reason === 'queued';
  const requesterWallet = route.requesterWallet ?? account.wallet;
  const routing = ctx.config.routing;
  /** `servedBy` for the node that took the job: "your node" when a trusted request landed on the requester's own Mac. */
  const servedByFor = (nodeId: string | null): RouteDecision['servedBy'] => {
    if (route.privacy !== 'trusted' || !nodeId) return route.servedBy;
    return getNode(ctx, nodeId)?.wallet === requesterWallet ? 'your node' : route.servedBy;
  };
  // Only whitelisted sampling params travel to the node: never `user`, `metadata`, tool ids or
  // anything else the client attached (docs/PRIVACY.md).
  const params: Record<string, unknown> = {};
  for (const k of NODE_PARAM_KEYS) if (body[k] !== undefined) params[k] = body[k];
  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : routing.defaultMaxTokens;
  const id = `chatcmpl-mesh-${Date.now().toString(36)}`;
  const created = nowSec();
  const raw = reply.raw;
  const enc = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  let headersWritten = false;
  let clientGone = false;
  // Wake the relay wait immediately when the client goes away so the job is abandoned (and the
  // node told to stop via 409) now, not after the first-token/stall budget expires.
  let liveRelay: { close(): void } | null = null;
  onClientGone(req, reply, () => {
    clientGone = true;
    liveRelay?.close();
  });
  const writeHeaders = (nodeId: string, servedBy: RouteDecision['servedBy']) => {
    if (headersWritten) return;
    headersWritten = true;
    reply.hijack();
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'x-mesh-route': `node:${nodeId}`,
      'x-mesh-privacy': route.privacy,
      'x-mesh-served-by': servedBy,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.flushHeaders?.();
  };
  const write = sseWriter(raw);

  let exclude: string | null = null;
  let parent: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { job, relay } = ctx.broker.create({
      model,
      tag,
      wallet: account.wallet,
      apiKeyId: account.apiKeyId,
      payload: { messages: body.messages as unknown[], params },
      maxTokens,
      deadlineMs: Date.now() + routing.jobTimeoutMs,
      privacy: trustedOnly ? 'trusted' : 'network',
      requesterWallet,
      excludeNodeId: exclude,
      parentJobId: parent,
      attempt,
    });
    liveRelay = relay;
    req.log.info({ jobId: job.job_id, tag, attempt, exclude, queued }, 'network job queued');
    const createdMs = Date.now();
    /** Non-stream reply body (what the client gets) and, for every mode, the full text kept in memory for a possible spot check. */
    const text: string[] = [];
    const full: string[] = [];
    let nodeId: string | null = null;
    let claimedMs: number | null = null;
    let servedBy: RouteDecision['servedBy'] = route.servedBy;
    let sent = 0;
    let usage: JobUsage | null = null;
    let failure: { error: string; nodeFault: boolean } | null = null;

    for (;;) {
      const now = Date.now();
      // Budgets: an idle-routed job gets firstTokenTimeoutMs from creation for claim + first token (as
      // before). A queued job (every node busy) first waits up to queueWaitMs for a claim, then gets
      // the full firstTokenTimeoutMs from the claim. After the first chunk the stall timeout applies.
      let budget: number;
      if (sent > 0) budget = routing.stallTimeoutMs;
      else if (queued && claimedMs === null) budget = routing.queueWaitMs - (now - createdMs);
      else if (queued) budget = routing.firstTokenTimeoutMs - (now - claimedMs!);
      else budget = routing.firstTokenTimeoutMs - (now - createdMs);
      const ev = await relay.next(Math.max(0, Math.min(budget, job.deadline_ms - now)));
      if (clientGone) {
        failure = { error: 'client_disconnected', nodeFault: false };
        break;
      }
      if (ev.type === 'claimed') {
        nodeId = ev.nodeId;
        claimedMs = Date.now();
        servedBy = servedByFor(nodeId);
      } else if (ev.type === 'chunk') {
        if (stream) {
          writeHeaders(nodeId ?? 'unknown', servedBy);
          await write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: sent === 0 ? { role: 'assistant', content: ev.delta } : { content: ev.delta }, finish_reason: null }] }));
          if (clientGone) {
            failure = { error: 'client_disconnected', nodeFault: false };
            break;
          }
        } else text.push(ev.delta);
        full.push(ev.delta);
        sent++;
      } else if (ev.type === 'done') {
        usage = ev.usage;
      } else if (ev.type === 'fail') {
        failure = { error: `node_error: ${ev.error}`, nodeFault: true };
      } else {
        const expired = Date.now() >= job.deadline_ms;
        const error = expired ? 'deadline_exceeded' : sent === 0 ? (nodeId ? 'first_token_timeout' : queued ? 'queue_timeout' : 'unclaimed') : 'stall_timeout';
        failure = { error, nodeFault: nodeId !== null };
      }
      if (usage || failure) break;
    }

    if (usage && nodeId) {
      ctx.broker.release(job.job_id);
      const node = getNode(ctx, nodeId);
      const u: Usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens };
      const tokens = u.total_tokens!;
      const pricing = ctx.config.requestPricing;
      const price = networkCostMicros(tokens, pricing.networkPricePerMTokens);
      // What the upstream would have charged for the same tokens at the model's list price.
      const listCost = listCostMicros(u, model, ctx.prices, ctx.policy);
      const saved = savedMicros(listCost, price);
      // Stake tier of the node's reward wallet multiplies the reward (staking.ts; 1× when unstaked / not wired).
      const stake = node && ctx.stakes ? await ctx.stakes.resolve(node.wallet).catch(() => null) : null;
      const rewardMultiplier = stake?.multiplier ?? 1;
      const reward = applyMultiplier(nodeRewardMicros(tokens, ctx.config.nodeRewards.usdPerMTokens), rewardMultiplier);
      let cost = 0;
      ctx.db.transaction(() => {
        cost = account.record({ model, usage: u, upstream: `node:${nodeId}`, latencyMs: Date.now() - started, stream, network: { costMicros: price, listCostMicros: listCost } });
        if (node) addNodeReward(ctx.db, { wallet: node.wallet, nodeId, jobId: job.job_id, tokens, usdMicros: reward });
        // Engine 2: the network margin (what the user paid − what the node earned) feeds the holder pool.
        shareUsageMargin(ctx, account, { source: 'network', ref: `usage:job:${job.job_id}`, model, billed: cost, cost: reward });
      })();
      syncPoints(ctx.db, ctx.config.points); // node operator's points for the tokens served
      // Spot-check verification (verification.ts): decided now, run in the background after the reply is out.
      const verifying = node && ctx.verifier ? ctx.verifier.maybeSchedule({ job: ctx.broker.get(job.job_id) ?? job, nodeId, nodeWallet: node.wallet, text: full.join(''), usage }) : false;
      const usageOut = { ...u, cost: microsToUsd(cost) };
      const routeReason: RouteReason = queued ? 'queued_then_node' : 'node';
      const mesh = {
        route: 'node',
        routeReason,
        nodeId,
        chip: node?.chip ?? null,
        jobId: job.job_id,
        attempt,
        privacy: route.privacy,
        servedBy,
        ...(queued && claimedMs !== null ? { queuedMs: claimedMs - createdMs } : {}),
        ...(pricing.showSavings ? { listCostUsd: microsToUsd(listCost), savedUsd: microsToUsd(saved) } : {}),
      };
      req.log.info({ jobId: job.job_id, nodeId, tokens, costUsd: microsToUsd(cost), listCostUsd: microsToUsd(listCost), savedUsd: microsToUsd(saved), rewardUsd: microsToUsd(reward), rewardMultiplier, stakeTier: stake?.tier.name ?? null, servedBy, routeReason, verifying }, 'chat completion (node)');
      if (stream) {
        writeHeaders(nodeId, servedBy);
        await write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: usage.finishReason }], usage: usageOut, mesh }));
        await write('data: [DONE]\n\n');
        if (!raw.writableEnded) raw.end();
        return { kind: 'served' };
      }
      reply.header('x-mesh-route', `node:${nodeId}`);
      reply.header('x-mesh-privacy', route.privacy);
      reply.header('x-mesh-served-by', servedBy);
      reply.header('x-mesh-cost-usd', microsToUsd(cost).toString());
      if (pricing.showSavings) reply.header('x-mesh-saved-usd', microsToUsd(saved).toString());
      if (account.balanceMicros) reply.header('x-mesh-balance-usd', microsToUsd(account.balanceMicros()).toString());
      await reply.send({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text.join('') }, finish_reason: usage.finishReason }],
        usage: usageOut,
        mesh,
      });
      return { kind: 'served' };
    }

    const f = failure ?? { error: 'done_without_node', nodeFault: false };
    if (f.error === 'client_disconnected') {
      ctx.broker.abandon(job.job_id, 'failed', f.error, false);
      if (headersWritten && !raw.writableEnded) raw.end();
      req.log.info({ jobId: job.job_id, nodeId }, 'client disconnected during network job');
      return { kind: 'errored' };
    }
    // Partial output already reached the client: no retry, no fallback. Surface the error in-stream.
    if (stream && sent > 0) {
      ctx.broker.abandon(job.job_id, 'failed', f.error, f.nodeFault);
      recordError(ctx.db, { route: req.url, status: 502, code: 'node_stream_failed', message: `${f.error} (job ${job.job_id}, node ${nodeId})` });
      req.log.warn({ jobId: job.job_id, nodeId, error: f.error, sent }, 'node failed after partial output; not charged');
      await write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: `Mesh node failed mid-stream (${f.error}). You were not charged.`, type: 'upstream_error', code: 'node_stream_failed' }, mesh: { route: 'node', routeReason: 'node_failed', nodeId, jobId: job.job_id, privacy: route.privacy, servedBy } }));
      await write('data: [DONE]\n\n');
      if (!raw.writableEnded) raw.end();
      return { kind: 'errored' };
    }
    // Nothing sent yet: retry once on a different node (of the same tier) if one is available, else fall back.
    const others = nodeId ? eligibleNodes(ctx, tag, { exclude: nodeId, trustedOnly, requesterWallet }) : [];
    if (attempt === 1 && others.length > 0) {
      ctx.broker.abandon(job.job_id, 'failed', f.error, f.nodeFault);
      req.log.warn({ jobId: job.job_id, nodeId, error: f.error, next: others[0].node_id }, 'network job failed; re-queueing once');
      exclude = nodeId;
      parent = job.job_id;
      continue;
    }
    ctx.broker.abandon(job.job_id, 'fallback', f.error, f.nodeFault);
    return { kind: 'fallback', reason: f.error, jobId: job.job_id };
  }
  /* unreachable */
  return { kind: 'fallback', reason: 'exhausted', jobId: '' };
}

/**
 * Relay one validated chat request: Mesh node network first (when the tier and model allow), else
 * the upstream; SSE or JSON per `stream`. Returns true when a 200 was produced (the account was
 * recorded), false when an error response was sent and nothing was charged. Headers already set on
 * `reply` by the caller are kept on both the hijacked SSE path and the JSON path.
 */
export async function relayChat(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, opts: RelayOptions): Promise<boolean> {
  const { account, body, model: requestedModel, stream, started } = opts;
  // ---- Mesh node network first (when enabled and an idle node of the right tier advertises the model's tag) ----
  // The account's wallet is the requester: its own nodes count as trusted for this request (owner rule).
  const route = decideRoute(ctx, requestedModel, opts.privacy, { requesterWallet: account.wallet });
  const zdr = opts.zdr ?? route.zdr;
  // Served-by for the upstream leg; a node failure keeps the tier's ZDR choice.
  const upstreamServedBy = zdr ? 'upstream (ZDR)' : 'upstream';
  const upstreamPrivacy = zdr ? 'upstream_zdr' : 'network';
  let routeReason: RouteReason = route.reason;
  if (route.target === 'node' && route.tag) {
    const outcome = await serveFromNetwork(ctx, req, reply, account, body, requestedModel, route as RouteDecision & { tag: string }, stream, started);
    if (outcome.kind === 'served') return true;
    if (outcome.kind === 'errored') return false;
    reply.header('x-mesh-fallback', headerSafe(outcome.reason));
    routeReason = outcome.reason === 'queue_timeout' ? 'queue_timeout' : 'node_failed';
    req.log.warn({ model: requestedModel, reason: outcome.reason, jobId: outcome.jobId, zdr, queued: route.reason === 'queued' }, 'network job failed before any output; falling back to upstream');
  } else if (route.reason === 'no_trusted_node' || route.reason === 'queue_full') {
    reply.header('x-mesh-fallback', route.reason);
  }
  reply.header('x-mesh-route', ctx.upstream.name);
  reply.header('x-mesh-privacy', upstreamPrivacy);
  reply.header('x-mesh-served-by', upstreamServedBy);
  const meshUpstream = { route: ctx.upstream.name, routeReason, privacy: upstreamPrivacy, servedBy: upstreamServedBy };

  let upstreamRes: Response;
  try {
    // Short aliases (llama-3.1-8b) are translated to the upstream's own id; the reply keeps the requested name.
    const upstreamModel = upstreamModelFor(ctx.policy, requestedModel);
    upstreamRes = await ctx.upstream.chat(upstreamModel === requestedModel ? body : { ...body, model: upstreamModel }, { zdr });
  } catch (err) {
    await upstreamThrow(ctx, req, reply, err);
    return false;
  }

  // Upstream error: clear JSON error, charge nothing.
  if (!upstreamRes.ok) {
    await upstreamFailure(ctx, req, reply, upstreamRes);
    return false;
  }

  if (!stream) {
    let json: { model?: string; usage?: Usage; error?: unknown };
    try {
      json = (await upstreamRes.json()) as typeof json;
    } catch (err) {
      await upstreamThrow(ctx, req, reply, new UpstreamError(`invalid JSON from upstream: ${(err as Error).message}`, 'network'));
      return false;
    }
    if (json.error) {
      recordError(ctx.db, { route: req.url, status: 502, code: 'upstream_error', message: JSON.stringify(json.error).slice(0, 300) });
      await openaiError(reply, 502, `Upstream (${ctx.upstream.name}) returned an error. You were not charged.`, 'upstream_error', 'upstream_error');
      return false;
    }
    const model = typeof json.model === 'string' && json.model ? json.model : requestedModel;
    const usage = normalizeUsage(json.usage);
    let cost = 0;
    ctx.db.transaction(() => {
      cost = account.record({ model, usage, upstream: ctx.upstream.name, latencyMs: Date.now() - started, stream: false });
      // Engine 2: upstream margin = billed (list ± markup/discount) − upstream cost (list). Negative under a discount → nothing.
      shareUsageMargin(ctx, account, { source: 'upstream', ref: upstreamRef(account, started), model, billed: cost, cost: costMicros(usage, model, ctx.prices) });
    })();
    reply.header('x-mesh-cost-usd', microsToUsd(cost).toString());
    if (account.balanceMicros) reply.header('x-mesh-balance-usd', microsToUsd(account.balanceMicros()).toString());
    await reply.send({ ...json, mesh: meshUpstream });
    return true;
  }

  // ---- streaming: pass SSE through, scan for usage, account at the end ----
  if (!upstreamRes.body) {
    await openaiError(reply, 502, 'Upstream returned no body', 'upstream_error', 'upstream_error');
    return false;
  }
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders?.();

  const scanner = new SseUsageScanner();
  const decoder = new TextDecoder();
  const reader = upstreamRes.body.getReader();
  let aborted = false;
  onClientGone(req, reply, () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  });
  // Pass lines through as they complete; just before the upstream's `data: [DONE]` add one chunk
  // carrying `mesh` (privacy tier + served-by) so clients see the same final-chunk shape as for nodes.
  // Built when needed so it can repeat the usage the upstream reported (clients that read "the last
  // chunk with usage" keep working).
  const meshChunk = () =>
    `data: ${JSON.stringify({ id: `chatcmpl-mesh-${started.toString(36)}`, object: 'chat.completion.chunk', created: Math.floor(started / 1000), model: scanner.model ?? requestedModel, choices: [], ...(scanner.usage ? { usage: scanner.usage } : {}), mesh: meshUpstream })}\n\n`;
  let pending = '';
  let doneSeen = false;
  const writeOut = sseWriter(raw);
  const relayText = async (text: string, flush = false) => {
    pending += text;
    let out = '';
    let idx: number;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx + 1);
      pending = pending.slice(idx + 1);
      if (!doneSeen && line.replace(/\r?\n$/, '').trim() === 'data: [DONE]') {
        doneSeen = true;
        out += meshChunk();
      }
      out += line;
    }
    if (flush) {
      out += pending;
      pending = '';
    }
    await writeOut(out);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const text = decoder.decode(value, { stream: true });
      scanner.push(text);
      await relayText(text);
    }
    const tail = decoder.decode();
    scanner.push(tail);
    await relayText(tail, true);
    if (!doneSeen) await writeOut(meshChunk());
  } catch (err) {
    if (!aborted) req.log.error({ err }, 'stream relay failed');
  } finally {
    scanner.end();
    if (!raw.writableEnded) raw.end();
    const model = scanner.model ?? requestedModel;
    if (scanner.error && !scanner.usage) {
      // Upstream failed mid-stream before reporting usage: no charge, but remember it.
      recordError(ctx.db, { route: req.url, status: 502, code: 'upstream_stream_error', message: scanner.error.message });
      req.log.warn({ wallet: account.wallet, model, error: scanner.error }, 'upstream error inside stream; not charged');
    } else {
      // Charge whatever the upstream reported (or fallback from tokens) even if client disconnected.
      let cost = 0;
      ctx.db.transaction(() => {
        cost = account.record({ model, usage: scanner.usage, upstream: ctx.upstream.name, latencyMs: Date.now() - started, stream: true });
        shareUsageMargin(ctx, account, { source: 'upstream', ref: upstreamRef(account, started), model, billed: cost, cost: costMicros(scanner.usage, model, ctx.prices) });
      })();
      req.log.info({ wallet: account.wallet, model, costUsd: microsToUsd(cost), aborted }, 'chat completion (stream)');
    }
  }
  return true;
}
