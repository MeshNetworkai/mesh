import { MockAdapter } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { describe, expect, it } from 'vitest';
import { holdingAgeMultiplier, resolveHoldSince, runEpoch } from '../src/jobs/distribute.js';
import { balanceMicros } from '../src/ledger.js';
import { memDb, testConfig } from './helpers.js';

const DAY = 86_400;
const E = 1_700_000_000 - (1_700_000_000 % 3600); // epoch start
const END = E + 3600;

const enabled = (over: Partial<TokenomicsConfig['distribution']['holdingAge']> = {}): TokenomicsConfig => ({
  ...testConfig,
  distribution: { holdingAge: { enabled: true, maxDays: 30, minMultiplier: 1, maxMultiplier: 2, ...over } },
});

describe('holding-age multiplier', () => {
  const cfg = enabled().distribution.holdingAge;

  it('is linear from min at age 0 to max at maxDays, clamped', () => {
    expect(holdingAgeMultiplier(cfg, END, END)).toBe(1);
    expect(holdingAgeMultiplier(cfg, END - 15 * DAY, END)).toBeCloseTo(1.5, 9);
    expect(holdingAgeMultiplier(cfg, END - 30 * DAY, END)).toBe(2);
    expect(holdingAgeMultiplier(cfg, END - 365 * DAY, END)).toBe(2);
    expect(holdingAgeMultiplier(cfg, END + DAY, END)).toBe(1); // future timestamps never go below min
  });

  it('honours custom min/max/maxDays', () => {
    const c = enabled({ maxDays: 10, minMultiplier: 0.5, maxMultiplier: 1.5 }).distribution.holdingAge;
    expect(holdingAgeMultiplier(c, END - 5 * DAY, END)).toBeCloseTo(1.0, 9);
    expect(holdingAgeMultiplier(c, END - 10 * DAY, END)).toBe(1.5);
  });

  it('is 1 when disabled or when the age is unknown', () => {
    expect(holdingAgeMultiplier({ ...cfg, enabled: false }, END - 30 * DAY, END)).toBe(1);
    expect(holdingAgeMultiplier(cfg, undefined, END)).toBe(1);
  });
});

