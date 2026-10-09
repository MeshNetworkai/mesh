import { Link } from 'react-router-dom';
import { Skeleton } from '../components/ui';
import { FLEET_PUBLIC } from '../content/flags';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { fmtAgo, fmtCompact, fmtInt } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { StatusResponse, StatusState } from '../lib/types';

/**
 * /status — the page you link when someone asks "is it up". One verdict, the components behind it, the
 * last 24 h of errors as a small bar strip, and the fleet as a node explorer. Public, no wallet.
 */
const VERDICT: Record<StatusResponse['overall'], { title: string; tone: StatusState }> = {
  operational: { title: 'All systems operating.', tone: 'ok' },
  degraded: { title: 'Running with a degraded component.', tone: 'degraded' },
  down: { title: 'Something is down.', tone: 'down' },
};

function Dot({ state }: { state: StatusState }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

const STATE_WORD: Record<StatusState, string> = { ok: 'Operational', degraded: 'Degraded', down: 'Down', off: 'Not live yet' };

export function StatusPage() {
  const { data, error, loading } = useAsync(api.getStatus, [], 15_000);
  const verdict = data ? VERDICT[data.overall] : null;
  const maxErr = data ? Math.max(1, ...data.errors24h.map((e) => e.n)) : 1;

  return (
    <div className="wrap tight status">
      <div className="statement">
        <span className="eyebrow">Status · {TOKENOMICS.name} · refreshes every 15 s</span>
        {loading && !data ? (
          <Skeleton w="18ch" h="1.1em" className="statement-skel" />
        ) : data && verdict ? (
          <h1 className={`display big status-title ${verdict.tone}`}>
            <Dot state={verdict.tone} />
            {verdict.title}
          </h1>
        ) : (
          <h1 className="display big status-title down">
            <Dot state="down" />
            The gateway is not reachable.
          </h1>
        )}
        <p className="lede">
          {data
            ? `${fmtCompact(data.requests24h)} requests in the last 24 hours, ${data.errorTotal24h === 0 ? 'no server errors' : `${fmtInt(data.errorTotal24h)} server error${data.errorTotal24h === 1 ? '' : 's'}`}.${FLEET_PUBLIC ? ` ${fmtInt(data.fleetOnline)} Mac${data.fleetOnline === 1 ? '' : 's'} serving right now.` : ''}`
            : error
              ? `Could not load status: ${error}`
              : 'Loading…'}
        </p>
      </div>

      {data ? (
        <>
          <section className="status-components" aria-label="Components">
            {data.components.filter((c) => FLEET_PUBLIC || c.key !== 'network').map((c) => (
              <div className="status-row" key={c.key}>
                <span className="status-row-main">
                  <Dot state={c.state} />
                  <b>{c.label}</b>
                  <span className="muted">{c.detail}</span>
                </span>
                <span className={`status-word ${c.state}`}>{STATE_WORD[c.state]}</span>
              </div>
            ))}
          </section>

          <section aria-label="Errors in the last 24 hours" className="stack sm">
            <div className="row between">
              <span className="eyebrow">Server errors · last 24 h</span>
              <span className="small muted">
                {data.topErrorCodes.length ? data.topErrorCodes.map((t) => `${t.code} ×${t.n}`).join(' · ') : 'none'}
              </span>
            </div>
            <div className="status-bars" role="img" aria-label={`${data.errorTotal24h} errors over 24 hours`}>
              {data.errors24h.map((e) => (
                <span key={e.hour} className="status-bar" title={`${new Date(e.hour * 1000).getHours()}:00 · ${e.n}`}>
                  <i style={{ height: `${e.n ? Math.max(8, Math.round((e.n / maxErr) * 100)) : 4}%` }} className={e.n ? 'hit' : ''} />
                </span>
              ))}
            </div>
            <div className="row between small muted">
              <span>24 h ago</span>
              <span>now</span>
            </div>
          </section>

          {FLEET_PUBLIC ? (
          <section aria-label="Node explorer" className="stack sm">
            <div className="row between">
              <span className="eyebrow">Node explorer</span>
              <span className="small muted">
                {data.fleet.length === 0 ? 'No Macs registered yet' : `${fmtInt(data.fleetOnline)} online of ${fmtInt(data.fleet.length)} · ids as shown under replies`}
              </span>
            </div>
            {data.fleet.length === 0 ? (
              <p className="muted">
                Be the first: <Link to="/app/node">run a node</Link>.
              </p>
            ) : (
              <div className="tblwrap">
                <table className="tbl status-fleet">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Machine</th>
                      <th>Models</th>
                      <th className="num">Uptime · 24h</th>
                      <th className="num">Jobs · 24h</th>
                      <th className="num">Tokens · 24h</th>
                      <th>Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fleet.map((n) => (
                      <tr key={n.id} className={n.state}>
                        <td>
                          <span className="status-node">
                            <Dot state={n.state === 'offline' ? 'off' : 'ok'} />
                            <span className="num">{n.id}…</span>
                          </span>
                        </td>
                        <td>
                          {n.chip ?? 'Unknown'} {n.ramGb ? <span className="muted">· {fmtInt(n.ramGb)} GB</span> : null}
                        </td>
                        <td className="muted">{n.models.join(', ') || '—'}</td>
                        <td className="num">{n.uptimePct24h.toFixed(1)}%</td>
                        <td className="num">{fmtInt(n.jobs24h)}</td>
                        <td className="num">{fmtCompact(n.tokens24h)}</td>
                        <td className="muted">{fmtAgo(n.since)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          ) : null}

          <p className="small muted">
            Raw data: <a href={`${PUBLIC_API_URL}/status`}>/status</a> · <a href={`${PUBLIC_API_URL}/health`}>/health</a> · the ledger is on <Link to="/stats">Stats</Link>.
          </p>
        </>
      ) : null}
    </div>
  );
}
