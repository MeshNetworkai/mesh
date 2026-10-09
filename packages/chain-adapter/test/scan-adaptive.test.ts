import { describe, expect, it } from 'vitest';
import { scanTransfers } from '../src/evm/holders.js';

/** Free RPC tiers refuse wide eth_getLogs ranges: the scanner halves the chunk and carries on. */
describe('scanTransfers adapts the chunk to what the RPC accepts', () => {
  it('halves on refusal, covers every block exactly once, grows back after a streak', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock + 1n > 100n) throw new Error('ranges over 100 blocks are not supported');
        calls.push([fromBlock, toBlock]);
        return [{ blockNumber: fromBlock, logIndex: 0, args: { from: '0xA', to: '0xB', value: 1n } }];
      },
    } as never;
    const out = await scanTransfers(client, '0x0000000000000000000000000000000000000001', 1000n, 4999n, 5000n);
    // every accepted call is ≤ 100 blocks, contiguous and non-overlapping
    expect(calls.every(([a, b]) => b - a + 1n <= 100n)).toBe(true);
    for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBe(calls[i - 1][1] + 1n);
    expect(calls[0][0]).toBe(1000n);
    expect(calls[calls.length - 1][1]).toBe(4999n);
    expect(out.length).toBe(calls.length);
  });

  it('gives up only when a single block is refused', async () => {
    const client = { getLogs: async () => { throw new Error('nope'); } } as never;
    await expect(scanTransfers(client, '0x0000000000000000000000000000000000000001', 1n, 10n, 8n)).rejects.toThrow('nope');
  });
});
