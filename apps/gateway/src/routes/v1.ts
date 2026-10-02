import { isModelAllowed, isNetworkModel, networkModelNames } from '@mesh/config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearer, keySpendExhausted, lookupApiKey, type ApiKeyRow } from '../auth.js';
import type { AppContext } from '../context.js';
import { nowSec, recordError } from '../db.js';
import { addLedgerEntry, addNodeReward, balanceMicros, nodeRewardMicros } from '../ledger.js';
import { microsToUsd } from '../money.js';
import type { JobUsage } from '../network.js';
import { syncPoints } from '../points.js';
import { decideRoute, eligibleNodes } from '../routing.js';
import { listCostMicros, savedMicros } from '../savings.js';
import { applyMultiplier } from '../staking.js';
import { SseUsageScanner, UpstreamError, costMicros, describeUpstreamError, type Usage } from '../upstream.js';
import { getNode } from './nodes.js';

/** Sampling params forwarded to a node verbatim (OpenAI names; the node maps them to Ollama options). */
const NODE_PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'repeat_penalty', 'response_format'] as const;

/** Micro-USD charged to the user for a network-served request: flat price per 1M total tokens. */
export function networkCostMicros(totalTokens: number, networkPricePerMTokens: number): number {
  return Math.round(totalTokens * networkPricePerMTokens);
}

export function openaiError(reply: FastifyReply, status: number, message: string, type: string, code?: string) {
  return reply.code(status).send({ error: { message, type, code: code ?? null, param: null } });
}

