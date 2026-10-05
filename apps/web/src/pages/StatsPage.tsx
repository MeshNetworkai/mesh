import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PairedColumns, ShareColumns } from '../components/MiniChart';
import { Sparkline } from '../components/Sparkline';
import { Empty, Notice, Skeleton, Tile } from '../components/ui';
import { TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { fmtAgo, fmtCost, fmtDate, fmtDateTime, fmtInt, fmtUsd } from '../lib/format';
import { useAsync, useEpochs, useNodes, useStats } from '../lib/hooks';
import { fmtDiscount } from '../lib/marketMath';
import type { PeriodTotals } from '../lib/types';

/**
 * /stats: every public figure on one page. Live network (GET /stats, /nodes), the epoch history
 * (GET /epochs), then the treasury report (GET /report) with its ledger, the credit marketplace and the
 * usage-revenue share. Anchors: #live, #epochs, #report, #treasury. Replaces /numbers, /app/stats and /report.
 */

const EPOCH_ROWS = 24;
const T = TOKENOMICS;
const epochMin = T.epochSeconds / 60;

function pct(n: number) {
  return `${Math.round(n * 10) / 10}%`;
}

/** Jump to the hash once the sections exist (React Router does not scroll to anchors on its own). */
function useHashScroll() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) window.requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [hash]);
}

function SectionHead({ id, title, aside }: { id: string; title: string; aside?: string }) {
  return (
    <div className="row between num-head">
      <h2 className="display d-s" id={`${id}-h`}>
        {title}
      </h2>
      {aside ? <span className="small muted num">{aside}</span> : null}
    </div>
  );
}

