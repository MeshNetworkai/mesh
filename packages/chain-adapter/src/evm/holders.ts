import type { Address, PublicClient } from 'viem';
import { erc20Abi } from './abi.js';
import type { TransferEvent } from '../timeweight.js';

/** Persisted replay state so each epoch only scans new blocks. */
export interface EvmBalanceState {
  /** Last block fully applied. */
  block: bigint;
  balances: Map<string, bigint>;
  holdSince: Map<string, number>;
}

export interface EvmStateStore {
  load(): EvmBalanceState | undefined;
  save(s: EvmBalanceState): void;
}

export function memoryStateStore(): EvmStateStore {
  let s: EvmBalanceState | undefined;
  return { load: () => s, save: (v) => void (s = v) };
}

export interface RawTransfer {
  block: bigint;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
}

/** Minimal subset of viem's PublicClient the holder scan uses (easy to fake in tests). */
export type ReadClient = Pick<PublicClient, 'getLogs' | 'getBlock' | 'getBlockNumber'>;

/** eth_getLogs for Transfer in [from, to], in chunks. */
export async function scanTransfers(
  client: ReadClient,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
): Promise<RawTransfer[]> {
  const out: RawTransfer[] = [];
  // Public RPCs cap eth_getLogs ranges (dRPC free ≈ 100 blocks, Alchemy free 10, Robinhood's own
  // endpoint sits behind a bot wall). When a chunk is refused, halve it and retry from the same block;
  // after a run of successes grow it back towards the configured size. The scan is incremental per
  // epoch, so a small chunk costs a few hundred cheap calls an hour, never correctness.
  let chunk = chunkBlocks > 0n ? chunkBlocks : 1n;
  let streak = 0;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    let logs: Array<{ blockNumber: bigint | null; logIndex: number | null; args: { from?: unknown; to?: unknown; value?: unknown } }>;
    try {
      logs = (await client.getLogs({ address: token, event: erc20Abi[0], fromBlock: start, toBlock: end })) as typeof logs;
    } catch (err) {
      if (chunk <= 1n) throw err;
      chunk = chunk / 2n;
      streak = 0;
      continue;
    }
    for (const l of logs) {
      if (l.blockNumber === null || l.logIndex === null) continue;
      out.push({
        block: l.blockNumber,
        logIndex: l.logIndex,
        from: (l.args.from as Address).toLowerCase() as Address,
        to: (l.args.to as Address).toLowerCase() as Address,
        value: l.args.value as bigint,
      });
    }
    start = end + 1n;
    if (chunk < chunkBlocks && ++streak >= 8) {
      chunk = chunk * 2n < chunkBlocks ? chunk * 2n : chunkBlocks;
      streak = 0;
    }
  }
  return out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
}

export class BlockTimestamps {
  private readonly cache = new Map<bigint, number>();
  constructor(private readonly client: ReadClient) {}

  known(block: bigint, ts: number): void {
    this.cache.set(block, ts);
  }

  async get(block: bigint): Promise<number> {
    const hit = this.cache.get(block);
    if (hit !== undefined) return hit;
    const b = await this.client.getBlock({ blockNumber: block });
    const ts = Number(b.timestamp);
    this.cache.set(block, ts);
    return ts;
  }

  /**
   * Timestamps for `blocks`. Up to `maxExact` distinct blocks are fetched exactly; beyond that,
   * blocks are interpolated between the range endpoints (exact at both ends).
   */
  async resolve(blocks: bigint[], maxExact: number): Promise<Map<bigint, number>> {
    const distinct = [...new Set(blocks)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = new Map<bigint, number>();
    if (distinct.length === 0) return out;
    if (distinct.length <= maxExact) {
      for (const b of distinct) out.set(b, await this.get(b));
      return out;
    }
    const lo = distinct[0];
    const hi = distinct[distinct.length - 1];
    const tLo = await this.get(lo);
    const tHi = await this.get(hi);
    for (const b of distinct) {
      if (hi === lo) out.set(b, tLo);
      else out.set(b, Math.round(tLo + (Number(b - lo) * (tHi - tLo)) / Number(hi - lo)));
    }
    return out;
  }

  /** Largest block with timestamp <= ts (binary search). */
  async blockAtOrBefore(ts: number, latest: bigint, lowest = 0n): Promise<bigint> {
    let lo = lowest;
    let hi = latest;
    if ((await this.get(hi)) <= ts) return hi;
    if ((await this.get(lo)) > ts) return lo;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await this.get(mid)) <= ts) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}

export const ZERO = '0x0000000000000000000000000000000000000000';

export function toEvents(raw: RawTransfer[], ts: Map<bigint, number>): TransferEvent[] {
  return raw.map((r) => ({
    ts: ts.get(r.block) ?? 0,
    from: r.from === ZERO ? null : r.from,
    to: r.to === ZERO ? null : r.to,
    amount: r.value,
  }));
}

/** Apply events to the persisted state (balances + holdSince), in order. */
export function applyToState(state: EvmBalanceState, events: TransferEvent[], upToBlock: bigint): void {
  for (const e of events) {
    if (e.amount <= 0n) continue;
    if (e.from) {
      const b = (state.balances.get(e.from) ?? 0n) - e.amount;
      if (b <= 0n) {
        state.balances.delete(e.from);
        state.holdSince.delete(e.from);
      } else {
        state.balances.set(e.from, b);
        state.holdSince.set(e.from, e.ts); // transfer out resets the holding age
      }
    }
    if (e.to) {
      const before = state.balances.get(e.to) ?? 0n;
      state.balances.set(e.to, before + e.amount);
      if (before === 0n) state.holdSince.set(e.to, e.ts);
    }
  }
  state.block = upToBlock;
}
