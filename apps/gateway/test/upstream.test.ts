import { parseModelPolicy, type ModelPolicy, type TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenRouterUpstream, SseUsageScanner, UpstreamError, costMicros } from '../src/upstream.js';
import { ADMIN, testConfig, testServer } from './helpers.js';

/** Builds a fetch that answers like the real OpenRouter API. */
function fakeOpenRouter(opts: { status?: number; streamError?: boolean; hang?: boolean; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, init: init ?? {}, body });
    if (opts.hang) {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (opts.status && opts.status >= 400) {
      return Response.json(
        opts.body ?? { error: { code: opts.status, message: opts.status === 429 ? 'Rate limit exceeded' : 'Provider returned error', metadata: { provider_name: 'OpenAI' } } },
        { status: opts.status },
      );
    }
    if (url.endsWith('/models')) {
      return Response.json({
        data: [
          { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
          { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
          { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B' },
          { id: 'x-ai/grok-4', name: 'Grok 4' },
        ],
      });
    }
    const model = (body?.model as string) ?? 'openai/gpt-4o-mini';
    const usage = { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32, cost: 0.0000138, prompt_tokens_details: { cached_tokens: 0 } };
    if (body?.stream === true) {
      const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id: 'gen-abc', provider: 'OpenAI', model, object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason: null, logprobs: null }], ...extra })}\n\n`;
      const parts = [
        ': OPENROUTER PROCESSING\n\n',
        chunk({ role: 'assistant', content: '' }),
        ': OPENROUTER PROCESSING\n\n',
        chunk({ content: 'Hello' }),
        chunk({ content: ' world' }),
      ];
      if (opts.streamError) {
        parts.push(`data: ${JSON.stringify({ error: { code: 502, message: 'Provider disconnected' } })}\n\n`);
      } else {
        parts.push(
          `data: ${JSON.stringify({ id: 'gen-abc', provider: 'OpenAI', model, object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          // final usage chunk: OpenRouter sends empty choices with usage
          `data: ${JSON.stringify({ id: 'gen-abc', provider: 'OpenAI', model, object: 'chat.completion.chunk', created: 1, choices: [], usage })}\n\n`,
          'data: [DONE]\n\n',
        );
      }
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const p of parts) c.enqueue(enc.encode(p));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({
      id: 'gen-abc',
      provider: 'OpenAI',
      model,
      object: 'chat.completion',
      created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
      usage,
    });
  };
  return { fetchImpl, calls };
}

function orUpstream(fake: ReturnType<typeof fakeOpenRouter>, timeoutMs = 5000) {
  return new OpenRouterUpstream('sk-or-test', { baseUrl: 'https://openrouter.ai/api/v1/', timeoutMs, fetchImpl: fake.fetchImpl });
}