export async function v1Routes(app: FastifyInstance, ctx: AppContext) {
  const rateLimit = {
    max: ctx.env.V1_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => bearer(req.headers.authorization) ?? req.ip,
  };

  /** Resolve API key -> row, or send an OpenAI-shaped 401. */
  async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<ApiKeyRow | null> {
    const key = bearer(req.headers.authorization);
    const row = key ? lookupApiKey(ctx.db, key, ctx.env.KEY_PEPPER) : null;
    if (!row) {
      openaiError(reply, 401, 'Invalid API key. Create one with POST /keys.', 'invalid_request_error', 'invalid_api_key');
      return null;
    }
    return row;
  }

  function record(
    key: ApiKeyRow,
    model: string,
    usage: Usage | null,
    upstream: string,
    latencyMs: number,
    stream: boolean,
    /** Network-served requests: bill the flat network price and remember the list price it replaced. */
    network?: { costMicros: number; listCostMicros: number },
  ): number {
    const cost = network?.costMicros ?? costMicros(usage, model, ctx.prices, ctx.config.requestPricing.markupBps);
    const listCost = network?.listCostMicros ?? cost;
    const saved = network ? savedMicros(listCost, cost) : 0;
    const tx = ctx.db.transaction(() => {
      const res = ctx.db
        .prepare(
          `INSERT INTO requests_log (api_key_id, wallet, model, prompt_tokens, completion_tokens, cost_usd_micros, upstream, latency_ms, stream, created_at, list_cost_usd_micros, saved_usd_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key.id,
          key.wallet,
          model,
          usage?.prompt_tokens ?? 0,
          usage?.completion_tokens ?? 0,
          cost,
          upstream,
          latencyMs,
          stream ? 1 : 0,
          nowSec(),
          listCost,
          saved,
        );
      if (cost > 0) {
        addLedgerEntry(ctx.db, {
          wallet: key.wallet,
          deltaMicros: -cost,
          kind: 'usage',
          ref: `req:${Number(res.lastInsertRowid)}`,
        });
        ctx.db.prepare(`UPDATE api_keys SET spent_usd_micros = spent_usd_micros + ? WHERE id = ?`).run(cost, key.id);
      }
    });
    tx();
    // Pre-launch points for the spend (and, when a node served it, the tokens it served).
    syncPoints(ctx.db, ctx.config.points);
    return cost;
  }

  /** Map a failed upstream Response to our own error; never charges. */
  async function upstreamFailure(req: FastifyRequest, reply: FastifyReply, res: Response) {
    const detail = await describeUpstreamError(res);
    const status = res.status >= 500 || res.status < 400 ? 502 : res.status;
    const code = res.status === 429 ? 'upstream_rate_limited' : res.status === 404 ? 'model_not_found' : 'upstream_error';
    req.log.warn({ upstreamStatus: res.status, detail }, 'upstream returned an error');
    recordError(ctx.db, { route: req.url, status, code, message: `upstream ${res.status}: ${detail}` });
    return openaiError(reply, status, `Upstream (${ctx.upstream.name}) error ${res.status}: ${detail}`, 'upstream_error', code);
  }

  function upstreamThrow(req: FastifyRequest, reply: FastifyReply, err: unknown) {
    const kind = err instanceof UpstreamError ? err.kind : 'network';
    const message =
      kind === 'timeout'
        ? `Upstream (${ctx.upstream.name}) timed out after ${ctx.env.UPSTREAM_TIMEOUT_MS}ms. You were not charged.`
        : `Upstream (${ctx.upstream.name}) is unreachable. You were not charged.`;
    req.log.error({ err }, 'upstream request failed');
    recordError(ctx.db, { route: req.url, status: 502, code: `upstream_${kind}`, message: (err as Error).message });
    return openaiError(reply, 502, message, 'upstream_error', `upstream_${kind}`);
  }

  type NetworkOutcome = { kind: 'served' } | { kind: 'errored' } | { kind: 'fallback'; reason: string; jobId: string };

  /**
   * Serve one chat completion through the node network: queue a job, wait for a node to claim it and
   * stream chunks back as OpenAI SSE (or buffer for non-stream). On a failure before anything reached
   * the client the job is retried once on another node, else the caller falls back to the upstream.
   * Once partial output was sent there is no fallback: the error is surfaced in-stream.
   */
  async function serveFromNetwork(
    req: FastifyRequest,
    reply: FastifyReply,
    key: ApiKeyRow,
    body: Record<string, unknown>,
    model: string,
    tag: string,
    stream: boolean,
    started: number,
  ): Promise<NetworkOutcome> {
    const routing = ctx.config.routing;
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
    req.raw.on('close', () => {
      if (!raw.writableEnded) {
        clientGone = true;
        liveRelay?.close();
      }
    });
    const writeHeaders = (nodeId: string) => {
      if (headersWritten) return;
      headersWritten = true;
      reply.hijack();
      raw.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'x-mesh-route': `node:${nodeId}`,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.flushHeaders?.();
    };
    const write = (s: string) => {
      if (!raw.writableEnded) raw.write(s);
    };

    let exclude: string | null = null;
    let parent: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { job, relay } = ctx.broker.create({
        model,
        tag,
        wallet: key.wallet,
        apiKeyId: key.id,
        payload: { messages: body.messages as unknown[], params },
        maxTokens,
        deadlineMs: Date.now() + routing.jobTimeoutMs,
        excludeNodeId: exclude,
        parentJobId: parent,
        attempt,
      });
      liveRelay = relay;
      req.log.info({ jobId: job.job_id, tag, attempt, exclude }, 'network job queued');
      const createdMs = Date.now();
      const text: string[] = [];
      let nodeId: string | null = null;
      let sent = 0;
      let usage: JobUsage | null = null;
      let failure: { error: string; nodeFault: boolean } | null = null;

      for (;;) {
        const now = Date.now();
        const budget = sent === 0 ? routing.firstTokenTimeoutMs - (now - createdMs) : routing.stallTimeoutMs;
        const ev = await relay.next(Math.max(0, Math.min(budget, job.deadline_ms - now)));
        if (clientGone) {
          failure = { error: 'client_disconnected', nodeFault: false };
          break;
        }
        if (ev.type === 'claimed') {
          nodeId = ev.nodeId;
        } else if (ev.type === 'chunk') {
          if (stream) {
            writeHeaders(nodeId ?? 'unknown');
            write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: sent === 0 ? { role: 'assistant', content: ev.delta } : { content: ev.delta }, finish_reason: null }] }));
          } else text.push(ev.delta);
          sent++;
        } else if (ev.type === 'done') {
          usage = ev.usage;
        } else if (ev.type === 'fail') {
          failure = { error: `node_error: ${ev.error}`, nodeFault: true };
        } else {
          const expired = Date.now() >= job.deadline_ms;
          const error = expired ? 'deadline_exceeded' : sent === 0 ? (nodeId ? 'first_token_timeout' : 'unclaimed') : 'stall_timeout';
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
        const listCost = listCostMicros(u, model, ctx.prices, ctx.policy, pricing.markupBps);
        const saved = savedMicros(listCost, price);
        // Stake tier of the node's reward wallet multiplies the reward (staking.ts; 1× when unstaked / not wired).
        const stake = node && ctx.stakes ? await ctx.stakes.resolve(node.wallet).catch(() => null) : null;
        const rewardMultiplier = stake?.multiplier ?? 1;
        const reward = applyMultiplier(nodeRewardMicros(tokens, ctx.config.nodeRewards.usdPerMTokens), rewardMultiplier);
        let cost = 0;
        ctx.db.transaction(() => {
          cost = record(key, model, u, `node:${nodeId}`, Date.now() - started, stream, { costMicros: price, listCostMicros: listCost });
          if (node) addNodeReward(ctx.db, { wallet: node.wallet, nodeId, jobId: job.job_id, tokens, usdMicros: reward });
        })();
        syncPoints(ctx.db, ctx.config.points); // node operator's points for the tokens served
        const usageOut = { ...u, cost: microsToUsd(cost) };
        const mesh = {
          route: 'node',
          nodeId,
          chip: node?.chip ?? null,
          jobId: job.job_id,
          attempt,
          ...(pricing.showSavings ? { listCostUsd: microsToUsd(listCost), savedUsd: microsToUsd(saved) } : {}),
        };
        req.log.info({ jobId: job.job_id, nodeId, tokens, costUsd: microsToUsd(cost), listCostUsd: microsToUsd(listCost), savedUsd: microsToUsd(saved), rewardUsd: microsToUsd(reward), rewardMultiplier, stakeTier: stake?.tier.name ?? null }, 'chat completion (node)');
        if (stream) {
          writeHeaders(nodeId);
          write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: usage.finishReason }], usage: usageOut, mesh }));
          write('data: [DONE]\n\n');
          if (!raw.writableEnded) raw.end();
          return { kind: 'served' };
        }
        reply.header('x-mesh-route', `node:${nodeId}`);
        reply.header('x-mesh-cost-usd', microsToUsd(cost).toString());
        if (pricing.showSavings) reply.header('x-mesh-saved-usd', microsToUsd(saved).toString());
        reply.header('x-mesh-balance-usd', microsToUsd(balanceMicros(ctx.db, key.wallet)).toString());
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
        write(enc({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: `Mesh node failed mid-stream (${f.error}). You were not charged.`, type: 'upstream_error', code: 'node_stream_failed' }, mesh: { route: 'node', nodeId, jobId: job.job_id } }));
        write('data: [DONE]\n\n');
        if (!raw.writableEnded) raw.end();
        return { kind: 'errored' };
      }
      // Nothing sent yet: retry once on a different node if one is available, else fall back.
      const others = nodeId ? eligibleNodes(ctx, tag, { exclude: nodeId }) : [];
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

  app.get('/v1/models', { config: { rateLimit } }, async (req, reply) => {
    const key = await requireApiKey(req, reply);
    if (!key) return reply;
    let res: Response;
    try {
      res = await ctx.upstream.models();
    } catch (err) {
      return upstreamThrow(req, reply, err);
    }
    if (!res.ok) return upstreamFailure(req, reply, res);
    const json = (await res.json()) as { data?: Array<Record<string, unknown> & { id: string }> };
    const data: Array<Record<string, unknown> & { id: string; mesh_network: boolean }> = (json.data ?? [])
      .filter((m) => typeof m.id === 'string' && isModelAllowed(ctx.policy, m.id))
      .map((m) => ({ ...m, mesh_network: isNetworkModel(ctx.policy, m.id) }));
    const seen = new Set(data.map((m) => m.id));
    for (const name of networkModelNames(ctx.policy)) {
      if (seen.has(name) || !isModelAllowed(ctx.policy, name)) continue;
      data.push({ id: name, object: 'model', created: 0, owned_by: 'mesh', name: `${name} (Mesh network)`, mesh_network: true });
    }
    return { object: 'list', data };
  });

  app.post('/v1/chat/completions', { config: { rateLimit } }, async (req, reply) => {
    const key = await requireApiKey(req, reply);
    if (!key) return reply;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openaiError(reply, 400, "'messages' must be a non-empty array", 'invalid_request_error');
    }
    if (typeof body.model !== 'string' || !body.model) {
      return openaiError(reply, 400, "'model' is required", 'invalid_request_error', 'model_required');
    }
    const requestedModel = body.model;
    if (!isModelAllowed(ctx.policy, requestedModel)) {
      return openaiError(
        reply,
        403,
        `Model '${requestedModel}' is not available on Mesh. GET /v1/models lists what is.`,
        'invalid_request_error',
        'model_not_allowed',
      );
    }

    if (keySpendExhausted(key)) {
      return openaiError(
        reply,
        429,
        `This API key reached its spend limit ($${microsToUsd(key.spend_limit_usd_micros ?? 0)}). Raise it with PATCH /keys/${key.id}.`,
        'insufficient_quota',
        'key_spend_limit_reached',
      );
    }

    const balance = balanceMicros(ctx.db, key.wallet);
    if (balance <= 0) {
      return openaiError(
        reply,
        402,
        `Insufficient Mesh credits (balance $${microsToUsd(balance).toFixed(6)}). Hold $MESH to receive hourly credits.`,
        'insufficient_quota',
        'insufficient_quota',
      );
    }

    const stream = body.stream === true;
    const started = Date.now();

    // ---- Mesh node network first (when enabled and an idle node advertises the model's tag) ----
    const route = decideRoute(ctx, requestedModel);
    if (route.target === 'node' && route.tag) {
      const outcome = await serveFromNetwork(req, reply, key, body, requestedModel, route.tag, stream, started);
      if (outcome.kind === 'served' || outcome.kind === 'errored') return reply;
      reply.header('x-mesh-fallback', outcome.reason);
      req.log.warn({ model: requestedModel, reason: outcome.reason, jobId: outcome.jobId }, 'network job failed before any output; falling back to upstream');
    }
    reply.header('x-mesh-route', ctx.upstream.name);

    let upstreamRes: Response;
    try {
      upstreamRes = await ctx.upstream.chat(body);
    } catch (err) {
      return upstreamThrow(req, reply, err);
    }

    // Upstream error: clear JSON error, charge nothing.
    if (!upstreamRes.ok) return upstreamFailure(req, reply, upstreamRes);

    if (!stream) {
      let json: { model?: string; usage?: Usage; error?: unknown };
      try {
        json = (await upstreamRes.json()) as typeof json;
      } catch (err) {
        return upstreamThrow(req, reply, new UpstreamError(`invalid JSON from upstream: ${(err as Error).message}`, 'network'));
      }
      if (json.error) {
        recordError(ctx.db, { route: req.url, status: 502, code: 'upstream_error', message: JSON.stringify(json.error).slice(0, 300) });
        return openaiError(reply, 502, `Upstream (${ctx.upstream.name}) returned an error. You were not charged.`, 'upstream_error', 'upstream_error');
      }
      const model = json.model ?? requestedModel;
      const cost = record(key, model, json.usage ?? null, ctx.upstream.name, Date.now() - started, false);
      reply.header('x-mesh-cost-usd', microsToUsd(cost).toString());
      reply.header('x-mesh-balance-usd', microsToUsd(balanceMicros(ctx.db, key.wallet)).toString());
      return reply.send(json);
    }

    // ---- streaming: pass SSE through, scan for usage, account at the end ----
    if (!upstreamRes.body) return openaiError(reply, 502, 'Upstream returned no body', 'upstream_error', 'upstream_error');
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
    req.raw.on('close', () => {
      if (!raw.writableEnded) {
        aborted = true;
        reader.cancel().catch(() => undefined);
      }
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        scanner.push(decoder.decode(value, { stream: true }));
        if (!raw.write(value)) await new Promise<void>((r) => raw.once('drain', () => r()));
      }
      scanner.push(decoder.decode());
    } catch (err) {
      if (!aborted) req.log.error({ err }, 'stream relay failed');
    } finally {
      scanner.end();
      if (!raw.writableEnded) raw.end();
      const model = scanner.model ?? requestedModel;
      if (scanner.error && !scanner.usage) {
        // Upstream failed mid-stream before reporting usage: no charge, but remember it.
        recordError(ctx.db, { route: req.url, status: 502, code: 'upstream_stream_error', message: scanner.error.message });
        req.log.warn({ wallet: key.wallet, model, error: scanner.error }, 'upstream error inside stream; not charged');
      } else {
        // Charge whatever the upstream reported (or fallback from tokens) even if client disconnected.
        const cost = record(key, model, scanner.usage, ctx.upstream.name, Date.now() - started, true);
        req.log.info({ wallet: key.wallet, model, costUsd: microsToUsd(cost), aborted }, 'chat completion (stream)');
      }
    }
  });
}
