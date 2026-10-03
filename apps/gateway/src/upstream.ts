import type { ModelPrices } from '@mesh/config';
import { priceForModel } from '@mesh/config';
import { usdToMicros } from './money.js';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  /** USD cost as reported by the upstream (OpenRouter returns this when usage.include=true). */
  cost?: number;
}

export interface ChatOptions {
  /**
   * Zero data retention: only route to providers that do not store prompts or completions
   * (OpenRouter `provider.data_collection = "deny"`, docs/PRIVACY.md). Fewer providers qualify, so a
   * model can become unavailable under ZDR; that surfaces as an upstream 404/error, never as a silent
   * downgrade.
   */
  zdr?: boolean;
}

export interface Upstream {
  readonly name: 'openrouter' | 'mock';
  chat(body: Record<string, unknown>, opts?: ChatOptions): Promise<Response>;
  models(): Promise<Response>;
}

/** Mesh-only request fields that must never reach a provider. */
const MESH_ONLY_FIELDS = ['mesh'] as const;

/**
 * Body as sent to OpenRouter: Mesh extensions removed, `usage.include` on, and with `zdr` the
 * ZDR-only provider preference merged into any `provider` object the client sent.
 */
export function upstreamBody(body: Record<string, unknown>, opts: ChatOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, usage: { include: true } };
  for (const k of MESH_ONLY_FIELDS) delete out[k];
  if (opts.zdr) {
    const provider = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider) ? (body.provider as Record<string, unknown>) : {};
    out.provider = { ...provider, data_collection: 'deny' };
  }
  return out;
}

/** Thrown by OpenRouterUpstream when the network call fails or times out. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'network',
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface OpenRouterOptions {
  baseUrl?: string;
  /** Applies to connect + headers (stream) or connect + full body (non-stream). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
}

// ---------------- OpenRouter ----------------
//
// Real API shape (verified against https://openrouter.ai/docs/api-reference):
//  - POST {base}/chat/completions with `usage: {include: true}`; non-stream responses carry
//    `usage: {prompt_tokens, completion_tokens, total_tokens, cost, ...}` where `cost` is USD.
//  - Streaming is SSE. OpenRouter interleaves comment lines (": OPENROUTER PROCESSING") which
//    SseUsageScanner ignores; the final data chunk has `choices: []` (or a finish_reason) plus
//    `usage` including `cost`, then `data: [DONE]`.
//  - Errors are `{error: {code, message, metadata?}}` with a matching HTTP status; a mid-stream
//    failure arrives as a data line `{"error": {...}}` on a 200 response.

export class OpenRouterUpstream implements Upstream {
  readonly name = 'openrouter' as const;
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private referer: string;
  private title: string;

  constructor(
    private apiKey: string,
    opts: OpenRouterOptions | string = {},
  ) {
    const o = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.baseUrl = (o.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.referer = o.referer ?? 'https://mesh.local';
    this.title = o.title ?? 'Mesh Gateway';
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'HTTP-Referer': this.referer,
          'X-Title': this.title,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (ctrl.signal.aborted) throw new UpstreamError(`upstream timed out after ${this.timeoutMs}ms`, 'timeout');
      throw new UpstreamError(`upstream unreachable: ${(err as Error).message}`, 'network');
    } finally {
      // For streams the body is still being read after headers arrive; the timeout only
      // covers connect + headers. Clearing here keeps long generations alive.
      clearTimeout(timer);
    }
  }

  async chat(body: Record<string, unknown>, opts: ChatOptions = {}): Promise<Response> {
    // Always ask OpenRouter to include usage + cost in the (final) response/chunk.
    return this.call('/chat/completions', { method: 'POST', body: JSON.stringify(upstreamBody(body, opts)) });
  }

  async models(): Promise<Response> {
    return this.call('/models', { method: 'GET' });
  }
}

/** Normalise an upstream error body into a short, safe message for our own 502/4xx. */
export async function describeUpstreamError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    if (m) return String(m).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text ? text.slice(0, 300) : `HTTP ${res.status}`;
}

// ---------------- Mock (offline) ----------------

export const MOCK_MODEL = 'mesh/mock';
export const MOCK_COST_USD = 0.001;

const CANNED =
  'Hello from the Mesh mock upstream. Your trading fees just paid for this reply. ' +
  'Set OPENROUTER_API_KEY to talk to real models.';

export class MockUpstream implements Upstream {
  readonly name = 'mock' as const;
  constructor(private chunkDelayMs = 15) {}

  async chat(body: Record<string, unknown>, _opts: ChatOptions = {}): Promise<Response> {
    const model = typeof body.model === 'string' && body.model ? body.model : MOCK_MODEL;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const promptChars = JSON.stringify(messages).length;
    const words = CANNED.split(' ');
    const usage: Usage = {
      prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
      completion_tokens: words.length,
      total_tokens: 0,
      cost: MOCK_COST_USD,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const id = `chatcmpl-mock-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream === true) {
      const enc = new TextEncoder();
      const delay = this.chunkDelayMs;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          for (let i = 0; i < words.length; i++) {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    return Response.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: CANNED }, finish_reason: 'stop' }],
      usage,
    });
  }

  async models(): Promise<Response> {
    return Response.json({
      object: 'list',
      data: [{ id: MOCK_MODEL, object: 'model', created: 0, owned_by: 'mesh', name: 'Mesh mock (offline)' }],
    });
  }
}

export function createUpstream(env: {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL: string;
  UPSTREAM_TIMEOUT_MS?: number;
  AUTH_URI?: string;
}): Upstream {
  return env.OPENROUTER_API_KEY
    ? new OpenRouterUpstream(env.OPENROUTER_API_KEY, {
        baseUrl: env.OPENROUTER_BASE_URL,
        timeoutMs: env.UPSTREAM_TIMEOUT_MS,
        referer: env.AUTH_URI,
      })
    : new MockUpstream();
}

// ---------------- cost ----------------

/** Cost in micro-USD: upstream-reported cost if present, else the fallback price table. */
export function costMicros(usage: Usage | null | undefined, model: string, prices: ModelPrices, markupBps = 0): number {
  let micros: number;
  if (usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
    micros = usdToMicros(usage.cost);
  } else {
    const p = priceForModel(prices, model);
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    micros = usdToMicros((prompt * p.promptUsdPerM + completion * p.completionUsdPerM) / 1_000_000);
  }
  if (markupBps) micros += Math.floor((micros * markupBps) / 10_000);
  return micros;
}

/** Scan SSE text for the last `usage` object and the model name. */
export class SseUsageScanner {
  private buffer = '';
  usage: Usage | null = null;
  model: string | null = null;
  /** Set when the upstream reported an error inside the stream (OpenRouter does this on a 200). */
  error: { message: string; code?: string | number } | null = null;

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trimEnd();
      this.buffer = this.buffer.slice(idx + 1);
      this.line(line);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.line(this.buffer.trim());
    this.buffer = '';
  }

  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const obj = JSON.parse(data) as {
        usage?: Usage | null;
        model?: string;
        error?: { message?: string; code?: string | number } | string;
      };
      if (obj.model) this.model = obj.model;
      if (obj.usage && typeof obj.usage === 'object') this.usage = obj.usage;
      if (obj.error) {
        this.error =
          typeof obj.error === 'string'
            ? { message: obj.error }
            : { message: obj.error.message ?? 'upstream error', code: obj.error.code };
      }
    } catch {
      /* partial / non-JSON line */
    }
  }
}
