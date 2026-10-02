import { describe, expect, it } from 'vitest';
import { averageSnapshots, replayBackward, timeWeightedBalances } from '../src/timeweight.js';

const H = 3600;

describe('timeWeightedBalances', () => {
  it('constant balances are unchanged', () => {
    const r = timeWeightedBalances({ from: 0, to: H, startBalances: new Map([['a', 100n]]), events: [] });
    expect(r.get('a')).toEqual({ end: 100n, weighted: 100n });
  });

  it('weights by time held inside the window', () => {
    // b receives 100 halfway through → average 50; a sells 100 halfway → 150 avg from 200
    const r = timeWeightedBalances({
      from: 0,
      to: H,
      startBalances: new Map([['a', 200n]]),
      events: [{ ts: H / 2, from: 'a', to: 'b', amount: 100n }],
    });
    expect(r.get('a')?.weighted).toBe(150n);
    expect(r.get('b')?.weighted).toBe(50n);
    expect(r.get('b')?.end).toBe(100n);
    // holdSince: b from 0 at H/2; a transferred out → reset to H/2
    expect(r.get('b')?.holdSinceTs).toBe(H / 2);
    expect(r.get('a')?.holdSinceTs).toBe(H / 2);
  });

  it('carries startHoldSince and keeps it on inbound top-ups', () => {
    const r = timeWeightedBalances({
      from: 1000,
      to: 1000 + H,
      startBalances: new Map([['a', 10n]]),
      startHoldSince: new Map([['a', 5]]),
      events: [{ ts: 2000, from: null, to: 'a', amount: 5n }],
    });
    expect(r.get('a')?.holdSinceTs).toBe(5);
    expect(r.get('a')?.end).toBe(15n);
  });

  it('a wallet that sells everything is dropped (or reported with weighted > 0, end 0)', () => {
    const r = timeWeightedBalances({
      from: 0,
      to: H,
      startBalances: new Map([['a', 100n]]),
      events: [{ ts: H / 4, from: 'a', to: null, amount: 100n }],
    });
    expect(r.get('a')).toEqual({ end: 0n, weighted: 25n });
  });

  it('ignores events outside the window', () => {
    const r = timeWeightedBalances({
      from: 100,
      to: 100 + H,
      startBalances: new Map([['a', 100n]]),
      events: [
        { ts: 50, from: 'a', to: 'b', amount: 100n },
        { ts: 100 + H, from: 'a', to: 'b', amount: 100n },
      ],
    });
    expect(r.get('a')?.weighted).toBe(100n);
    expect(r.has('b')).toBe(false);
  });
});

describe('replayBackward / averageSnapshots', () => {
  it('recovers the earlier snapshot', () => {
    const end = new Map([
      ['a', 100n],
      ['b', 100n],
    ]);
    const start = replayBackward(end, [
      { ts: 1, from: 'a', to: 'b', amount: 50n },
      { ts: 2, from: null, to: 'b', amount: 50n },
    ]);
    expect(start.get('a')).toBe(150n);
    expect(start.has('b')).toBe(false);
  });
  it('averages', () => {
    const avg = averageSnapshots(new Map([['a', 100n]]), new Map([['a', 200n], ['b', 10n]]));
    expect(avg.get('a')).toBe(150n);
    expect(avg.get('b')).toBe(5n);
  });
});
