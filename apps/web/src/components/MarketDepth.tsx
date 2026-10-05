import { Link } from 'react-router-dom';
import { fmtUsd } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { fmtDiscount, getBook } from '../lib/market';
import { Skeleton } from './ui';

/**
 * Compact public widget for the landing page's live-numbers section: the best discount on the credit
 * market and how much credit is listed. Polls the public book.
 *
 * TODO(landing): drop `<MarketDepth />` into the "Live numbers" tiles in pages/Landing.tsx once the
 * section owner picks the slot (it renders as one `.tile`, so it fits the existing `.tiles` grid).
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

/** Numbers only, for callers that want to place them in their own layout. */
export function useMarketDepth(pollMs = 60_000): { bestDiscountBps: number | null; totalAvailableUsd: number; listings: number } | null {
  const { data } = useAsync(getBook, [], pollMs);
  return data ? { bestDiscountBps: data.bestDiscountBps, totalAvailableUsd: data.totalAvailableUsd, listings: data.listings } : null;
}
