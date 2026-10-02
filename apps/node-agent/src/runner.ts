import { GatewayError, type GatewayClient, type Job, type JobMessage } from './gateway.js';
import type { OllamaChatOptions, OllamaClient, OllamaMessage } from './ollama.js';

export interface RunResult {
  jobId: string;
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  chunks: number;
  chars: number;
  durationMs: number;
  error?: string;
}

export interface RunnerOptions {
  /** Flush buffered deltas to the gateway at most this often. */
  batchMs?: number;
  /** Flush immediately when the buffer passes this many chars. */
  batchChars?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/** OpenAI-style content arrays are flattened to their text parts; Ollama wants plain strings. */
export function toOllamaMessages(messages: JobMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    return { role: m.role, content };
  });
}

/** Maps OpenAI-ish params (+ maxTokens) to Ollama options. Unknown params are dropped. */
export function toOllamaOptions(params: Record<string, unknown> | undefined, maxTokens: number | null | undefined): OllamaChatOptions {
  const p = params ?? {};
  const out: OllamaChatOptions = {};
  const num = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : undefined);
  const t = num('temperature');
  if (t !== undefined) out.temperature = t;
  const topP = num('top_p') ?? num('topP');
  if (topP !== undefined) out.top_p = topP;
  const topK = num('top_k') ?? num('topK');
  if (topK !== undefined) out.top_k = topK;
  const seed = num('seed');
  if (seed !== undefined) out.seed = seed;
  const rp = num('frequency_penalty') ?? num('repeat_penalty');
  if (rp !== undefined) out.repeat_penalty = 1 + Math.max(0, rp);
  const stop = p.stop;
  if (typeof stop === 'string') out.stop = [stop];
  else if (Array.isArray(stop)) out.stop = stop.filter((s): s is string => typeof s === 'string');
  const mt = typeof maxTokens === 'number' && maxTokens > 0 ? Math.floor(maxTokens) : num('max_tokens');
  if (mt !== undefined && mt > 0) out.num_predict = mt;
  return out;
}

/** Remaining budget in ms for a job, or null when it has no deadline. */
export function deadlineBudget(deadlineMs: number | null | undefined, receivedAt: number): number | null {
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  // Absolute unix-ms timestamps are > 1e12; anything smaller is a relative budget.
  return deadlineMs > 1e12 ? deadlineMs - receivedAt : deadlineMs;
}

const finishReasonOf = (doneReason: string) => (doneReason === 'length' ? 'length' : doneReason === 'stop' || !doneReason ? 'stop' : doneReason);

/**
 * Runs one job end to end: streams from Ollama, forwards deltas as ordered chunks (batched every
 * ~batchMs), then reports done with Ollama's token counts, or fail on any error / deadline.
 */
export async function runJob(job: Job, gateway: GatewayClient, nodeId: string, ollama: OllamaClient, opts: RunnerOptions = {}): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const batchMs = opts.batchMs ?? 40;
  const batchChars = opts.batchChars ?? 2048;
  const started = now();

  const ac = new AbortController();
  const budget = deadlineBudget(job.deadlineMs, started);
  let deadlineHit = false;
  const deadlineTimer =
    budget !== null
      ? setTimeout(
          () => {
            deadlineHit = true;
            ac.abort(new Error(`deadline of ${budget}ms exceeded`));
          },
          Math.max(0, budget),
        )
      : null;

  // Ordered chunk pipeline: one in-flight POST at a time so seq order == arrival order.
  let seq = 0;
  let buf = '';
  let chars = 0;
  let chunks = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  const st: { sendError: Error | null } = { sendError: null };

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buf) return;
    const delta = buf;
    const mySeq = seq++;
    buf = '';
    chunks++;
    chain = chain.then(async () => {
      if (st.sendError) return;
      try {
        await gateway.chunk(nodeId, job.jobId, mySeq, delta);
      } catch (err) {
        st.sendError = err as Error;
        ac.abort(st.sendError);
      }
    });
  };

  const onDelta = (text: string) => {
    buf += text;
    chars += text.length;
    if (buf.length >= batchChars) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, batchMs);
  };

  const finish = async (result: RunResult): Promise<RunResult> => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (flushTimer) clearTimeout(flushTimer);
    return result;
  };

  try {
    const final = await ollama.chatStream(
      { model: job.model, messages: toOllamaMessages(job.messages), options: toOllamaOptions(job.params, job.maxTokens), signal: ac.signal },
      onDelta,
    );
    flush();
    await chain;
    if (st.sendError) throw st.sendError;
    const body = { promptTokens: final.promptTokens, completionTokens: final.completionTokens, finishReason: finishReasonOf(final.doneReason) };
    await gateway.done(nodeId, job.jobId, body);
    const durationMs = now() - started;
    log(`job ${job.jobId} done model=${job.model} tokens=${body.promptTokens}+${body.completionTokens} chunks=${chunks} ${durationMs}ms`);
    return finish({ jobId: job.jobId, ok: true, ...body, chunks, chars, durationMs });
  } catch (err) {
    const e = err as Error;
    const sendErr = st.sendError;
    const jobGone = sendErr instanceof GatewayError && sendErr.status === 409;
    const reason = deadlineHit
      ? `deadline of ${budget}ms exceeded`
      : jobGone
        ? 'job no longer running on the gateway (timed out, client left, or re-queued)'
        : sendErr
          ? `gateway chunk failed: ${sendErr.message}`
          : e.message || String(err);
    const durationMs = now() - started;
    log(`job ${job.jobId} ${jobGone ? 'abandoned' : 'failed'} after ${durationMs}ms: ${reason}`);
    if (!sendErr) {
      // Report the failure unless the gateway itself is what broke (a 409 means it already knows).
      await gateway.fail(nodeId, job.jobId, reason).catch((ferr: Error) => log(`could not report failure for ${job.jobId}: ${ferr.message}`));
    }
    return finish({ jobId: job.jobId, ok: false, promptTokens: 0, completionTokens: 0, finishReason: 'error', chunks, chars, durationMs, error: reason });
  }
}
