/**
 * Default Ollama models by installed RAM. Everything fits in unified memory on Apple Silicon:
 *  - <= 16 GB: llama3.1:8b (~4.9 GB)
 *  - >= 32 GB: + qwen2.5:14b (~9 GB)
 *  - >= 64 GB: + llama3.1:70b (Q4_0, ~40 GB) only when the operator opts in with --with-70b.
 */
export const MODEL_8B = 'llama3.1:8b';
export const MODEL_14B = 'qwen2.5:14b';
/** Ollama's `llama3.1:70b` tag is the Q4_0 quant. */
export const MODEL_70B_Q4 = 'llama3.1:70b';

export function selectModels(ramGb: number, opts: { with70b?: boolean } = {}): string[] {
  const out = [MODEL_8B];
  if (ramGb >= 32) out.push(MODEL_14B);
  if (ramGb >= 64 && opts.with70b) out.push(MODEL_70B_Q4);
  return out;
}

/** Why a model was or was not chosen; used by `setup` output. */
export function describeSelection(ramGb: number, opts: { with70b?: boolean } = {}): string[] {
  const lines = [`${MODEL_8B}  (default for every node)`];
  if (ramGb >= 32) lines.push(`${MODEL_14B}  (RAM >= 32 GB)`);
  if (ramGb >= 64) lines.push(opts.with70b ? `${MODEL_70B_Q4}  (RAM >= 64 GB, --with-70b)` : `${MODEL_70B_Q4}  available: re-run setup with --with-70b (about 40 GB download)`);
  return lines;
}
