import { GatewayError, type GatewayClient, type Job, type JobMessage } from './gateway.js';
import type { OllamaChatOptions, OllamaClient, OllamaFinal, OllamaMessage } from './ollama.js';

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
  /** Why the job ended without `ok`; `gateway_rejected` covers 409s on chunk/done (the gateway already failed it). */
  outcome?: 'done' | 'failed' | 'gateway_rejected';
}

export interface RunnerOptions {
  /** Flush buffered deltas to the gateway at most this often. */
  batchMs?: number;
  /** Flush immediately when the buffer passes this many chars. */
  batchChars?: number;
  /** Passed to Ollama: fail the job when no token arrives for this long. */
  stallMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/** The gateway's FailBody caps `error` at 500 chars and strips control characters; stay under both. */
export const MAX_FAIL_REASON_CHARS = 400;

/** OpenAI-style content arrays are flattened to their text parts; Ollama wants plain strings. */
export function toOllamaMessages(messages: JobMessage[] | undefined | null): OllamaMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is JobMessage => Boolean(m) && typeof m === 'object')
    .map((m) => {
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) content = m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      return { role: typeof m.role === 'string' && m.role ? m.role : 'user', content };
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

/**
 * Drop every reference to prompt and reply text once a job is over so the GC can reclaim it. JS
 * strings cannot be overwritten in place, so this is "zero the handles": the job's message objects
 * are emptied and the arrays truncated; the runner's own delta buffer is cleared the same way. Nothing
 * from a job is ever written to disk (docs/PRIVACY.md).
 */
export function scrubJob(job: Job, ...extra: Array<{ length: number; [i: number]: { content: unknown } }>): void {
  for (const list of [job.messages, ...extra]) {
    if (!list || typeof list !== 'object' || typeof list.length !== 'number') continue;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m && typeof m === 'object') (m as { content: unknown }).content = '';
    }
    list.length = 0;
  }
}

/** Remaining budget in ms for a job, or null when it has no deadline. */
export function deadlineBudget(deadlineMs: number | null | undefined, receivedAt: number): number | null {
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  // Absolute unix-ms timestamps are > 1e12; anything smaller is a relative budget.
  return deadlineMs > 1e12 ? deadlineMs - receivedAt : deadlineMs;
}

/**
 * One line the gateway will accept as `error` and that is safe to log: control characters collapsed,
 * length capped. Callers only ever pass messages built from ids / counts / Ollama status text.
 */
export function sanitizeReason(reason: string): string {
  const flat = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const out = flat.length > MAX_FAIL_REASON_CHARS ? `${flat.slice(0, MAX_FAIL_REASON_CHARS - 1)}…` : flat;
  return out || 'unknown error';
}

/**
 * Token counts to report. Ollama's own counts win. When the final message omits one (older Ollama
 * builds skip prompt_eval_count for a fully cached prompt) we estimate ~4 chars/token so the gateway
 * is never handed a 0 for work that was done. Completion tokens never exceed the job's maxTokens.
 */
export function usageFromFinal(final: OllamaFinal, promptChars: number, replyChars: number, maxTokens: number | null | undefined): { promptTokens: number; completionTokens: number } {
  const est = (chars: number) => (chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0);
  const promptTokens = final.promptTokens !== null && final.promptTokens >= 0 ? Math.floor(final.promptTokens) : est(promptChars);
  let completionTokens = final.completionTokens !== null && final.completionTokens >= 0 ? Math.floor(final.completionTokens) : est(replyChars);
  if (typeof maxTokens === 'number' && maxTokens > 0) completionTokens = Math.min(completionTokens, Math.floor(maxTokens));
  return { promptTokens, completionTokens };
}

const finishReasonOf = (doneReason: string) => (doneReason === 'length' ? 'length' : doneReason === 'stop' || !doneReason ? 'stop' : doneReason);

/**
 * Runs one job end to end: streams from Ollama, forwards deltas as ordered chunks (batched every
 * ~batchMs), then reports done with Ollama's token counts, or fail on any error / deadline. Never
 * rejects: every outcome is a RunResult, so a bad job cannot take the loop down.
 */