describe('OpenRouterUpstream against the real API shape', () => {
  it('sends usage.include and auth headers; non-stream usage.cost is charged', async () => {
    const fake = fakeOpenRouter();
    const up = orUpstream(fake);
    const res = await up.chat({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.ok).toBe(true);
    expect(fake.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fake.calls[0].body?.usage).toEqual({ include: true });
    expect((fake.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    const json = (await res.json()) as { usage: { cost: number } };
    expect(costMicros(json.usage, 'openai/gpt-4o-mini', { default: { promptUsdPerM: 1, completionUsdPerM: 1 }, models: {} })).toBe(14);
  });

  it('streaming: scanner ignores OPENROUTER PROCESSING comments and finds usage in the final chunk', async () => {
    const fake = fakeOpenRouter();
    const res = await orUpstream(fake).chat({ model: 'openai/gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const scanner = new SseUsageScanner();
    scanner.push(await res.text());
    scanner.end();
    expect(scanner.model).toBe('openai/gpt-4o-mini');
    expect(scanner.usage?.cost).toBeCloseTo(0.0000138, 9);
    expect(scanner.error).toBeNull();
  });

  it('streaming: mid-stream error object is detected', async () => {
    const fake = fakeOpenRouter({ streamError: true });
    const res = await orUpstream(fake).chat({ model: 'm', stream: true, messages: [] });
    const scanner = new SseUsageScanner();
    scanner.push(await res.text());
    scanner.end();
    expect(scanner.usage).toBeNull();
    expect(scanner.error?.message).toBe('Provider disconnected');
  });

  it('times out with UpstreamError(timeout)', async () => {
    const fake = fakeOpenRouter({ hang: true });
    const up = orUpstream(fake, 30);
    await expect(up.chat({ model: 'm', messages: [] })).rejects.toMatchObject({ kind: 'timeout' });
    await expect(up.chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(UpstreamError);
  });

  it('network failure becomes UpstreamError(network)', async () => {
    const up = new OpenRouterUpstream('k', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(up.models()).rejects.toMatchObject({ kind: 'network', message: /unreachable/ });
  });
});

describe('/v1 with an OpenRouter-shaped upstream', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  const policy: ModelPolicy = parseModelPolicy({
    allow: ['openai/*', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.1-8b-instruct', 'mesh/mock'],
    deny: ['openai/gpt-4o'],
    networkModels: ['meta-llama/llama-3.1-8b-instruct'],
  });

  async function boot(fake: ReturnType<typeof fakeOpenRouter>, timeoutMs = 5000, cfg?: Partial<TokenomicsConfig['routing']>) {
    const { app } = await testServer({
      holders: { alice: 10_000 },
      context: { upstream: orUpstream(fake, timeoutMs), policy },
      env: { UPSTREAM_TIMEOUT_MS: timeoutMs },
      ...(cfg ? { config: { ...testConfig, routing: { ...testConfig.routing, ...cfg } } } : {}),
    });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/admin/starter-credit', headers: ADMIN, payload: { wallet: 'alice', amountUsd: 1 } });
    const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: 'alice' } })).json().token;
    const key = (await app.inject({ method: 'POST', url: '/keys', headers: { authorization: `Bearer ${jwt}` } })).json().key as string;
    const balance = async () => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } })).json().balance.usdMicros as number;
    return { app, key, balance };
  }

  const chat = (app: { inject: Function }, key: string, payload: unknown) =>
    (app as any).inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload });

  it('charges usage.cost for non-stream and stream', async () => {
    const { app, key, balance } = await boot(fakeOpenRouter());
    const before = await balance();
    const r = await chat(app, key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-mesh-cost-usd']).toBe('0.000014');
    expect(r.headers['x-mesh-route']).toBe('openrouter');
    expect(await balance()).toBe(before - 14);
    const s = await chat(app, key, { model: 'openai/gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(s.statusCode).toBe(200);
    expect(s.body).toContain('data: [DONE]');
    expect(await balance()).toBe(before - 28);
  });

  it('GET /v1/models is the curated catalogue filtered by policy, network models first and flagged', async () => {
    const { app, key } = await boot(fakeOpenRouter());
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } });
    expect(r.statusCode).toBe(200);
    const ids: string[] = r.json().data.map((m: { id: string }) => m.id);
    // allow: openai/*, claude-sonnet-4 (not in the catalogue), llama 8b, mesh/mock → grok / sonnet-4.5 / gemini are out
    expect(ids).toContain('openai/gpt-5');
    expect(ids).not.toContain('x-ai/grok-4');
    expect(ids).not.toContain('anthropic/claude-sonnet-4.5');
    expect(ids[0]).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(r.json().data.find((m: { id: string }) => m.id === 'meta-llama/llama-3.1-8b-instruct').mesh_network).toBe(true);
    expect(r.json().data.find((m: { id: string }) => m.id === 'openai/gpt-5').mesh_network).toBe(false);
  });

  it('denied / unlisted models get 403 model_not_allowed and are not charged', async () => {
    const { app, key, balance } = await boot(fakeOpenRouter());
    const before = await balance();
    for (const model of ['openai/gpt-4o', 'x-ai/grok-4']) {
      const r = await chat(app, key, { model, messages: [{ role: 'user', content: 'hi' }] });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('model_not_allowed');
    }
    const noModel = await chat(app, key, { messages: [{ role: 'user', content: 'hi' }] });
    expect(noModel.statusCode).toBe(400);
    expect(await balance()).toBe(before);
  });

  it('upstream 5xx -> 502 clear JSON, upstream 429 -> 429, never charged', async () => {
    const fail = await boot(fakeOpenRouter({ status: 502 }));
    const before = await fail.balance();
    const r = await chat(fail.app, fail.key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ type: 'upstream_error', code: 'upstream_error' });
    expect(r.json().error.message).toContain('Provider returned error');
    expect(await fail.balance()).toBe(before);

    const limited = await boot(fakeOpenRouter({ status: 429 }));
    const r2 = await chat(limited.app, limited.key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.statusCode).toBe(429);
    expect(r2.json().error.code).toBe('upstream_rate_limited');

    const over = await limited.app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    expect(over.json().recentErrors[0].code).toBe('upstream_rate_limited');
  });

  it('timeout -> 502 upstream_timeout and no charge', async () => {
    const { app, key, balance } = await boot(fakeOpenRouter({ hang: true }), 25);
    const before = await balance();
    const r = await chat(app, key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('upstream_timeout');
    expect(r.json().error.message).toContain('not charged');
    expect(await balance()).toBe(before);
  });

  it('error inside a 200 stream is relayed but not charged', async () => {
    const { app, key, balance } = await boot(fakeOpenRouter({ streamError: true }));
    const before = await balance();
    const r = await chat(app, key, { model: 'openai/gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Provider disconnected');
    expect(await balance()).toBe(before);
    const over = await app.inject({ method: 'GET', url: '/admin/overview', headers: ADMIN });
    expect(over.json().recentErrors[0].code).toBe('upstream_stream_error');
  });

  it('network routing: an online idle node that never pulls -> job unclaimed -> transparent fallback to OpenRouter', async () => {
    const { app, key } = await boot(fakeOpenRouter(), 5000, { preferNetwork: true, firstTokenTimeoutMs: 150, stallTimeoutMs: 150 });
    const reg = await app.inject({
      method: 'POST',
      url: '/nodes/register',
      payload: { nodeId: 'mac-studio', wallet: 'alice', models: ['meta-llama/llama-3.1-8b-instruct'], chip: 'M2 Ultra', ramGb: 192 },
    });
    const token = reg.json().nodeToken as string;
    const r = await chat(app, key, { model: 'meta-llama/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-mesh-route']).toBe('openrouter');
    expect(r.headers['x-mesh-fallback']).toBe('unclaimed');
    expect(r.json().provider).toBe('OpenAI'); // served by OpenRouter
    const job = app.ctx.db.prepare(`SELECT status, node_fault FROM jobs`).get() as { status: string; node_fault: number };
    expect(job).toEqual({ status: 'fallback', node_fault: 0 });

    // busy node is skipped entirely (no job created)
    await app.inject({ method: 'POST', url: '/nodes/mac-studio/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: { busy: true } });
    const r2 = await chat(app, key, { model: 'meta-llama/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.headers['x-mesh-route']).toBe('openrouter');
    expect(r2.headers['x-mesh-fallback']).toBeUndefined();
    expect((app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(1);

    // non-network model never routes
    const r3 = await chat(app, key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r3.headers['x-mesh-route']).toBe('openrouter');
  });
});
