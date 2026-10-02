/**
 * Chain-agnostic time-weighted balance math. Both adapters reduce their chain's history to
 * `TransferEvent`s and call `timeWeightedBalances`.
 */

export interface TransferEvent {
  /** Unix seconds. */
  ts: number;
  /** null = mint / fee withdrawal source (no wallet loses balance). */
  from: string | null;
  /** null = burn. */
  to: string | null;
  /** Base units. */
  amount: bigint;
}

export interface HolderState {
  /** Balance at window end, base units. */
  end: bigint;
  /** Time-weighted average over the window, base units (integer division). */
  weighted: bigint;
  /** See HolderBalance.holdSinceTs. Undefined = not derivable from the data given. */
  holdSinceTs?: number;
}

export interface TimeWeightInput {
  from: number;
  to: number;
  /** Balances at `from` (base units). */
  startBalances: Map<string, bigint>;
  /** Events with from <= ts < to, any order. */
  events: TransferEvent[];
  /** Known holdSince at window start (full-history chains). Missing keys = unknown. */
  startHoldSince?: Map<string, number>;
}

/**
 * Forward replay from the start snapshot: Σ balance·dt / (to − from).
 * holdSinceTs: set when a balance goes 0 → >0 (inbound), reset to the event time on any
 * transfer out (per HolderBalance contract); otherwise carried from `startHoldSince`.
 */
export function timeWeightedBalances(input: TimeWeightInput): Map<string, HolderState> {
  const { from, to } = input;
  const dur = BigInt(Math.max(1, to - from));
  const bal = new Map<string, bigint>(input.startBalances);
  const holdSince = new Map<string, number>(input.startHoldSince ?? []);
  const acc = new Map<string, bigint>(); // Σ balance·dt
  const lastTs = new Map<string, number>();

  const settle = (w: string, ts: number) => {
    const prev = lastTs.get(w) ?? from;
    const b = bal.get(w) ?? 0n;
    if (ts > prev && b > 0n) acc.set(w, (acc.get(w) ?? 0n) + b * BigInt(ts - prev));
    lastTs.set(w, ts);
  };

  const events = [...input.events].filter((e) => e.ts >= from && e.ts < to).sort((a, b) => a.ts - b.ts);
  for (const e of events) {
    if (e.amount <= 0n) continue;
    const ts = Math.max(from, Math.min(to, e.ts));
    if (e.from) {
      settle(e.from, ts);
      const b = (bal.get(e.from) ?? 0n) - e.amount;
      bal.set(e.from, b < 0n ? 0n : b);
      holdSince.set(e.from, ts);
      if (b <= 0n) holdSince.delete(e.from);
    }
    if (e.to) {
      settle(e.to, ts);
      const before = bal.get(e.to) ?? 0n;
      bal.set(e.to, before + e.amount);
      if (before === 0n) holdSince.set(e.to, ts);
    }
  }
  const out = new Map<string, HolderState>();
  const wallets = new Set<string>([...bal.keys(), ...acc.keys()]);
  for (const w of wallets) {
    settle(w, to);
    const end = bal.get(w) ?? 0n;
    const weighted = (acc.get(w) ?? 0n) / dur;
    if (end === 0n && weighted === 0n) continue;
    const hs = end > 0n ? holdSince.get(w) : undefined;
    out.set(w, { end, weighted, ...(hs !== undefined ? { holdSinceTs: hs } : {}) });
  }
  return out;
}

/** Undo `events` on top of `endBalances` to recover balances before the earliest event. */
export function replayBackward(endBalances: Map<string, bigint>, events: TransferEvent[]): Map<string, bigint> {
  const bal = new Map<string, bigint>(endBalances);
  for (const e of [...events].sort((a, b) => b.ts - a.ts)) {
    if (e.to) {
      const b = (bal.get(e.to) ?? 0n) - e.amount;
      bal.set(e.to, b < 0n ? 0n : b);
    }
    if (e.from) bal.set(e.from, (bal.get(e.from) ?? 0n) + e.amount);
  }
  for (const [w, b] of bal) if (b <= 0n) bal.delete(w);
  return bal;
}

/** Average of two snapshots (fallback when no transaction history is available). */
export function averageSnapshots(a: Map<string, bigint>, b: Map<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const w of new Set([...a.keys(), ...b.keys()])) {
    const v = ((a.get(w) ?? 0n) + (b.get(w) ?? 0n)) / 2n;
    if (v > 0n) out.set(w, v);
  }
  return out;
}
