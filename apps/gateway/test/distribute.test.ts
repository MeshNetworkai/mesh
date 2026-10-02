import { MockAdapter } from '@mesh/chain-adapter';
import { describe, expect, it } from 'vitest';
import { getEpoch, previousEpochStart, runEpoch } from '../src/jobs/distribute.js';
import { balanceMicros } from '../src/ledger.js';
import { memDb, testConfig } from './helpers.js';

describe('distribution epoch', () => {
  it('splits fees holder/treasury and distributes pro-rata to holders >= minHoldTokens', async () => {
    const db = memDb();
    const adapter = new MockAdapter({
      holders: { alice: 60_000, bob: 30_000, carol: 10_000, dust: 999, exact: 1_000 },
    });
    adapter.pushFees(100);

    const r = await runEpoch({ db, adapter, config: testConfig }, 3600);

    expect(r.status).toBe('complete');
    expect(r.feesUsdMicros).toBe(100_000_000);
    expect(r.holderPoolUsdMicros).toBe(50_000_000); // 50%
    expect(r.treasuryUsdMicros).toBe(50_000_000);
    expect(r.eligibleHolders).toBe(4); // dust (999) excluded, exact (1000) included
    const byWallet = Object.fromEntries(r.distributed.map((d) => [d.wallet, d.usdMicros]));
    expect(byWallet.dust).toBeUndefined();
    const total = 60_000 + 30_000 + 10_000 + 1_000;
    const aliceFloor = Math.floor((50_000_000 * 60_000) / total);
    expect(byWallet.alice === aliceFloor || byWallet.alice === aliceFloor + 1).toBe(true);
    expect(byWallet.exact).toBeGreaterThan(0);
    expect(Object.values(byWallet).reduce((a, b) => a + b, 0)).toBe(50_000_000);
    expect(balanceMicros(db, 'alice')).toBe(byWallet.alice);
    expect(balanceMicros(db, 'dust')).toBe(0);
    expect(getEpoch(db, 3600)?.status).toBe('complete');
    expect(getEpoch(db, 3600)?.epoch_end).toBe(7200);
  });

  it('is idempotent per epoch_start', async () => {
    const db = memDb();
    const adapter = new MockAdapter({ holders: { alice: 5_000, bob: 5_000 } });
    adapter.pushFees(10);
    const first = await runEpoch({ db, adapter, config: testConfig }, 7200);
    expect(first.status).toBe('complete');
    expect(balanceMicros(db, 'alice')).toBe(2_500_000);

    adapter.pushFees(10); // new fees arrive, but same epoch -> must not double-pay
    const second = await runEpoch({ db, adapter, config: testConfig }, 7200);
    expect(second.status).toBe('skipped');
    expect(second.distributed).toEqual([]);
    expect(balanceMicros(db, 'alice')).toBe(2_500_000);
    expect(adapter.pendingFees()).toBe(10); // fees untouched by the skipped run

    const third = await runEpoch({ db, adapter, config: testConfig }, 10_800);
    expect(third.status).toBe('complete');
    expect(balanceMicros(db, 'alice')).toBe(5_000_000);
  });

  it('records an empty epoch when there are no fees', async () => {
    const db = memDb();
    const adapter = new MockAdapter();
    const r = await runEpoch({ db, adapter, config: testConfig }, 0);
    expect(r.status).toBe('empty');
    expect(r.distributed).toEqual([]);
    expect(getEpoch(db, 0)?.status).toBe('empty');
  });

  it('applies creditUsdPerFeeUsd conversion', async () => {
    const db = memDb();
    const adapter = new MockAdapter({ holders: { a: 10_000 } });
    adapter.pushFees(100);
    const r = await runEpoch({ db, adapter, config: { ...testConfig, creditUsdPerFeeUsd: 0.5 } }, 3600);
    expect(r.holderPoolUsdMicros).toBe(25_000_000);
    expect(balanceMicros(db, 'a')).toBe(25_000_000);
  });

  it('previousEpochStart is the last completed window', () => {
    expect(previousEpochStart({ epochSeconds: 3600 }, 10_000)).toBe(3600);
    expect(previousEpochStart({ epochSeconds: 3600 }, 7200)).toBe(3600);
    expect(previousEpochStart({ epochSeconds: 3600 }, 7199)).toBe(0);
  });
});
