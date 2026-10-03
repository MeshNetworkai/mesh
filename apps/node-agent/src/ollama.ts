/** Minimal Ollama HTTP client: /api/tags, /api/pull (streamed progress) and /api/chat (streamed). */

/**
 * How long Ollama keeps the model loaded after a reply. Set per request so the operator's own
 * OLLAMA_KEEP_ALIVE does not matter: weights stay warm for the next job, but a KV cache for a finished
 * prompt is dropped by Ollama once the request ends; nothing is persisted (docs/PRIVACY.md).
 */
export const DEFAULT_KEEP_ALIVE = '5m';

/**
 * Environment the agent sets when it launches `ollama serve` itself (setup) and for the launchd
 * service. Ollama's server never writes prompt or reply text to disk with these: OLLAMA_NOHISTORY
 * disables the interactive readline history file (~/.ollama/history) and OLLAMA_DEBUG=0 keeps the
 * server log at request metadata (method, path, status, timing) rather than request bodies.
 */
export const OLLAMA_PRIVACY_ENV: Record<string, string> = { OLLAMA_NOHISTORY: '1', OLLAMA_DEBUG: '0' };

export interface OllamaMessage {
  role: string;
  content: string;
}

export interface OllamaChatOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  stop?: string[];
  seed?: number;
  repeat_penalty?: number;
}

export interface OllamaFinal {
  promptTokens: number;
  completionTokens: number;
  /** Ollama's done_reason: 'stop' | 'length' | ... */
  doneReason: string;
}

interface ChatLine {
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaClient {
  constructor(readonly baseUrl: string) {}

  async isUp(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`ollama /api/tags -> ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name);
  }

  /** Pulls a model, calling onProgress with a one-line status as layers download. */
  async pull(model: string, onProgress?: (line: string) => void): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`ollama pull ${model} -> ${res.status} ${await res.text().catch(() => '')}`);
    for await (const obj of ndjson<{ status?: string; total?: number; completed?: number; error?: string }>(res.body)) {
      if (obj.error) throw new Error(`ollama pull ${model}: ${obj.error}`);
      if (!onProgress) continue;
      if (obj.total && obj.completed !== undefined) {
        const pct = Math.floor((obj.completed / obj.total) * 100);
        onProgress(`${obj.status ?? 'downloading'} ${pct}% (${gb(obj.completed)} / ${gb(obj.total)} GB)`);
      } else if (obj.status) {
        onProgress(obj.status);
      }
    }
  }

  /**
   * Streams /api/chat. `onDelta` gets each content fragment; resolves with token counts from the
   * final message. Rejects on HTTP/stream errors or when `signal` aborts.
   */
  async chatStream(
    req: { model: string; messages: OllamaMessage[]; options?: OllamaChatOptions; signal?: AbortSignal; keepAlive?: string },
    onDelta: (text: string) => void,
  ): Promise<OllamaFinal> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.model, messages: req.messages, stream: true, options: req.options ?? {}, keep_alive: req.keepAlive ?? DEFAULT_KEEP_ALIVE }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* plain text */
      }
      throw new Error(`ollama /api/chat -> ${res.status}: ${msg || res.statusText}`);
    }
    if (!res.body) throw new Error('ollama /api/chat returned no body');
    let final: OllamaFinal | null = null;
    for await (const line of ndjson<ChatLine>(res.body, req.signal)) {
      if (line.error) throw new Error(`ollama: ${line.error}`);
      const content = line.message?.content;
      if (content) onDelta(content);
      if (line.done) {
        final = {
          promptTokens: line.prompt_eval_count ?? 0,
          completionTokens: line.eval_count ?? 0,
          doneReason: line.done_reason ?? 'stop',
        };
      }
    }
    if (!final) throw new Error('ollama stream ended without a final message');
    return final;
  }
}

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/** Parses a newline-delimited JSON body. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    buf += decoder.decode();
    const rest = buf.trim();
    if (rest) yield JSON.parse(rest) as T;
  } finally {
    reader.releaseLock();
  }
}
