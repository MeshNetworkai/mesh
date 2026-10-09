import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FLEET_PUBLIC } from '../content/flags';
import { Sparkline } from '../components/Sparkline';
import { Empty, Notice, Skeleton, Spinner, Tile } from '../components/ui';
import { STORAGE, TOKENOMICS, pctFromBps } from '../config';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtCost, fmtInt, fmtSignedUsd, fmtTime, fmtUsd, fmtDate } from '../lib/format';
import { useCopy, useMe, useMyPoints, useMyReferral, useStats } from '../lib/hooks';
import type { LedgerRow, PointsRules } from '../lib/types';
import { fmtPoints } from './Leaderboard';

/** Ledger is newest-first; walk it to attach the running balance after each row. */
function withBalances(rows: LedgerRow[], currentUsd: number): Array<LedgerRow & { balanceUsd: number }> {
  let bal = currentUsd;
  return rows.map((r) => {
    const out = { ...r, balanceUsd: bal };
    bal -= r.deltaUsd;
    return out;
  });
}

const KIND_LABELS: Record<string, string> = {
  distribution: 'Distribution',
  usage: 'Usage',
  starter: 'Starter credit',
  adjustment: 'Adjustment',
  market_escrow: 'Listed for sale',
  market_refund: 'Listing returned',
  market_buy: 'Bought on the market',
  purchase: 'Bought from Mesh',
  expiry: 'Expired',
  node_payout: 'Node rewards',
};

