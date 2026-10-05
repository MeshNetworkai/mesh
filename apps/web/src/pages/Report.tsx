import { useState } from 'react';
import { PairedColumns, ShareColumns } from '../components/MiniChart';
import { Empty, Notice, Skeleton, Tile } from '../components/ui';
import { TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { fmtAgo, fmtCost, fmtDate, fmtInt, fmtUsd } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { PeriodTotals } from '../lib/types';

const useReport = () => useAsync(api.getReport, [], 60_000);

function pct(n: number) {
  return `${Math.round(n * 10) / 10}%`;
}

/** Public treasury report: where the fees went, week by week. No wallet needed. */
export function ReportPage() {
  const rep = useReport();
  const r = rep.data;
  const loading = rep.loading && !r;
  const weeks = r?.byWeek ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const week = useAsync(open ? () => api.getWeek(open) : null, [open]);
  const labels = weeks.map((w) => w.isoWeek.replace(/^\d{4}-/, ''));
  const windows: Array<[string, PeriodTotals]> = r ? [['Last 7 days', r.last7d], ['Last 30 days', r.last30d], ['All time', r.totals]] : [];

  return (
    <div className="wrap tight">
      <div className="statement">
        <span className="eyebrow">Treasury report · {TOKENOMICS.name} · public</span>
        {loading ? (
          <Skeleton w="18ch" h="1.1em" className="statement-skel" />
        ) : r ? (
          <h1 className="display big">
            {fmtUsd(r.feesIn, 0)} in fees became <em>{fmtUsd(r.creditsOut, 0)}</em> of AI credits.
          </h1>
        ) : (
          <h1 className="display big">No fees collected yet.</h1>
        )}
        <p className="lede">
          Every hour, the trading fee on ${TOKENOMICS.ticker} is swept, split {TOKENOMICS.holderShareBps / 100}/{TOKENOMICS.treasuryShareBps / 100} between holders and the treasury, and the holder half is
          minted as inference credits. This page is the ledger behind that sentence, updated every epoch
          {r?.lastUpdated ? ` (last ${fmtAgo(r.lastUpdated)})` : ''}.
        </p>
      </div>
      {rep.error && !r ? <Notice kind="bad">Could not load the report: {rep.error}</Notice> : null}

      <div className="tiles">
        <Tile label="Fees in" loading={loading} value={fmtUsd(r?.feesIn ?? null)} delta={r ? `${fmtInt(r.epochsRun)} epochs` : ' '} />
        <Tile label="Credits out" loading={loading} value={fmtUsd(r?.creditsOut ?? null)} delta={r ? `${fmtUsd(r.totals.creditsUsedUsd)} spent so far` : ' '} deltaKind="up" />
        <Tile label="Node rewards" loading={loading} value={fmtUsd(r?.nodeRewards ?? null, 2)} delta={r ? `${pct(r.servedByNetworkPercent)} served by Mesh nodes` : ' '} />
        <Tile
          label="Treasury balance"
          loading={loading}
          value={fmtUsd(r?.treasuryBalanceUsd ?? null)}
          delta={r ? `${fmtUsd(r.totals.treasury.feeShareUsd)} in · ${fmtUsd(-r.totals.treasury.nodeRewardAccrualUsd - r.totals.treasury.opsUsd - r.totals.treasury.buybackUsd - r.totals.treasury.otherUsd)} out` : ' '}
        />
      </div>

      {r ? (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Window</th>
                <th className="num">Fees in</th>
                <th className="num">Credits out</th>
                <th className="num">Credits used</th>
                <th className="num">Node rewards</th>
                <th className="num">Requests</th>
                <th className="num">By nodes</th>
              </tr>
            </thead>
            <tbody>
              {windows.map(([label, p]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{fmtUsd(p.feesInUsd)}</td>
                  <td className="num pos">{fmtUsd(p.creditsOutUsd)}</td>
                  <td className="num">{fmtUsd(p.creditsUsedUsd)}</td>
                  <td className="num">{fmtCost(p.nodeRewardsUsd)}</td>
                  <td className="num">{fmtInt(p.requests)}</td>
                  <td className="num">{pct(p.servedByNetworkPercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {loading ? (
        <div className="charts">
          <Skeleton w="100%" h="220px" />
          <Skeleton w="100%" h="220px" />
        </div>
      ) : weeks.length ? (
        <div className="charts">
          <PairedColumns
            title="Fees in vs credits out · per week · USD"
            categories={labels}
            series={[
              { label: 'Fees in', values: weeks.map((w) => w.feesInUsd) },
              { label: 'Credits out', values: weeks.map((w) => w.creditsOutUsd) },
            ]}
            format={(v) => fmtUsd(v, 0)}
          />
          <ShareColumns
            title="Who served the requests · per week"
            categories={labels}
            a={{ label: 'Mesh nodes', values: weeks.map((w) => w.servedByNetwork) }}
            b={{ label: 'OpenRouter', values: weeks.map((w) => w.servedByOpenRouter) }}
          />
        </div>
      ) : null}

      <div className="stack sm">
        <div className="row between">
          <span className="eyebrow">By ISO week · UTC</span>
          <span className="small muted">Click a week for its days and epochs</span>
        </div>
        {loading ? (
          <Skeleton w="100%" h="200px" />
        ) : weeks.length ? (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Week</th>
                  <th>From</th>
                  <th className="num">Epochs</th>
                  <th className="num">Fees in</th>
                  <th className="num">Credits out</th>
                  <th className="num">Treasury</th>
                  <th className="num">Node rewards</th>
                  <th className="num">Requests</th>
                  <th className="num">By nodes</th>
                </tr>
              </thead>
              <tbody>
                {[...weeks].reverse().map((w) => (
                  <tr key={w.isoWeek} style={w.epochs === 0 ? { opacity: 0.55 } : undefined}>
                    <td className="date">
                      <button className="linkbtn" style={{ fontSize: 14, color: 'inherit' }} onClick={() => setOpen(open === w.isoWeek ? null : w.isoWeek)} aria-expanded={open === w.isoWeek}>
                        {w.isoWeek}
                        {w.current ? <span className="pill sm" style={{ marginLeft: 8 }}>now</span> : null}
                      </button>
                    </td>
                    <td className="date">{fmtDate(w.start)}</td>
                    <td className="num">{fmtInt(w.epochs)}</td>
                    <td className="num">{fmtUsd(w.feesInUsd)}</td>
                    <td className="num pos">{fmtUsd(w.creditsOutUsd)}</td>
                    <td className="num">{fmtUsd(w.treasuryInUsd)}</td>
                    <td className="num">{fmtCost(w.nodeRewardsUsd)}</td>
                    <td className="num">{fmtInt(w.requests)}</td>
                    <td className="num">{pct(w.servedByNetworkPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No epochs yet">The first distribution runs at the top of the hour.</Empty>
        )}

        {open ? (
          <div className="panel">
            <div className="row between">
              <span className="eyebrow">Week {open}</span>
              <div className="row">
                {week.data ? (
                  <>
                    <button className="btn ghost sm" onClick={() => setOpen(week.data!.previous)}>
                      ← {week.data.previous}
                    </button>
                    {week.data.next ? (
                      <button className="btn ghost sm" onClick={() => setOpen(week.data!.next)}>
                        {week.data.next} →
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button className="btn ghost sm" onClick={() => setOpen(null)}>
                  Close
                </button>
              </div>
            </div>
            {week.loading && !week.data ? (
              <Skeleton w="100%" h="120px" />
            ) : week.error ? (
              <Notice kind="bad">Could not load that week: {week.error}</Notice>
            ) : week.data ? (
              <>
                <div className="tblwrap">
                  <table className="tbl small">
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th className="num">Epochs</th>
                        <th className="num">Fees in</th>
                        <th className="num">Credits out</th>
                        <th className="num">Credits used</th>
                        <th className="num">Requests</th>
                        <th className="num">By nodes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {week.data.days.map((d) => (
                        <tr key={d.day} style={d.epochs === 0 ? { opacity: 0.55 } : undefined}>
                          <td className="date">{d.day}</td>
                          <td className="num">{fmtInt(d.epochs)}</td>
                          <td className="num">{fmtUsd(d.feesInUsd)}</td>
                          <td className="num pos">{fmtUsd(d.creditsOutUsd)}</td>
                          <td className="num">{fmtUsd(d.creditsUsedUsd)}</td>
                          <td className="num">{fmtInt(d.requests)}</td>
                          <td className="num">{pct(d.servedByNetworkPercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted">
                  {fmtInt(week.data.epochDetails.length)} epochs recorded this week · {fmtInt(week.data.completeEpochs)} complete ·{' '}
                  <span className="mono">GET /report/weekly/{open}</span>
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="footnote" id="method">
        <div>
          <span className="eyebrow">Method · credits</span>
          {r?.method.credits ?? 'Credits are a share of fees already collected, not a promise.'}
        </div>
        <div>
          <span className="eyebrow">Method · attribution</span>
          {r?.method.attribution ?? 'Fees are booked to the ISO week of the epoch that earned them.'}
        </div>
        <div>
          <span className="eyebrow">Method · treasury</span>
          {r?.method.treasury ?? 'Treasury balance = fee share in − node rewards − buybacks − ops.'}
        </div>
        <div>
          <span className="eyebrow">Method · network</span>
          {r?.method.network ?? 'Node share = requests served by Mesh nodes ÷ all requests.'}
          {r?.holdingAge.enabled ? ` Holding-age weighting is on: a wallet's share grows from ×${r.holdingAge.minMultiplier} to ×${r.holdingAge.maxMultiplier} over ${r.holdingAge.maxDays} days of continuous holding.` : ''}
          {' '}Raw data: <span className="mono">GET /report</span>.
        </div>
      </div>
    </div>
  );
}
