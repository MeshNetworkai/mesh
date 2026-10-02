import { Sparkline } from '../components/Sparkline';
import { Empty, Notice, Skeleton, Tile } from '../components/ui';
import { TOKENOMICS } from '../config';
import { fmtCost, fmtDateTime, fmtInt, fmtUsd } from '../lib/format';
import { useEpochs, useNodes, useStats } from '../lib/hooks';

const EPOCH_ROWS = 48;

export function StatsPage() {
  const st = useStats();
  const epochs = useEpochs(EPOCH_ROWS);
  const nodes = useNodes();
  const s = st.data;
  const loading = st.loading && !s;
  const avg = s && s.requestsLast24h > 0 ? s.spendLast24hUsd / s.requestsLast24h : null;
  const nd = nodes.data;
  const modelEntries = nd ? Object.entries(nd.models).sort((a, b) => b[1] - a[1]) : [];
  const chipEntries = nd ? Object.entries(nd.chips).sort((a, b) => b[1] - a[1]) : [];
  const series = s?.series24h ?? [];
  const fees24h = series.reduce((a, p) => a + p.feesUsd, 0);
  const feesThisEpoch = s?.feesThisEpochUsd ?? null;

  return (
    <>
      <div className="row between">
        <span className="display d-s">Network</span>
        <span className="small muted">
          {s ? `${s.token.name} · $${s.token.ticker} · ${s.token.chain} · upstream ${s.upstream}` : ''}
        </span>
      </div>
      {st.error && !s ? <Notice kind="bad">Could not load stats: {st.error}</Notice> : null}

      <div className="tiles">
        <Tile label="Fees all time" loading={loading} value={fmtUsd(s?.totalFeesUsd ?? null)} delta={`${TOKENOMICS.tradeFeeBps / 100}% per trade`} />
        <Tile
          label="Credits distributed"
          loading={loading}
          value={fmtUsd(s?.creditsDistributedUsd ?? null)}
          delta={`${TOKENOMICS.holderShareBps / 100}% of fees to holders`}
          deltaKind="up"
        />
        <Tile label="Credits used" loading={loading} value={fmtUsd(s?.creditsUsedUsd ?? null)} delta={s ? `${fmtInt(s.requestsLast24h)} requests · 24h` : '—'} />
        <Tile label="Epochs run" loading={loading} value={fmtInt(s?.epochsRun ?? null)} delta={`every ${TOKENOMICS.epochSeconds / 60} min`} />
      </div>

      <div className="tiles">
        <Tile label="Spend · 24h" loading={loading} value={fmtUsd(s?.spendLast24hUsd ?? null)} delta={avg !== null ? `${fmtCost(avg)} avg / reply` : '—'} />
        <Tile label="Eligible holders" loading={loading} value={fmtInt(s?.holdersEligibleLastEpoch ?? null)} delta={`≥ ${fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker}`} />
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
        <div className="row between">
          <span className="eyebrow">Epochs</span>
          {s ? (
            <span className="small muted">
              {fmtInt(s.epochsRun)} run · every {TOKENOMICS.epochSeconds / 60} min
            </span>
          ) : null}
        </div>
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
                    <td className="mono">{fmtDateTime(e.epochStart)}</td>
                    <td>
                      <span className={`pill sm ${e.status === 'complete' ? '' : 'off'}`}>
                        <span className={`dot ${e.status === 'complete' ? 'dot-live' : ''}`} />
                        {e.status}
                      </span>
                    </td>
                    <td className="num">{fmtInt(e.eligibleHolders)}</td>
                    <td className="num">{fmtUsd(e.feesUsd)}</td>
                    <td className="num pos">{fmtUsd(e.holderPoolUsd ?? (e.feesUsd * TOKENOMICS.holderShareBps) / 10_000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s && s.epochsRun > epochs.data.length ? (
              <p className="small muted" style={{ padding: '10px 16px' }}>
                Showing the last {epochs.data.length} of {fmtInt(s.epochsRun)}.
              </p>
            ) : null}
          </div>
        ) : (
          <Empty title="No epochs yet">The first distribution runs at the top of the hour.</Empty>
        )}
      </div>

      <div className="stack sm">
        <span className="eyebrow">Nodes</span>
        {nodes.loading && !nd ? (
          <Skeleton w="100%" h="80px" />
        ) : nodes.error && !nd ? (
          <Notice kind="bad">Could not load nodes: {nodes.error}</Notice>
        ) : !nd || nd.total === 0 ? (
          <Empty title="No nodes registered">The P2P network opens in week 2. Requests are served by the configured upstream until then.</Empty>
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
            </div>
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Model offered</th>
                    <th className="num">Nodes</th>
                  </tr>
                </thead>
                <tbody>
                  {modelEntries.length === 0 ? (
                    <tr>
                      <td className="muted" colSpan={2}>
                        No models advertised by online nodes.
                      </td>
                    </tr>
                  ) : (
                    modelEntries.slice(0, 12).map(([m, n]) => (
                      <tr key={m}>
                        <td className="mono">{m}</td>
                        <td className="num">{fmtInt(n)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {chipEntries.length ? (
              <div className="row">
                {chipEntries.slice(0, 8).map(([chip, n]) => (
                  <span key={chip} className="pill mono sm">
                    {chip} · {n}
                  </span>
                ))}
              </div>
            ) : null}
            <p className="small muted">Public summary only: node URLs and wallets are never exposed. A node is offline after {nd.offlineAfterSec}s without a heartbeat.</p>
          </>
        )}
      </div>
    </>
  );
}
