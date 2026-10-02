import { describe, expect, it } from 'vitest';
import { addLedgerEntry, balanceMicros, ensureWallet, recentLedger } from '../src/ledger.js';
import { bpsOf, microsToUsd, splitProRata, usdToMicros } from '../src/money.js';
import { memDb } from './helpers.js';

describe('money math', () => {
  it('converts USD <-> micros exactly', () => {
    expect(usdToMicros(1)).toBe(1_000_000);
    expect(usdToMicros(0.001)).toBe(1_000);
    expect(usdToMicros(12.3456789)).toBe(12_345_679);
    expect(microsToUsd(2_500_000)).toBe(2.5);
  });

  it('bps split floors', () => {
    expect(bpsOf(100_000_000, 5000)).toBe(50_000_000);
    expect(bpsOf(1, 5000)).toBe(0);
  });

  it('pro-rata split sums exactly to total', () => {
    const out = splitProRata(100, [1, 1, 1]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out.sort()).toEqual([33, 33, 34]);
    expect(splitProRata(50_000_000, [60_000, 30_000, 10_000])).toEqual([30_000_000, 15_000_000, 5_000_000]);
    expect(splitProRata(10, [])).toEqual([]);
    expect(splitProRata(0, [1, 2])).toEqual([0, 0]);
  });

  it('pro-rata is deterministic for ties', () => {
    expect(splitProRata(7, [5, 5, 5])).toEqual(splitProRata(7, [5, 5, 5]));
    expect(splitProRata(7, [5, 5, 5]).reduce((a, b) => a + b, 0)).toBe(7);
  });
});

describe('ledger', () => {
  it('balance is the integer sum of deltas', () => {
    const db = memDb();
    ensureWallet(db, 'w1', 'solana');
    addLedgerEntry(db, { wallet: 'w1', deltaMicros: 5_000_000, kind: 'starter' });
    addLedgerEntry(db, { wallet: 'w1', deltaMicros: -1_234, kind: 'usage', ref: 'req:1' });
    addLedgerEntry(db, { wallet: 'w1', deltaMicros: 250_000, kind: 'distribution', ref: 'epoch:0' });
    addLedgerEntry(db, { wallet: 'w2', deltaMicros: 99, kind: 'adjustment' });
    expect(balanceMicros(db, 'w1')).toBe(5_000_000 - 1_234 + 250_000);
    expect(balanceMicros(db, 'w2')).toBe(99);
    expect(balanceMicros(db, 'nobody')).toBe(0);
    expect(recentLedger(db, 'w1').map((r) => r.kind)).toEqual(['distribution', 'usage', 'starter']);
  });

  it('rejects non-integer micros and unknown kinds', () => {
    const db = memDb();
    expect(() => addLedgerEntry(db, { wallet: 'w', deltaMicros: 1.5, kind: 'usage' })).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('w', 1, 'bogus', 0)`).run(),
    ).toThrow();
  });
});
