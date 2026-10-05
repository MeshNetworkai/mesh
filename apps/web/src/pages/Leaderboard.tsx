import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, Notice, Skeleton } from '../components/ui';
import { TOKENOMICS } from '../config';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtCompact, fmtInt, fmtUsd } from '../lib/format';
import { useLeaderboard } from '../lib/hooks';
import type { Board, Leaderboard as LeaderboardData, LeaderboardRow } from '../lib/types';

const TABS: Array<{ id: Board; label: string; blurb: string }> = [
  { id: 'holders', label: 'Holders', blurb: 'Credits earned from hourly distributions, all time.' },
  { id: 'nodes', label: 'Nodes', blurb: 'Tokens served by a wallet\'s Macs, all time.' },
  { id: 'points', label: 'Points', blurb: `Pre-launch points. They convert to ${TOKENOMICS.ticker} at TGE.` },
  { id: 'referrers', label: 'Referrers', blurb: 'Wallets that claimed this wallet\'s code.' },
];

const isBoard = (v: string | null): v is Board => v === 'holders' || v === 'nodes' || v === 'points' || v === 'referrers';

/** Points keep thousandths server-side; the board shows whole points. */
export function fmtPoints(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtBoardValue(board: Board, v: number): string {
  if (board === 'holders') return fmtUsd(v, 2);
  if (board === 'nodes') return fmtCompact(v);
  if (board === 'points') return fmtPoints(v);
  return fmtInt(v);
}

export function fmtSecondary(board: Board, v: number | null): string {
  if (v === null) return '';
  if (board === 'nodes') return `${fmtInt(v)} jobs`;
  if (board === 'referrers') return `${fmtPoints(v)} pts`;
  return '';
}

function RankRows({ board, data, meWallet }: { board: Board; data: LeaderboardData; meWallet: string | null }) {
  const mine = (r: LeaderboardRow) => Boolean(data.me && data.me.rank === r.rank);
  return (
    <div className="tblwrap">
      <table className="tbl lb">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Wallet</th>
            <th className="num">{data.label}</th>
            {data.secondaryLabel ? <th className="num">{data.secondaryLabel}</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.rank} className={mine(r) ? 'me' : undefined} aria-current={mine(r) ? 'true' : undefined}>
              <td className="num">{r.rank}</td>
              <td className="mono" title={mine(r) && meWallet ? meWallet : undefined}>
                {r.wallet}
                {mine(r) ? <span className="pill sm you">you</span> : null}
              </td>
              <td className="num">{fmtBoardValue(board, r.value)}</td>
              {data.secondaryLabel ? <td className="num muted">{fmtSecondary(board, r.secondary)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('board');
  const [board, setBoard] = useState<Board>(isBoard(initial) ? initial : 'points');
  useEffect(() => {
    if (params.get('board') !== board) setParams({ board }, { replace: true });
  }, [board, params, setParams]);
  const { session, openModal } = useAuth();
  const lb = useLeaderboard(board);
  const data = lb.data;
  const loading = lb.loading && !data;
  const tab = TABS.find((t) => t.id === board)!;
  const me = data?.me ?? null;
  const onBoard = me && me.rank !== null && me.rank <= (data?.rows.length ?? 0);

  return (
    <div className="wrap tight">
      <div className="app">
        <div className="row between">
          <div className="stack sm">
            <span className="display d-s">Leaderboard</span>
            <span className="small muted">{tab.blurb}</span>
          </div>
          <span className="small muted">{data ? `top ${data.rows.length} of ${fmtInt(data.total)} · updated ${fmtAgo(data.cachedAt)}` : ''}</span>
        </div>

        <div className="tabs" role="tablist" aria-label="Leaderboards">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={board === t.id} className={board === t.id ? 'on' : ''} onClick={() => setBoard(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {session ? (
          <div className="lb-me" role="status">
            {!data ? (
              <Skeleton w="30ch" />
            ) : me && me.rank !== null ? (
              <>
                <span className="eyebrow">Your rank</span>
                <span className="display d-s">
                  #{fmtInt(me.rank)} <span className="muted">of {fmtInt(data.total)}</span>
                </span>
                <span className="small muted">
                  {fmtBoardValue(board, me.value)}
                  {me.secondary !== null ? ` · ${fmtSecondary(board, me.secondary)}` : ''}
                  {onBoard ? '' : ' · below the top 100'}
                </span>
              </>
            ) : (
              <>
                <span className="eyebrow">Your rank</span>
                <span className="small muted">
                  Not on this board yet. <Link to="/app">See how to earn</Link>.
                </span>
              </>
            )}
          </div>
        ) : (
          <div className="lb-me" role="note">
            <span className="small muted">Connect a wallet to see your own rank. Wallets are shortened for everyone else.</span>
            <button className="btn secondary sm" onClick={openModal}>
              Connect wallet
            </button>
          </div>
        )}

        {lb.error && !data ? <Notice kind="bad">Could not load the leaderboard: {lb.error}</Notice> : null}

        {loading ? (
          <div className="tblwrap">
            <table className="tbl lb">
              <tbody>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <tr key={i}>
                    <td className="num">
                      <Skeleton w="2ch" />
                    </td>
                    <td>
                      <Skeleton w="12ch" />
                    </td>
                    <td className="num">
                      <Skeleton w="8ch" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data && data.rows.length ? (
          <RankRows board={board} data={data} meWallet={session?.wallet ?? null} />
        ) : data ? (
          <Empty title="Nobody on this board yet">
            {board === 'nodes' ? 'Serve the first job from a Mac and you are #1.' : board === 'referrers' ? 'Share your code from the dashboard to start.' : 'Hold through the next epoch to appear here.'}
          </Empty>
        ) : null}

        <p className="small muted">
          Pre-launch points convert to {TOKENOMICS.ticker} at TGE at a ratio set then; points are not a promise of any amount of {TOKENOMICS.ticker}. Daily cap and anti-abuse rules are in{' '}
          <Link to="/docs">the docs</Link>.
        </p>
      </div>
    </div>
  );
}