describe('distribution with holding-age weighting', () => {
  it('disabled flag → identical to plain pro-rata, even with very different ages', async () => {
    const mk = (holdSince: Record<string, number>) => new MockAdapter({ holders: { alice: 60_000, bob: 30_000, carol: 10_000 }, holdSince });
    const plainDb = memDb();
    const plain = mk({ alice: END, bob: END, carol: END });
    plain.pushFees(100);
    const a = await runEpoch({ db: plainDb, adapter: plain, config: testConfig }, E);

    const agedDb = memDb();
    const aged = mk({ alice: END, bob: END - 15 * DAY, carol: END - 60 * DAY });
    aged.pushFees(100);
    const b = await runEpoch({ db: agedDb, adapter: aged, config: testConfig }, E);

    expect(a.holdingAgeApplied).toBe(false);
    expect(b.holdingAgeApplied).toBe(false);
    expect(b.distributed).toEqual(a.distributed);
    expect(b.distributed.every((d) => d.multiplier === 1)).toBe(true);
    expect(b.distributed.map((d) => d.usdMicros)).toEqual([30_000_000, 15_000_000, 5_000_000]); // alice, bob, carol (sorted by wallet)
  });

  it('weights balance × multiplier(age) when enabled', async () => {
    const db = memDb();
    // alice: new (×1), bob: 15 days (×1.5), carol: 60 days (×2, clamped at 30d)
    const adapter = new MockAdapter({
      holders: { alice: 60_000, bob: 30_000, carol: 10_000 },
      holdSince: { alice: END, bob: END - 15 * DAY, carol: END - 60 * DAY },
    });
    adapter.pushFees(100);
    const r = await runEpoch({ db, adapter, config: enabled() }, E);
    expect(r.holdingAgeApplied).toBe(true);
    const by = Object.fromEntries(r.distributed.map((d) => [d.wallet, d]));
    expect(by.alice.multiplier).toBe(1);
    expect(by.bob.multiplier).toBeCloseTo(1.5, 9);
    expect(by.carol.multiplier).toBe(2);
    // weights: 60k, 45k, 20k → 125k total; pool $50
    const pool = 50_000_000;
    expect(Math.abs(by.alice.usdMicros - (pool * 60) / 125)).toBeLessThanOrEqual(1);
    expect(Math.abs(by.bob.usdMicros - (pool * 45) / 125)).toBeLessThanOrEqual(1);
    expect(Math.abs(by.carol.usdMicros - (pool * 20) / 125)).toBeLessThanOrEqual(1);
    expect(r.distributed.reduce((a, d) => a + d.usdMicros, 0)).toBe(pool);
    expect(balanceMicros(db, 'carol')).toBe(by.carol.usdMicros);
    // eligibility is still on raw balance: a 90-day-old dust wallet earns nothing
    adapter.setHolder('dust', 500, END - 90 * DAY);
    adapter.pushFees(10);
    const r2 = await runEpoch({ db, adapter, config: enabled() }, E + 3600);
    expect(r2.eligibleHolders).toBe(3);
    expect(r2.distributed.find((d) => d.wallet === 'dust')).toBeUndefined();
  });

  it('a transfer out resets the age (mock adapter)', async () => {
    const clock = { t: END };
    const adapter = new MockAdapter({ holders: { alice: 10_000, bob: 10_000 }, holdSince: { alice: END - 30 * DAY, bob: END - 30 * DAY }, now: () => clock.t });
    const db = memDb();
    adapter.pushFees(100);
    const r1 = await runEpoch({ db, adapter, config: enabled() }, E);
    expect(r1.distributed.map((d) => d.usdMicros)).toEqual([25_000_000, 25_000_000]);

    adapter.transferOut('bob', 1_000); // bob now 9k, age reset to "now" (END)
    expect(adapter.holdSinceOf('bob')).toBe(END);
    expect(adapter.holdSinceOf('alice')).toBe(END - 30 * DAY);
    adapter.pushFees(100);
    const r2 = await runEpoch({ db, adapter, config: enabled() }, E + 3600);
    const by = Object.fromEntries(r2.distributed.map((d) => [d.wallet, d]));
    expect(by.alice.multiplier).toBe(2);
    expect(by.bob.multiplier).toBeCloseTo(1 + 3600 / (30 * DAY), 9); // one epoch of age
    expect(by.alice.usdMicros).toBeGreaterThan(by.bob.usdMicros * 2);

    // buying more does not reset
    adapter.setHolder('alice', 20_000);
    expect(adapter.holdSinceOf('alice')).toBe(END - 30 * DAY);
  });

  it('falls back to the holder_age cache when the adapter cannot report holdSinceTs', async () => {
    const db = memDb();
    const adapter = new MockAdapter({ holders: { alice: 10_000, bob: 10_000 }, reportHoldSince: false });
    adapter.pushFees(100);
    // epoch 1: both first seen now → age 0 → equal split, cache rows written
    const r1 = await runEpoch({ db, adapter, config: enabled() }, E);
    expect(r1.distributed.every((d) => d.multiplier === 1)).toBe(true);
    const rows = db.prepare(`SELECT wallet, hold_since, last_balance FROM holder_age ORDER BY wallet`).all();
    expect(rows).toEqual([
      { wallet: 'alice', hold_since: END, last_balance: 10_000 },
      { wallet: 'bob', hold_since: END, last_balance: 10_000 },
    ]);

    // 30 days later: both aged 30d → ×2 each; bob sold some → bob resets
    const later = E + 30 * DAY;
    adapter.setHolder('bob', 9_000);
    adapter.pushFees(100);
    const r2 = await runEpoch({ db, adapter, config: enabled() }, later);
    const by = Object.fromEntries(r2.distributed.map((d) => [d.wallet, d]));
    expect(by.alice.multiplier).toBe(2);
    expect(by.bob.multiplier).toBe(1);
    expect(db.prepare(`SELECT hold_since FROM holder_age WHERE wallet='bob'`).get()).toEqual({ hold_since: later + 3600 });

    // dropping below the threshold forgets the wallet
    adapter.setHolder('bob', 500);
    await runEpoch({ db, adapter, config: enabled() }, later + 3600);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM holder_age`).get()).toEqual({ n: 1 });
  });

  it('resolveHoldSince prefers adapter values and caches them', () => {
    const db = memDb();
    const m = resolveHoldSince(db, [{ wallet: 'a', timeWeightedBalance: 5_000, holdSinceTs: 123 }, { wallet: 'b', timeWeightedBalance: 5_000 }], 1_000, 999);
    expect(m.get('a')).toBe(123);
    expect(m.get('b')).toBe(999);
    expect(db.prepare(`SELECT hold_since FROM holder_age WHERE wallet='a'`).get()).toEqual({ hold_since: 123 });
  });
});
