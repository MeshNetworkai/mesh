import { TOKENOMICS } from '../config';
import { fmtInt, fmtUsd, pad2 } from '../lib/format';
import { useEpochCountdown } from '../lib/hooks';
import type { Stats } from '../lib/types';
import { Skeleton } from './ui';

/** The landing hero's object: countdown to the next distribution plus last-epoch numbers. */
export function Readout({ stats, loading, yourShareUsd }: { stats: Stats | null; loading: boolean; yourShareUsd?: number | null }) {
  const { remaining, progress } = useEpochCountdown(stats?.epochSeconds);
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = Math.floor(remaining % 60);
  const last = stats?.lastEpoch ?? null;
  const toHolders = last ? (last.feesUsd * TOKENOMICS.holderShareBps) / 10_000 : null;
  const epochNo = stats ? stats.epochsRun + 1 : null;

  return (
    <div className="readout" aria-label="Next distribution">
      <div className="head">
        <span className="eyebrow">Next distribution</span>
        <span className="pill sm">
          <span className="dot dot-live" aria-hidden="true" />
          {loading && !stats ? <Skeleton w="7ch" /> : `Epoch ${epochNo !== null ? pad2(epochNo) : '—'}`}
        </span>
      </div>
      <div>
        <p className="big" aria-live="off">
          {pad2(h)}:<em>{pad2(m)}</em>:{pad2(s)}
        </p>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Epoch progress">
          <i style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
      </div>
      <div className="kv">
        <span>Fees collected last epoch</span>
        <b>{loading && !stats ? <Skeleton /> : last ? fmtUsd(last.feesUsd) : '—'}</b>
        <span>To holders</span>
        <b>{loading && !stats ? <Skeleton /> : toHolders !== null ? fmtUsd(toHolders) : '—'}</b>
        <span>Eligible wallets</span>
        <b>{loading && !stats ? <Skeleton /> : fmtInt(stats?.holdersEligibleLastEpoch ?? null)}</b>
        {yourShareUsd !== undefined ? (
          <>
            <span>Your share</span>
            <b className="pos">{yourShareUsd === null ? '—' : fmtUsd(yourShareUsd, 3)}</b>
          </>
        ) : null}
      </div>
    </div>
  );
}
