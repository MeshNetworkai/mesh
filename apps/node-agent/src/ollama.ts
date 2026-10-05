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

/**
 * Full environment for an `ollama serve` the agent spawns: privacy flags plus the request slots that
 * match the node's `maxParallel` (Ollama queues the rest otherwise, which looks like a stall to the gateway).
 */
export function ollamaServeEnv(maxParallel = 1): Record<string, string> {
  return { ...OLLAMA_PRIVACY_ENV, OLLAMA_NUM_PARALLEL: String(Math.max(1, Math.floor(maxParallel))) };
}

/** No token for this long mid-stream means Ollama is wedged (GPU hang, OOM-kill of the runner): fail the job. */
export const DEFAULT_STALL_MS = 120_000;

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
  /** Ollama's prompt_eval_count; null when the final message did not carry one (fully cached prompt on some versions). */
  promptTokens: number | null;
  /** Ollama's eval_count; null when absent. */
  completionTokens: number | null;
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

  async listModels(timeoutMs = 5000): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
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
   * final message. Rejects on HTTP/stream errors, when `signal` aborts, or when no line arrives for
   * `stallMs` (Ollama wedged). Error messages never include request or reply text.
   */
  async chatStream(
    req: { model: string; messages: OllamaMessage[]; options?: OllamaChatOptions; signal?: AbortSignal; keepAlive?: string; stallMs?: number },
    onDelta: (text: string) => void,
  ): Promise<OllamaFinal> {
    const stallMs = req.stallMs ?? DEFAULT_STALL_MS;
    // Stall watchdog: re-armed on every line. Prompt evaluation of a long prompt on a big model emits
    // nothing for a while, so the first-token wait gets the same budget as any later gap.
    const stall = new AbortController();
    let stallTimer: NodeJS.Timeout | null = null;
    const arm = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(new Error(`ollama produced nothing for ${Math.round(stallMs / 1000)}s`)), stallMs);
    };
    const signal = req.signal ? AbortSignal.any([req.signal, stall.signal]) : stall.signal;
    arm();
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: req.model, messages: req.messages, stream: true, options: req.options ?? {}, keep_alive: req.keepAlive ?? DEFAULT_KEEP_ALIVE }),
          signal,
        });
      } catch (err) {
        throw abortReason(signal, err) ?? new Error(`could not reach Ollama at ${this.baseUrl}: ${(err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          /* plain text */
        }
        throw new Error(`ollama /api/chat -> ${res.status}: ${(msg || res.statusText).slice(0, 200)}`);
      }
      if (!res.body) throw new Error('ollama /api/chat returned no body');
      let final: OllamaFinal | null = null;
      for await (const line of ndjson<ChatLine>(res.body, signal)) {
        arm();
        if (line.error) throw new Error(`ollama: ${String(line.error).slice(0, 200)}`);
        const content = line.message?.content;
        if (content) onDelta(content);
        if (line.done) {
          final = {
            promptTokens: typeof line.prompt_eval_count === 'number' ? line.prompt_eval_count : null,
            completionTokens: typeof line.eval_count === 'number' ? line.eval_count : null,
            doneReason: line.done_reason ?? 'stop',
          };
        }
      }
      if (!final) throw new Error('ollama stream ended without a final message');
      return final;
    } catch (err) {
      throw abortReason(signal, err) ?? err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }
}

/** When `signal` aborted, the reason it carries (the deadline / stall error) is the error worth reporting. */
function abortReason(signal: AbortSignal, err: unknown): Error | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : (err as Error)?.message || 'aborted');
}

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/**
 * Parses a newline-delimited JSON body. A malformed line raises an error that names the position,
 * never the text (Node's own SyntaxError quotes the input, which here could be reply text).
 */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lineNo = 0;
  const parse = (line: string): T => {
    lineNo++;
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`ollama stream: malformed JSON on line ${lineNo} (${line.length} chars)`);
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        throw new Error(`ollama stream ended unexpectedly: ${(err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).name ?? 'read error'}`);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) yield parse(line);
      }
    }
    buf += decoder.decode();
    const rest = buf.trim();
    if (rest) yield parse(rest);
  } finally {
    buf = '';
    reader.releaseLock();
  }
}
