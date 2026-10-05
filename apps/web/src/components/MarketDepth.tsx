import { Link } from 'react-router-dom';
import { fmtUsd } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { fmtDiscount, getBook } from '../lib/market';
import { Skeleton } from './ui';

/**
 * Compact public widget: the best discount on the credit market and how much credit is listed.
 * Renders as one `.tile`, so it fits any `.tiles` grid. Polls the public book.
 */
export function MarketDepth({ pollMs = 60_000 }: { pollMs?: number }) {
  const { data, loading } = useAsync(getBook, [], pollMs);
  const best = data?.bestDiscountBps ?? null;
  return (
    <Link to="/app/market" className="tile" style={{ textDecoration: 'none' }} aria-label="Credit market depth">
      <span className="l">Credits on sale</span>
      <span className="n">{loading && !data ? <Skeleton w="5ch" h="0.9em" /> : best === null ? '—' : `${fmtDiscount(best)} off`}</span>
      <span className={`d ${best !== null ? 'up' : ''}`}>
        {loading && !data ? <Skeleton w="10ch" h="0.8em" /> : data && data.totalAvailableUsd > 0 ? `${fmtUsd(data.totalAvailableUsd, 0)} listed across ${data.listings} listing${data.listings === 1 ? '' : 's'}` : 'Nothing listed right now'}
      </span>
    </Link>
  );
}

/**
 * The liquidity book in miniature for the homepage: best discount as the figure, then one thin bar per
 * discount tier (deepest discount first, at most `rows`). Same data as /app/market, read-only.
 */
export function MarketDepthBook({ rows = 4, pollMs = 60_000 }: { rows?: number; pollMs?: number }) {
  const { data, loading } = useAsync(getBook, [], pollMs);
  const tiers = (data?.tiers ?? []).slice(0, rows);
  const deepest = Math.max(1e-9, ...tiers.map((t) => t.availableUsd));
  const best = data?.bestDiscountBps ?? null;
  const skel = loading && !data;
  return (
    <div className="depth" aria-label="Credit market, live">
      <div className="depth-head">
        <span className="depth-n num">{skel ? <Skeleton w="5ch" h="0.9em" /> : best === null ? '—' : `${fmtDiscount(best)} off`}</span>
        <span className="small muted">
          {skel ? <Skeleton w="14ch" h="0.8em" /> : data && data.totalAvailableUsd > 0 ? `best price · ${fmtUsd(data.totalAvailableUsd, 0)} of credit listed` : 'nothing listed right now'}
        </span>
      </div>
      {skel ? (
        <div className="depth-rows">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} w="100%" h="18px" />
          ))}
        </div>
      ) : tiers.length ? (
        <ul className="depth-rows" aria-label="Open listings by discount">
          {tiers.map((t) => (
            <li key={t.discountBps}>
              <span className="num">{fmtDiscount(t.discountBps)}</span>
              <span className="depth-bar" aria-hidden="true">
                <i style={{ width: `${Math.max(3, Math.round((t.availableUsd / deepest) * 100))}%` }} />
              </span>
              <span className="num muted">{fmtUsd(t.availableUsd, 0)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Sellers list credits at a discount; the first listing shows up here within seconds.</p>
      )}
    </div>
  );
}

/** Numbers only, for callers that want to place them in their own layout. */
export function useMarketDepth(pollMs = 60_000): { bestDiscountBps: number | null; totalAvailableUsd: number; listings: number } | null {
  const { data } = useAsync(getBook, [], pollMs);
  return data ? { bestDiscountBps: data.bestDiscountBps, totalAvailableUsd: data.totalAvailableUsd, listings: data.listings } : null;
}
