/** All money is stored as integer micro-USD (1 USD = 1_000_000). */
export const MICROS = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) throw new Error('usd must be finite');
  return Math.round(usd * MICROS);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS;
}

export function bpsOf(micros: number, bps: number): number {
  return Math.floor((micros * bps) / 10_000);
}

/**
 * Split `total` across weights pro-rata using integer math. Remainder from
 * flooring goes to the largest weights first so sum(result) === total exactly.
 */
export function splitProRata(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let remainder = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r), w: weights[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) out[order[k].i] += 1;
  return out;
}