export function StatsPage() {
  useHashScroll();
  const st = useStats();
  const epochs = useEpochs(EPOCH_ROWS);
  const nodes = useNodes();
  const rep = useAsync(api.getReport, [], 60_000);

  const s = st.data;
  const loading = st.loading && !s;
  const avg = s && s.requestsLast24h > 0 ? s.spendLast24hUsd / s.requestsLast24h : null;
  const nd = nodes.data;
  const modelEntries = nd ? Object.entries(nd.models).sort((a, b) => b[1] - a[1]) : [];
  const chipEntries = nd ? Object.entries(nd.chips).sort((a, b) => b[1] - a[1]) : [];
  const series = s?.series24h ?? [];
  const fees24h = series.reduce((a, p) => a + p.feesUsd, 0);
  const feesThisEpoch = s?.feesThisEpochUsd ?? null;

  const r = rep.data;
  const rloading = rep.loading && !r;
  const weeks = r?.byWeek ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const week = useAsync(open ? () => api.getWeek(open) : null, [open]);
  const labels = weeks.map((w) => w.isoWeek.replace(/^\d{4}-/, ''));
  const windows: Array<[string, PeriodTotals]> = r ? [['Last 7 days', r.last7d], ['Last 30 days', r.last30d], ['All time', r.totals]] : [];
  const tr = r?.totals.treasury;
  const mk = r?.totals.marketplace;
  const us = r?.totals.usageShare;
  const treasuryOut = tr ? -(tr.nodeRewardAccrualUsd + tr.opsUsd + tr.buybackUsd + tr.otherUsd + (tr.guestChatUsd ?? 0)) : null;

  return (
    <div className="wrap tight stats">
      <div className="statement">
        <span className="eyebrow">Stats · {T.name} · public, no wallet needed</span>
        {rloading ? (
          <Skeleton w="18ch" h="1.1em" className="statement-skel" />
        ) : r && r.feesIn > 0 ? (
          <h1 className="display big">
            {fmtUsd(r.feesIn, 0)} in fees became <em>{fmtUsd(r.creditsOut, 0)}</em> of AI credits.
          </h1>
        ) : (
          <h1 className="display big">
            Every fee, <em>on the record.</em>
          </h1>
        )}
        <p className="lede">
          Every {epochMin === 60 ? 'hour' : `${epochMin} minutes`} the trading fee on ${T.ticker} is swept, split {T.holderShareBps / 100}/{T.treasuryShareBps / 100} between holders and the
          treasury, and the holder share becomes inference credits. This page is the ledger behind that sentence
          {r?.lastUpdated ? ` (last change ${fmtAgo(r.lastUpdated)})` : ''}.
        </p>
        <nav className="chips num-jump" aria-label="Sections">
          <a className="chip" href="#live">
            Live
          </a>
          <a className="chip" href="#epochs">
            Epochs
          </a>
          <a className="chip" href="#report">
            Weekly report
          </a>
          <a className="chip" href="#treasury">
            Treasury, market, usage share
          </a>
        </nav>
      </div>

      {/* ---------- live ---------- */}
      <section id="live" aria-labelledby="live-h" className="num-sec">
        <SectionHead id="live" title="Live" aside={s ? `$${s.token.ticker} · ${s.token.chain} · upstream ${s.upstream}` : undefined} />
        {st.error && !s ? <Notice kind="bad">Could not load stats: {st.error}</Notice> : null}
        <div className="tiles">
          <Tile label="Fees all time" loading={loading} value={fmtUsd(s?.totalFeesUsd ?? null)} delta={`${T.tradeFeeBps / 100}% per trade`} />
          <Tile label="Credits distributed" loading={loading} value={fmtUsd(s?.creditsDistributedUsd ?? null)} delta={`${T.holderShareBps / 100}% of fees to holders`} deltaKind="up" />
          <Tile label="Credits used" loading={loading} value={fmtUsd(s?.creditsUsedUsd ?? null)} delta={s ? `${fmtInt(s.requestsLast24h)} requests · 24h` : '—'} />
          <Tile label="Epochs run" loading={loading} value={fmtInt(s?.epochsRun ?? null)} delta={`every ${epochMin} min`} />
        </div>
        <div className="tiles">
          <Tile label="Spend · 24h" loading={loading} value={fmtUsd(s?.spendLast24hUsd ?? null)} delta={avg !== null ? `${fmtCost(avg)} avg / reply` : '—'} />
          <Tile label="Eligible holders" loading={loading} value={fmtInt(s?.holdersEligibleLastEpoch ?? null)} delta={`≥ ${fmtInt(T.minHoldTokens)} ${T.ticker}`} />
          <Tile
            label="Nodes online"
            loading={loading}
            value={fmtInt(s?.nodesOnline ?? null)}
            delta={nd && nd.online ? `${modelEntries.length} models · ${s ? s.servedByNetworkPercent : 0}% served by network` : 'heartbeat ≤ 90 s'}
          />
          <Tile
            label={feesThisEpoch !== null ? 'Fees this epoch' : 'Fees last epoch'}
            loading={loading}
            value={feesThisEpoch !== null ? fmtUsd(feesThisEpoch) : s?.lastEpoch ? fmtUsd(s.lastEpoch.feesUsd) : '—'}
            delta={
              feesThisEpoch !== null
                ? s?.lastEpoch
                  ? `${fmtUsd(s.lastEpoch.feesUsd)} last epoch · ${s.lastEpoch.status}`
                  : 'accruing'
                : s?.lastEpoch
                  ? `${s.lastEpoch.status} · ${fmtDateTime(s.lastEpoch.epochStart)}`
                  : 'none yet'
            }
          />
        </div>
        <div>
          <div className="row between" style={{ marginBottom: 8 }}>
            <span className="eyebrow">Fees · last 24h · USD</span>
            {series.length ? <span className="eyebrow">{fmtUsd(fees24h)} total</span> : null}
          </div>
          {loading ? (
            <Skeleton w="100%" h="72px" />
          ) : series.length > 1 ? (
            <Sparkline points={series} label="Hourly fees over the last 24 hours" />
          ) : (
            <div className="empty" style={{ padding: 20 }}>
              <span className="small">No fees recorded in the last 24 hours.</span>
            </div>
          )}
        </div>
        <div className="stack sm">
          <span className="eyebrow">Nodes</span>
          {nodes.loading && !nd ? (
            <Skeleton w="100%" h="80px" />
          ) : nodes.error && !nd ? (
            <Notice kind="bad">Could not load nodes: {nodes.error}</Notice>
          ) : !nd || nd.total === 0 ? (
            <Empty title="No nodes registered">Requests are served by the configured upstream until the first Mac links.</Empty>
          ) : (
            <>
              <div className="row">
                <span className="pill">
                  <span className="dot dot-live" />
                  {nd.online} online
                </span>
                <span className="pill off">
                  <span className="dot" />
                  {nd.total - nd.online} offline
                </span>
                <span className="pill sm">{nd.busy} busy · {nd.idle} idle</span>
                <span className="pill sm">{fmtInt(nd.totalRamGb)} GB RAM</span>
                {chipEntries.slice(0, 6).map(([chip, n]) => (
                  <span key={chip} className="pill sm num">
                    {chip} · {n}
                  </span>
                ))}
              </div>
              {modelEntries.length ? (
                <div className="row" aria-label="Models offered by online nodes">
                  {modelEntries.slice(0, 12).map(([m, n]) => (
                    <span key={m} className="pill sm off">
                      {m} <span className="num">· {fmtInt(n)}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="small muted">Public summary only: node URLs and wallets are never exposed. A node is offline after {nd.offlineAfterSec}s without a heartbeat.</p>
            </>
          )}
        </div>
      </section>

      {/* ---------- epochs ---------- */}
      <section id="epochs" aria-labelledby="epochs-h" className="num-sec">
        <SectionHead id="epochs" title="Epochs" aside={s ? `${fmtInt(s.epochsRun)} run · every ${epochMin} min` : undefined} />
        {epochs.loading && !epochs.data ? (
          <Skeleton w="100%" h="120px" />
        ) : epochs.error && !epochs.data ? (
          <Notice kind="bad">Could not load epochs: {epochs.error}</Notice>
        ) : epochs.data && epochs.data.length ? (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th>Status</th>
                  <th className="num">Eligible</th>
                  <th className="num">Fees</th>
                  <th className="num">To holders</th>
                </tr>
              </thead>
              <tbody>
                {epochs.data.map((e) => (
                  <tr key={e.epochStart} style={e.status === 'empty' ? { opacity: 0.6 } : undefined}>
                    <td className="date">{fmtDateTime(e.epochStart)}</td>
                    <td>
                      <span className={`pill sm ${e.status === 'complete' ? '' : 'off'}`}>
                        <span className={`dot ${e.status === 'complete' ? 'dot-live' : ''}`} />
                        {e.status}
                      </span>
                    </td>
                    <td className="num">{fmtInt(e.eligibleHolders)}</td>
                    <td className="num">{fmtUsd(e.feesUsd)}</td>
                    <td className="num pos">{fmtUsd(e.holderPoolUsd ?? (e.feesUsd * T.holderShareBps) / 10_000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s && s.epochsRun > epochs.data.length ? (
              <p className="small muted" style={{ padding: '10px 16px' }}>
                Showing the last {epochs.data.length} of {fmtInt(s.epochsRun)}. The full list is <span className="mono">GET /epochs</span>.
              </p>
            ) : null}
          </div>
        ) : (
          <Empty title="No epochs yet">The first distribution runs at the top of the hour.</Empty>
        )}
      </section>

      {/* ---------- weekly report ---------- */}
      <section id="report" aria-labelledby="report-h" className="num-sec">
        <SectionHead id="report" title="Weekly report" aside={r ? `${fmtInt(r.epochsRun)} epochs · updated ${fmtAgo(r.generatedAt)}` : undefined} />
        {rep.error && !r ? <Notice kind="bad">Could not load the report: {rep.error}</Notice> : null}
        <div className="tiles">
          <Tile label="Fees in" loading={rloading} value={fmtUsd(r?.feesIn ?? null)} delta={r ? `${fmtInt(r.epochsRun)} epochs` : ' '} />
          <Tile label="Credits out" loading={rloading} value={fmtUsd(r?.creditsOut ?? null)} delta={r ? `${fmtUsd(r.totals.creditsUsedUsd)} spent so far` : ' '} deltaKind="up" />
          <Tile label="Node rewards" loading={rloading} value={fmtUsd(r?.nodeRewards ?? null, 2)} delta={r ? `${pct(r.servedByNetworkPercent)} served by Mesh nodes` : ' '} />
          <Tile label="Treasury balance" loading={rloading} value={fmtUsd(r?.treasuryBalanceUsd ?? null)} delta={tr && treasuryOut !== null ? `${fmtUsd(tr.feeShareUsd + (tr.marketFeeUsd ?? 0))} in · ${fmtUsd(treasuryOut)} out` : ' '} />
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

        {rloading ? (
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
          {rloading ? (
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
                          {w.current ? (
                            <span className="pill sm" style={{ marginLeft: 8 }}>
                              now
                            </span>
                          ) : null}
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
      </section>

      {/* ---------- treasury, marketplace, usage share ---------- */}
      <section id="treasury" aria-labelledby="treasury-h" className="num-sec">
        <SectionHead id="treasury" title="Treasury, marketplace and usage share" aside="all time, from the ledgers" />
        <div className="panels three">
          <div className="panel">
            <span className="eyebrow">Treasury ledger</span>
            {rloading || !tr ? (
              <Skeleton w="100%" h="160px" />
            ) : (
              <div className="kv ledger">
                <span>Fee share in</span>
                <b className="pos">{fmtUsd(tr.feeShareUsd)}</b>
                <span>Marketplace fees in</span>
                <b className="pos">{fmtUsd(tr.marketFeeUsd ?? 0)}</b>
                <span>Node rewards accrued</span>
                <b>{fmtUsd(tr.nodeRewardAccrualUsd)}</b>
                <span>Guest chat</span>
                <b>{fmtUsd(tr.guestChatUsd ?? 0)}</b>
                <span>Buybacks</span>
                <b>{fmtUsd(tr.buybackUsd)}</b>
                <span>Ops</span>
                <b>{fmtUsd(tr.opsUsd)}</b>
                <span>Other</span>
                <b>{fmtUsd(tr.otherUsd)}</b>
                <span className="total">Balance</span>
                <b className="total">{fmtUsd(tr.balanceUsd)}</b>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="row between">
              <span className="eyebrow">Credit marketplace</span>
              {mk && mk.bestDiscountBps !== null ? <span className="pill sm">best {fmtDiscount(mk.bestDiscountBps)} off</span> : null}
            </div>
            {rloading ? (
              <Skeleton w="100%" h="160px" />
            ) : mk ? (
              <div className="kv ledger">
                <span>Listed, face value</span>
                <b>{fmtUsd(mk.listed)}</b>
                <span>Changed hands</span>
                <b>{fmtUsd(mk.filled)}</b>
                <span>Buyers paid</span>
                <b>{fmtUsd(mk.paid)}</b>
                <span>Fills</span>
                <b>{fmtInt(mk.fills)}</b>
                <span>Fees to holders</span>
                <b className="pos">{fmtUsd(mk.feesToHolders)}</b>
                <span>Fees to treasury</span>
                <b>{fmtUsd(mk.feesToTreasury)}</b>
                <span className="total">On the book now</span>
                <b className="total">
                  {fmtUsd(mk.openDepth, 0)} · {fmtInt(mk.openListings)} listing{mk.openListings === 1 ? '' : 's'}
                </b>
              </div>
            ) : (
              <p className="small muted">The gateway did not report marketplace totals.</p>
            )}
          </div>
          <div className="panel">
            <div className="row between">
              <span className="eyebrow">Usage-revenue share</span>
              {us ? <span className={`pill sm ${us.enabled ? '' : 'off'}`}>{us.enabled ? 'on' : 'off'}</span> : null}
            </div>
            {rloading ? (
              <Skeleton w="100%" h="160px" />
            ) : us ? (
              <>
                <div className="kv ledger">
                  <span>Paid requests counted</span>
                  <b>{fmtInt(us.requests)}</b>
                  <span>Margin</span>
                  <b>{fmtUsd(us.marginUsd)}</b>
                  <span>To holders · {us.holderBps / 100}%</span>
                  <b className="pos">{fmtUsd(us.toHoldersUsd)}</b>
                  <span>To treasury · {us.treasuryBps / 100}%</span>
                  <b>{fmtUsd(us.toTreasuryUsd)}</b>
                  <span>From network requests</span>
                  <b>{fmtUsd(us.bySource.network.toHoldersUsd)}</b>
                  <span>From upstream requests</span>
                  <b>{fmtUsd(us.bySource.upstream.toHoldersUsd)}</b>
                  <span className="total">Marketplace fee share{us.bySource.marketplaceFee.counted ? '' : ' (not counted)'}</span>
                  <b className="total">{fmtUsd(us.bySource.marketplaceFee.toHoldersUsd)}</b>
                </div>
                {!us.enabled ? (
                  <p className="small muted">
                    Built and audited, switched off: nothing from request margins has been paid to holders yet. The marketplace fee share above is paid regardless.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="small muted">The gateway did not report usage-share totals.</p>
            )}
          </div>
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
            {r?.holdingAge.enabled ? ` Holding-age weighting is on: a wallet's share grows from ×${r.holdingAge.minMultiplier} to ×${r.holdingAge.maxMultiplier} over ${r.holdingAge.maxDays} days of continuous holding.` : ''}{' '}
            Raw data: <span className="mono">GET /stats</span>, <span className="mono">GET /epochs</span>, <span className="mono">GET /report</span>.
          </div>
        </div>
      </section>
    </div>
  );
}