function kindLabel(kind: string) {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** "How to earn" — the live rules behind the Points tile, on hover or focus. */
function EarnTip({ rules }: { rules: PointsRules | null }) {
  const r = rules;
  return (
    <span className="tip">
      <button type="button" className="tip-btn" aria-label="How to earn points" aria-describedby="earn-tip">
        ?
      </button>
      <span className="tip-body" role="tooltip" id="earn-tip">
        <b>How to earn</b>
        <span>{r ? `${fmtInt(r.perUsdCredits)} pts per $1 of credits received` : '…'}</span>
        <span>{r ? `${fmtInt(r.perUsdSpent)} pts per $1 spent on requests` : '…'}</span>
        <span>{r ? `${r.perNodeTokenK} pt per 1k tokens your nodes serve` : '…'}</span>
        <span>{r ? `${fmtInt(r.perReferralSignup)} pts per referral + ${r.referralSharePercent}% of their points` : '…'}</span>
        <span className="muted">{r ? `Cap ${fmtInt(r.dailyCapPerWallet)} pts per day. Convert to ${TOKENOMICS.ticker} at TGE; not a promise.` : ''}</span>
      </span>
    </span>
  );
}

function ReferralCard() {
  const { token } = useAuth();
  const ref = useMyReferral();
  const [copied, copy] = useCopy();
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE.referralCode) ?? '';
    } catch {
      return '';
    }
  });
  const [claim, setClaim] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({ busy: false, msg: null, ok: false });
  const data = ref.data;

  const submit = async () => {
    if (!token || !code.trim()) return;
    setClaim({ busy: true, msg: null, ok: false });
    try {
      const r = await api.claimReferral(token, code.trim());
      setClaim({ busy: false, ok: true, msg: `Linked to ${r.referrer}. They earn ${r.sharePercent}% on top of your points; yours are unchanged.` });
      try {
        localStorage.removeItem(STORAGE.referralCode);
      } catch {
        /* ignore */
      }
      void ref.reload();
    } catch (err) {
      setClaim({ busy: false, ok: false, msg: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="panel refcard">
      <div className="row between">
        <span className="eyebrow">Refer a wallet</span>
        {data ? (
          <span className="small muted">
            {fmtInt(data.perReferralSignup)} pts per signup · {data.referralSharePercent}% of their points
          </span>
        ) : null}
      </div>
      {ref.error && !data ? <Notice kind="bad">Could not load your referral code: {ref.error}</Notice> : null}
      <div className="refgrid">
        <div>
          <span className="l">Your code</span>
          <span className="code mono">{data ? data.code : <Skeleton w="6ch" />}</span>
        </div>
        <div>
          <span className="l">Referred</span>
          <span className="n">{data ? fmtInt(data.referred) : <Skeleton w="2ch" />}</span>
        </div>
        <div>
          <span className="l">Points earned</span>
          <span className="n">{data ? fmtPoints(data.pointsEarned) : <Skeleton w="5ch" />}</span>
        </div>
      </div>
      <div className="row">
        <button className="btn accent sm" disabled={!data} onClick={() => data && copy(data.link)}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        {data ? (
          <span className="small mono muted" style={{ overflowWrap: 'anywhere' }}>
            {data.link}
          </span>
        ) : null}
      </div>
      {data && !data.referredBy ? (
        <form
          className="row claim"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="small muted" htmlFor="ref-code">
            Have a code?
          </label>
          <input
            id="ref-code"
            className="input mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={6}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn secondary sm" type="submit" disabled={claim.busy || code.trim().length !== 6}>
            {claim.busy ? <Spinner /> : 'Claim'}
          </button>
        </form>
      ) : data?.referredBy ? (
        <span className="small muted">Referred by {data.referredBy}.</span>
      ) : null}
      {claim.msg ? <Notice kind={claim.ok ? 'ok' : 'bad'}>{claim.msg}</Notice> : null}
    </div>
  );
}

/** Pre-launch points tile. Rendered only while GET /stats says pointsEnabled (programme is built, disabled by default). */
function PointsTile() {
  const pts = useMyPoints();
  const points = pts.data;
  return (
    <Tile
      label={
        <>
          Points <EarnTip rules={points?.rules ?? null} />
        </>
      }
      loading={pts.loading && !points}
      value={points ? fmtPoints(points.points) : pts.error ? '—' : '—'}
      delta={
        !points
          ? pts.error
            ? 'Points unavailable'
            : '—'
          : points.delta24h > 0
            ? `+${fmtPoints(points.delta24h)} · 24h${points.rank ? ` · #${fmtInt(points.rank)}` : ''}`
            : points.rank
              ? `No change · 24h · #${fmtInt(points.rank)}`
              : `Earn before launch; converts to ${TOKENOMICS.ticker}`
      }
      deltaKind={points && points.delta24h > 0 ? 'up' : ''}
    />
  );
}

export function Dashboard() {
  const me = useMe();
  const st = useStats();
  const stats = st.data;
  const pointsEnabled = stats?.pointsEnabled === true;

  const lastDist = me.data?.ledger.find((r) => r.kind === 'distribution') ?? null;
  const series = stats?.series24h ?? null;
  // Compare the last two *completed* hours: the current bucket is still filling.
  const feesDelta = useMemo(() => {
    if (!series || series.length < 3) return null;
    const a = series[series.length - 3].feesUsd;
    const b = series[series.length - 2].feesUsd;
    return a > 0 ? ((b - a) / a) * 100 : null;
  }, [series]);
  const feesThisEpoch = stats?.feesThisEpochUsd ?? null;
  const rows = me.data ? withBalances(me.data.ledger, me.data.balance.usd) : [];
  const loading = me.loading && !me.data;
  const savings = me.data?.savings ?? null;
  const showSavings = stats?.showSavings !== false;
  // Credit expiry (docs/PRICING.md §6): what lapses next in this wallet, and the starter credit that cannot be sold.
  const expiry = me.data?.expiry ?? null;
  const starterLeft = me.data?.nonTransferableUsd ?? 0;
  const directOn = stats?.directSalesEnabled ?? TOKENOMICS.directSales.enabled;

  return (
    <>
      <div className="row between">
        <span className="display d-s">Your credits</span>
        <span className="small muted">
          {me.data ? `${me.data.chain} · updated ${fmtTime(Math.floor(Date.now() / 1000))}` : ''}
        </span>
      </div>

      {me.error && !me.data ? <Notice kind="bad">Could not load your account: {me.error}</Notice> : null}

      <div className="tiles dense">
        <Tile
          label="Balance"
          loading={loading}
          value={fmtUsd(me.data?.balance.usd ?? null, 3)}
          delta={lastDist ? `${fmtSignedUsd(lastDist.deltaUsd)} last epoch` : 'No distribution yet'}
          deltaKind={lastDist ? 'up' : ''}
        />
        <Tile
          label="Eligible holders"
          loading={st.loading && !stats}
          value={stats?.tokenLive === false ? '—' : fmtInt(stats?.holdersEligibleLastEpoch ?? null)}
          delta={stats?.tokenLive === false ? 'counts start at the token launch' : stats?.lastEpoch ? `epoch ${fmtDate(stats.lastEpoch.epochStart)}` : '—'}
        />
        <Tile
          label={feesThisEpoch !== null ? 'Fees this epoch' : 'Fees last epoch'}
          loading={st.loading && !stats}
          value={feesThisEpoch !== null ? fmtUsd(feesThisEpoch) : stats?.lastEpoch ? fmtUsd(stats.lastEpoch.feesUsd) : '—'}
          delta={
            feesThisEpoch !== null && stats?.lastEpoch
              ? `${fmtUsd(stats.lastEpoch.feesUsd)} last epoch`
              : feesDelta !== null
                ? `${feesDelta >= 0 ? '+' : '−'}${Math.abs(feesDelta).toFixed(0)}% vs hour before`
                : 'last completed epoch'
          }
          deltaKind={feesThisEpoch !== null || feesDelta === null ? '' : feesDelta >= 0 ? 'up' : 'dn'}
        />
        {FLEET_PUBLIC ? (
          <Tile label="Nodes online" loading={st.loading && !stats} value={fmtInt(stats?.nodesOnline ?? null)} delta={stats ? `upstream ${stats.upstream}` : '—'} />
        ) : null}
        {expiry?.enabled ? (
          <Tile
            label="Expires next"
            loading={loading}
            value={expiry.next ? fmtUsd(expiry.next.usd, 3) : '—'}
            delta={expiry.next ? `on ${fmtDate(expiry.next.at)} · ${fmtUsd(expiry.within30dUsd)} within 30 days` : `nothing ageing · credits last ${expiry.days} days`}
            deltaKind={expiry.within7dUsd > 0 ? 'dn' : ''}
          />
        ) : null}
        {pointsEnabled ? <PointsTile /> : null}
        {showSavings ? (
          <Tile
            label="Saved on Mesh nodes"
            loading={loading}
            value={savings ? fmtCost(savings.usdTotal) : '—'}
            delta={
              !savings
                ? '—'
                : savings.networkRequests === 0
                  ? 'No node-served requests yet'
                  : savings.multiplier > 1
                    ? `${savings.multiplier.toFixed(1)}× further · ${Math.round(savings.networkSharePercent)}% on nodes`
                    : `${Math.round(savings.networkSharePercent)}% on nodes · same as list`
            }
            deltaKind={savings && savings.multiplier > 1 ? 'up' : ''}
          />
        ) : null}
      </div>

      {expiry?.enabled && expiry.within7dUsd > 0 ? (
        <Notice>
          {fmtUsd(expiry.within7dUsd, 3)} of your credit lapses within 7 days. Credits last {expiry.days} days from the day they land and the oldest are spent first:{' '}
          <Link to="/app/chat">spend it</Link>
          {starterLeft >= expiry.within7dUsd ? '.' : (
            <>
              , or <Link to="/app/market">list it for sale</Link> while it still has time to sell.
            </>
          )}{' '}
          <Link to="/docs#expiry">How expiry works</Link>
        </Notice>
      ) : null}
      {starterLeft > 0 ? (
        <p className="small muted">
          {fmtUsd(starterLeft, 3)} of your balance is starter credit: it spends on any model and is used first, and it cannot be listed on the market.
        </p>
      ) : null}

      <div>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="eyebrow">Fees → credits · last 24h · USD</span>
          {series ? (
            <span className="eyebrow">
              {fmtUsd(series.reduce((a, p) => a + p.feesUsd, 0))} total
            </span>
          ) : null}
        </div>
        {st.loading && !stats ? (
          <Skeleton w="100%" h="72px" />
        ) : series && series.length > 1 ? (
          <Sparkline points={series} label="Hourly fees over the last 24 hours" />
        ) : (
          <div className="empty" style={{ padding: 20 }}>
            <span className="small">No fees recorded in the last 24 hours. Totals above are live.</span>
          </div>
        )}
      </div>

      {pointsEnabled ? <ReferralCard /> : null}

      <div className="row">
        <Link className="btn primary" to="/app/keys">
          Create API key
        </Link>
        {pointsEnabled ? (
          <Link className="btn secondary" to="/leaderboard">
            Leaderboard
          </Link>
        ) : null}
        <Link className="btn secondary" to="/app/chat">
          Open chat
        </Link>
        <Link className="btn ghost" to="/docs">
          Docs
        </Link>
        {stats?.tokenLive === false ? null : (
          <Link className="btn secondary" to="/app/stake">
            Stake
          </Link>
        )}
      </div>

      {/* Credit marketplace: sell what you will not use, or buy below face value (pages/Market.tsx). */}
      <div className="row between promo-row" style={{ flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 2, maxWidth: '68ch' }}>
          <span className="eyebrow">Credit market</span>
          <span className="small" style={{ color: 'var(--fg-2)' }}>
            Sell credits you will not use at a discount, or buy them below face value. Mesh keeps {pctFromBps(TOKENOMICS.marketplace.feeBps)} of the price, half of it back to holders.
          </span>
        </div>
        <Link className="btn secondary" to="/app/market">
          Open market
        </Link>
      </div>

      <div className="stack sm">
        <div className="row between">
          <span className="eyebrow">Ledger · last {rows.length || 20}</span>
          <span className="small muted">
            Holders ≥ {fmtInt(TOKENOMICS.minHoldTokens)} {TOKENOMICS.ticker} · {TOKENOMICS.holderShareBps / 100}% of fees
          </span>
        </div>
        {loading ? (
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {[0, 1, 2, 3].map((i) => (
                  <tr key={i}>
                    <td>
                      <Skeleton w="8ch" />
                    </td>
                    <td>
                      <Skeleton w="10ch" />
                    </td>
                    <td>
                      <Skeleton w="24ch" />
                    </td>
                    <td className="num">
                      <Skeleton w="7ch" />
                    </td>
                    <td className="num">
                      <Skeleton w="7ch" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No credits yet">
            Credits arrive at the top of the hour for wallets holding at least {fmtInt(TOKENOMICS.minHoldTokens)} {TOKENOMICS.ticker}
            . Nothing to claim.
            {directOn ? (
              <>
                {' '}
                Holding nothing? <Link to="/app/market">Buy credits at face value</Link>.
              </>
            ) : null}
          </Empty>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  <th>Ref</th>
                  <th className="num">Amount</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="date" title={new Date(r.created_at * 1000).toISOString()}>
                      {fmtTime(r.created_at)}
                    </td>
                    <td>{kindLabel(r.kind)}</td>
                    <td className="mono">{r.ref ?? '—'}</td>
                    <td className={`num ${r.deltaUsd > 0 ? 'pos' : r.deltaUsd < 0 ? 'neg' : ''}`}>{fmtSignedUsd(r.deltaUsd, 3)}</td>
                    <td className="num">{fmtUsd(r.balanceUsd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