export async function runJob(job: Job, gateway: GatewayClient, nodeId: string, ollama: OllamaClient, opts: RunnerOptions = {}): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const batchMs = opts.batchMs ?? 40;
  const batchChars = opts.batchChars ?? 2048;
  const started = now();
  const jobId = typeof job?.jobId === 'string' ? job.jobId : '<no id>';

  const ac = new AbortController();
  const budget = deadlineBudget(job?.deadlineMs, started);
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
        await gateway.chunk(nodeId, jobId, mySeq, delta);
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

  let ollamaMessages: OllamaMessage[] = [];
  const finish = async (result: RunResult): Promise<RunResult> => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (flushTimer) clearTimeout(flushTimer);
    buf = '';
    if (job && typeof job === 'object') scrubJob(job, ollamaMessages);
    return result;
  };

  try {
    if (!job || typeof job !== 'object' || typeof job.jobId !== 'string' || typeof job.model !== 'string') throw new Error('malformed job from gateway (missing jobId/model)');
    ollamaMessages = toOllamaMessages(job.messages);
    if (ollamaMessages.length === 0) throw new Error('job has no messages');
    const promptChars = ollamaMessages.reduce((n, m) => n + m.content.length, 0);
    const final = await ollama.chatStream(
      { model: job.model, messages: ollamaMessages, options: toOllamaOptions(job.params, job.maxTokens), signal: ac.signal, stallMs: opts.stallMs },
      onDelta,
    );
    flush();
    await chain;
    if (st.sendError) throw st.sendError;
    if (chunks === 0) {
      // The gateway answers `409 empty_output` to a done with nothing delivered and fails the job
      // anyway; say so ourselves with a reason that helps the operator.
      throw new Error('model produced no output (empty reply)');
    }
    const body = { ...usageFromFinal(final, promptChars, chars, job.maxTokens), finishReason: finishReasonOf(final.doneReason) };
    await gateway.done(nodeId, jobId, body);
    const durationMs = now() - started;
    // Log lines carry ids, counts and timings only: never message or reply text (privacy.test.ts).
    log(`job ${jobId} done model=${job.model} tokens=${body.promptTokens}+${body.completionTokens} chunks=${chunks} chars=${chars} ${durationMs}ms`);
    return finish({ jobId, ok: true, ...body, chunks, chars, durationMs, outcome: 'done' });
  } catch (err) {
    const e = err as Error;
    // Let in-flight chunk POSTs settle so a `fail` never overtakes them on the wire.
    await chain.catch(() => undefined);
    const sendErr = st.sendError;
    const gwErr = (sendErr ?? e) instanceof GatewayError ? ((sendErr ?? e) as GatewayError) : null;
    const jobGone = gwErr !== null && gwErr.status === 409;
    const reason = sanitizeReason(
      deadlineHit
        ? `deadline of ${budget}ms exceeded`
        : jobGone
          ? gwErr.code === 'empty_output'
            ? 'gateway rejected done: no output was delivered (empty_output)'
            : 'job no longer running on the gateway (timed out, client left, or re-queued)'
          : sendErr
            ? `gateway chunk failed: ${sendErr.message}`
            : e?.message || String(err),
    );
    const durationMs = now() - started;
    log(`job ${jobId} ${jobGone ? 'abandoned' : 'failed'} after ${durationMs}ms: ${reason}`);
    if (!sendErr && !jobGone) {
      // Report the failure unless the gateway itself is what broke (a 409 means it already knows).
      await gateway.fail(nodeId, jobId, reason).catch((ferr: Error) => log(`could not report failure for ${jobId}: ${ferr.message}`));
    }
    return finish({ jobId, ok: false, promptTokens: 0, completionTokens: 0, finishReason: 'error', chunks, chars, durationMs, error: reason, outcome: jobGone ? 'gateway_rejected' : 'failed' });
  }
}
