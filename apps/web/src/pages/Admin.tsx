import { useEffect, useState, type FormEvent } from 'react';
import { Notice, Skeleton, Spinner, Tile } from '../components/ui';
import { MOCK, TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { ApiError, COOKIE_SESSION } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtInt, fmtUsd, shortAddr } from '../lib/format';
import { useAsync, useCopy } from '../lib/hooks';
import { MOCK_ADMIN_TOKEN_HINT } from '../lib/mock';
import type { AdminOverview, ChainCheckReport, ChainField, ChainView, StarterStatus, WaitlistEntry } from '../lib/types';

/**
 * Operator page. The ADMIN_TOKEN is sent once to POST /admin/login, which answers with a 12 h
 * HttpOnly admin cookie; the page itself never holds the token after that (not in state, not in
 * storage). Every call is CSRF-protected and audited by the gateway.
 */
export function AdminPage() {
  // null = checking the cookie, false = signed out, true = admin cookie is live
  const [authed, setAuthed] = useState<boolean | null>(MOCK ? false : null);
  useEffect(() => {
    if (MOCK) return;
    let cancelled = false;
    api
      .adminSession()
      .then(() => !cancelled && setAuthed(true))
      .catch(() => !cancelled && setAuthed(false));
    return () => {
      cancelled = true;
    };
  }, []);
  const signOut = () => {
    setAuthed(false);
    api.adminLogout().catch(() => undefined);
  };
  return (
    <div className="wrap tight">
      <div className="app">
        <div className="row between">
          <span className="display d-s">Operator</span>
          {authed ? (
            <button className="btn ghost sm" onClick={signOut}>
              Sign out
            </button>
          ) : null}
        </div>
        {authed === null ? <Skeleton w="100%" h="120px" /> : authed ? <AdminConsole token={COOKIE_SESSION} onUnauthorized={() => setAuthed(false)} /> : <TokenGate onAuthed={() => setAuthed(true)} />}
      </div>
    </div>
  );
}

function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminLogin(token);
      setValue('');
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel" onSubmit={submit} style={{ maxWidth: 520 }}>
      <span className="eyebrow">Admin token</span>
      <p className="small muted">
        The gateway's <span className="mono">ADMIN_TOKEN</span>. Exchanged once for a 12-hour HttpOnly cookie; the token itself is not kept in the page.
        {MOCK ? ` Mock mode: ${MOCK_ADMIN_TOKEN_HINT}.` : ''}
      </p>
      <div className="keybox">
        <input id="admin-token" className="input mono" type="password" autoComplete="off" placeholder="x-admin-token" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Admin token" />
        <button className="btn primary" type="submit" disabled={!value.trim() || busy}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>
      {error ? <Notice kind="bad">{error}</Notice> : null}
    </form>
  );
}

type ActionState = { busy: boolean; result?: unknown; error?: string | null };

function useAction(onUnauthorized: () => void) {
  const [state, setState] = useState<ActionState>({ busy: false });
  const run = async <T,>(fn: () => Promise<T>, onOk?: (r: T) => void) => {
    setState({ busy: true, error: null });
    try {
      const r = await fn();
      setState({ busy: false, result: r });
      onOk?.(r);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      setState({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  return [state, run] as const;
}

function Result({ s }: { s: ActionState }) {
  if (s.error) return <Notice kind="bad">{s.error}</Notice>;
  if (s.result === undefined) return null;
  return <pre className="result">{JSON.stringify(s.result, null, 1)}</pre>;
}

function AdminConsole({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const ov = useAsync(() => api.adminOverview(token), [token], 30_000);
  const o = ov.data;
  const loading = ov.loading && !o;
  const [epoch, runEpoch] = useAction(onUnauthorized);
  const [fees, runFees] = useAction(onUnauthorized);
  const [starter, runStarter] = useAction(onUnauthorized);
  const [revoke, runRevoke] = useAction(onUnauthorized);
  const [unquarantine, runUnquarantine] = useAction(onUnauthorized);
  const [feeAmount, setFeeAmount] = useState('100');
  const [batch, setBatch] = useState('');
  const [note, setNote] = useState('');
  const [keyId, setKeyId] = useState('');

  if (ov.error && !o) {
    if (ov.error.toLowerCase().includes('admin token') || ov.error.startsWith('401')) {
      onUnauthorized();
      return null;
    }
    return <Notice kind="bad">Could not load the overview: {ov.error}</Notice>;
  }

  const parsedBatch = parseBatch(batch);
  const isMock = o?.upstream === 'mock' || o?.adapter === 'mock';

  return (
    <>
      <div className="row between">
        <div className="row">
          <span className="pill">
            <span className="dot dot-live" /> upstream {o?.upstream ?? '…'}
          </span>
          <span className="pill sm">adapter {o?.adapter ?? '…'}</span>
          <span className="pill sm">{o?.chain ?? '…'}</span>
          {o?.holdingAge.enabled ? (
            <span className="pill sm outline-accent">
              holding age ×{o.holdingAge.minMultiplier}–{o.holdingAge.maxMultiplier} / {o.holdingAge.maxDays}d
            </span>
          ) : (
            <span className="pill sm off">
              <span className="dot" /> holding age off
            </span>
          )}
          {o?.beta?.enabled ? (
            <span className="pill sm outline-accent">
              {o.beta.label.toLowerCase()} · {o.beta.inviteRequired ? 'invite required' : 'open'}
            </span>
          ) : null}
          {o?.verification ? (
            <span className={`pill sm ${o.verification.config.enabled ? '' : 'off'}`}>
              <span className={`dot ${o.verification.config.enabled ? 'dot-live' : ''}`} /> spot checks {o.verification.config.enabled ? `${Math.round(o.verification.config.sampleRate * 100)}%` : 'off'}
            </span>
          ) : null}
        </div>
        <span className="small muted">{o ? `refreshed ${fmtAgo(o.time)}` : ''}</span>
      </div>

      <div className="tiles">
        <Tile label="Fees all time" loading={loading} value={fmtUsd(o?.totals.feesUsd ?? null)} delta={o ? `${fmtInt(o.epochs.length)} recent epochs` : ' '} />
        <Tile label="Credits outstanding" loading={loading} value={fmtUsd(o?.totals.creditsOutstandingUsd ?? null)} delta={o ? `${fmtUsd(o.totals.creditsDistributedUsd)} distributed · ${fmtUsd(o.totals.starterCreditsUsd)} starter` : ' '} />
        <Tile label="Treasury balance" loading={loading} value={fmtUsd(o?.totals.treasuryBalanceUsd ?? null)} delta={o ? `${fmtUsd(o.totals.treasuryUsd)} share · ${fmtUsd(o.totals.nodeRewardsUsd)} node rewards` : ' '} />
        <Tile label="Requests · 24h" loading={loading} value={fmtInt(o?.totals.requests24h ?? null)} delta={o ? `${fmtInt(o.totals.wallets)} wallets · ${fmtInt(o.totals.activeApiKeys)} active keys` : ' '} />
      </div>

      <div className="panels">
        <div className="panel">
          <span className="eyebrow">Epoch</span>
          <p className="hint">
            Runs the last completed window now (idempotent; the cron does this hourly).
            {o?.epochs[0] ? ` Last: ${fmtDateTime(o.epochs[0].epochStart)} · ${o.epochs[0].status} · ${fmtUsd(o.epochs[0].feesUsd)}.` : ''}
          </p>
          <div className="row">
            <button className="btn primary" disabled={epoch.busy} onClick={() => runEpoch(() => api.adminRunEpoch(token), () => ov.reload())}>
              {epoch.busy ? <Spinner /> : null} Run epoch
            </button>
          </div>
          <Result s={epoch} />
        </div>

        {isMock ? (
          <div className="panel">
            <span className="eyebrow">Fake fees · mock only</span>
            <p className="hint">Pushes USD fees into the MockAdapter so the next epoch has something to split.</p>
            <div className="keybox">
              <input className="input num sm" type="number" min="0.01" step="0.01" value={feeAmount} onChange={(e) => setFeeAmount(e.target.value)} aria-label="Fake fees in USD" />
              <button
                className="btn secondary sm"
                disabled={fees.busy || !(Number(feeAmount) > 0)}
                onClick={() => runFees(() => api.adminFakeFees(token, Number(feeAmount)))}
              >
                {fees.busy ? <Spinner /> : null} Add fees
              </button>
            </div>
            <Result s={fees} />
          </div>
        ) : null}

        <div className="panel">
          <span className="eyebrow">Starter credits · batch</span>
          <p className="hint">
            One <span className="mono">wallet,amount</span> per line (USD, max $10,000 each, 500 lines). All or nothing; one audit row.
            {TOKENOMICS.starterCredits.transferable ? '' : ' Starter credit can be spent but not listed on the market.'}
            {TOKENOMICS.creditExpiry.enabled ? ` It lapses after ${TOKENOMICS.creditExpiry.days} days like any other credit.` : ''}
          </p>
          <textarea
            className="input mono"
            rows={4}
            placeholder={'7xKq…9f2A,5\n0x8f…e21c,2.5'}
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            aria-label="Starter credits, wallet,amount per line"
          />
          <div className="keybox">
            <input className="input sm" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Batch note" />
            <button
              className="btn secondary sm"
              disabled={starter.busy || parsedBatch.items.length === 0 || parsedBatch.bad.length > 0}
              onClick={() => runStarter(() => api.adminStarterCredits(token, parsedBatch.items, note.trim() || undefined), () => { setBatch(''); void ov.reload(); })}
            >
              {starter.busy ? <Spinner /> : null} Grant {parsedBatch.items.length ? `${parsedBatch.items.length} · ${fmtUsd(parsedBatch.total)}` : ''}
            </button>
          </div>
          {parsedBatch.bad.length ? <Notice kind="warn">Cannot parse: {parsedBatch.bad.slice(0, 3).join(' · ')}{parsedBatch.bad.length > 3 ? ' …' : ''}</Notice> : null}
          <Result s={starter} />
        </div>

        <StarterPanel token={token} onUnauthorized={onUnauthorized} onChanged={() => void ov.reload()} />

        <div className="panel">
          <span className="eyebrow">Revoke an API key</span>
          <p className="hint">By numeric key id (any wallet). The key stops working immediately; the owner sees it as revoked.</p>
          <div className="keybox">
            <input className="input num sm" type="number" min="1" step="1" placeholder="key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} aria-label="API key id" />
            <button className="btn danger sm" disabled={revoke.busy || !(Number(keyId) > 0)} onClick={() => runRevoke(() => api.adminRevokeKey(token, Number(keyId)), () => ov.reload())}>
              {revoke.busy ? <Spinner /> : null} Revoke
            </button>
          </div>
          <Result s={revoke} />
        </div>
      </div>

      <TokenPanel token={token} onUnauthorized={onUnauthorized} />

      {o?.beta?.enabled ? <BetaPanels token={token} o={o} onUnauthorized={onUnauthorized} onChanged={() => void ov.reload()} /> : null}

      <div className="stack sm">
        <span className="eyebrow">Recent epochs</span>
        {loading ? <Skeleton w="100%" h="120px" /> : o ? <EpochTable o={o} /> : null}
      </div>

      <div className="panels">
        <div className="stack sm">
          <span className="eyebrow">Top holders · by credit balance</span>
          {loading ? (
            <Skeleton w="100%" h="120px" />
          ) : o ? (
            <div className="tblwrap">
              <table className="tbl small">
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th className="num">Balance</th>
                    <th className="num">Earned</th>
                    <th className="num">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {o.topHolders.length === 0 ? (
                    <tr>
                      <td className="muted" colSpan={4}>
                        No credits yet.
                      </td>
                    </tr>
                  ) : (
                    o.topHolders.slice(0, 10).map((h) => (
                      <tr key={h.wallet}>
                        <td className="mono" title={h.wallet}>
                          {shortAddr(h.wallet, 6, 4)}
                        </td>
                        <td className="num">{fmtUsd(h.balanceUsd, 3)}</td>
                        <td className="num pos">{fmtUsd(h.earnedUsd, 3)}</td>
                        <td className="num">{fmtUsd(h.usedUsd, 3)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="stack sm">
          <span className="eyebrow">Nodes</span>
          {loading ? (
            <Skeleton w="100%" h="120px" />
          ) : o ? (
            <div className="tblwrap">
              <table className="tbl small">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Status</th>
                    <th>Chip</th>
                    <th>Wallet</th>
                    <th title="spot checks: ok / suspect / mismatch">Checks</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {o.nodes.length === 0 ? (
                    <tr>
                      <td className="muted" colSpan={6}>
                        No nodes registered.
                      </td>
                    </tr>
                  ) : (
                    o.nodes.slice(0, 12).map((n) => (
                      <tr key={n.nodeId}>
                        <td className="mono">{n.nodeId}</td>
                        <td>
                          {n.quarantined ? (
                            <span className="row" style={{ gap: 6 }}>
                              <span className="pill sm bad" title={n.verification?.quarantineReason ?? 'quarantined'}>
                                <span className="dot" />
                                quarantined
                              </span>
                              <button className="btn ghost sm" disabled={unquarantine.busy} onClick={() => runUnquarantine(() => api.adminClearQuarantine(token, n.nodeId), () => ov.reload())}>
                                Clear
                              </button>
                            </span>
                          ) : (
                            <span className={`pill sm ${n.online ? '' : 'off'}`}>
                              <span className={`dot ${n.online ? 'dot-live' : ''}`} />
                              {n.online ? (n.busy ? 'busy' : 'idle') : 'offline'}
                            </span>
                          )}
                        </td>
                        <td>{n.chip ?? '—'}</td>
                        <td className="mono" title={n.wallet}>
                          {shortAddr(n.wallet, 6, 4)}
                        </td>
                        <td className="mono small">
                          {n.verification ? (
                            <>
                              <span className="pos">{n.verification.ok}</span> / {n.verification.suspect} / <span className={n.verification.mismatch ? 'neg' : ''}>{n.verification.mismatch}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="muted">{fmtAgo(n.lastSeen)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
          {unquarantine.error ? <Notice kind="bad">{unquarantine.error}</Notice> : null}
        </div>
      </div>

      {o?.verification ? (
        <div className="stack sm">
          <span className="eyebrow">Spot checks · verification</span>
          <p className="hint">
            {fmtInt(o.verification.checked)} jobs re-checked: <span className="pos">{fmtInt(o.verification.ok)} ok</span> · {fmtInt(o.verification.suspect)} suspect ·{' '}
            <span className={o.verification.mismatch ? 'neg' : ''}>{fmtInt(o.verification.mismatch)} mismatch</span> · {fmtInt(o.verification.inconclusive)} inconclusive ·{' '}
            {fmtInt(o.verification.quarantinedNodes)} quarantined. Sample {Math.round(o.verification.config.sampleRate * 100)}% (×3 under {o.verification.config.minJobsBeforeTrust} jobs), mismatch = {o.verification.config.mismatchPenalty}{' '}
            failures, quarantine after {o.verification.config.quarantineAfterMismatches}.
          </p>
          <div className="tblwrap">
            <table className="tbl small">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Verdict</th>
                  <th className="num">Score</th>
                  <th>Primary</th>
                  <th>Checked by</th>
                  <th>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {o.verification.recent.length === 0 ? (
                  <tr>
                    <td className="muted" colSpan={6}>
                      No checks yet.
                    </td>
                  </tr>
                ) : (
                  o.verification.recent.slice(0, 12).map((v) => (
                    <tr key={v.id}>
                      <td className="muted">{fmtAgo(v.createdAt)}</td>
                      <td>
                        <span className={`pill sm ${v.verdict === 'ok' ? '' : v.verdict === 'mismatch' ? 'bad' : v.verdict === 'suspect' ? 'warn' : 'off'}`}>
                          <span className="dot" />
                          {v.verdict}
                        </span>
                      </td>
                      <td className="num">{v.score === null ? '—' : v.score.toFixed(2)}</td>
                      <td className="mono">{v.primaryNode}</td>
                      <td className="mono">{v.checkNode}</td>
                      <td className="mono wrap" style={{ fontSize: 12 }}>
                        {v.reasons.join(' · ') || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="panels">
        <div className="stack sm">
          <span className="eyebrow">Recent errors · 5xx and upstream</span>
          {loading ? (
            <Skeleton w="100%" h="100px" />
          ) : o ? (
            <div className="panel errlist">
              {o.recentErrors.length === 0 ? (
                <span className="small muted">No errors recorded.</span>
              ) : (
                o.recentErrors.slice(0, 12).map((e) => (
                  <div className="err" key={e.id}>
                    <div className="row between">
                      <span className="mono small">
                        <span className="neg">{e.status}</span> {e.code} · {e.route}
                      </span>
                      <span className="small muted">{fmtAgo(e.created_at)}</span>
                    </div>
                    <span className="small">{e.message}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="stack sm">
          <span className="eyebrow">Admin actions · audit</span>
          {loading ? (
            <Skeleton w="100%" h="100px" />
          ) : o ? (
            <div className="tblwrap">
              <table className="tbl small">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {o.recentAdminActions.length === 0 ? (
                    <tr>
                      <td className="muted" colSpan={3}>
                        Nothing yet.
                      </td>
                    </tr>
                  ) : (
                    o.recentAdminActions.slice(0, 15).map((a) => (
                      <tr key={a.id}>
                        <td className="muted">{fmtAgo(a.created_at)}</td>
                        <td className="mono">{a.action}</td>
                        <td className="mono wrap" style={{ fontSize: 12 }}>
                          {summarizePayload(a.payload)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * Public beta: the waitlist (oldest first) and invite codes. "Admit next N" mints one one-use code
 * per entry and shows them here; sending them is on you (e-mail delivery is out of scope). Wallet
 * entries are admitted directly and sign in without a code.
 */
/**
 * Starter credits on first connect (docs/SWITCHING.md): the first-ever sign-in of a wallet is credited a small
 * amount from config so a developer switching gateways can try Mesh before holding. This panel shows how many
 * wallets got it, how many may still, and pauses/resumes the programme at runtime (audited `starter-toggle`).
 */
function StarterPanel({ token, onUnauthorized, onChanged }: { token: string; onUnauthorized: () => void; onChanged: () => void }) {
  const st = useAsync(() => api.adminStarter(token), [token], 60_000);
  const s: StarterStatus | null = st.data;
  const [toggle, runToggle] = useAction(onUnauthorized);
  const [showGrants, setShowGrants] = useState(false);
  const cap = s ? (s.maxWallets === 0 ? null : s.maxWallets) : null;
  const pct = s && cap ? Math.min(100, Math.round((s.granted / cap) * 100)) : 0;
  const flip = (enabled: boolean | null) => runToggle(() => api.adminStarterToggle(token, enabled), () => { void st.reload(); onChanged(); });

  return (
    <div className="panel" aria-label="Starter credits on first connect">
      <div className="row between">
        <span className="eyebrow">Starter credits · first connect</span>
        {s ? (
          <span className={`pill sm ${s.enabled ? '' : 'off'}`}>
            <span className={`dot ${s.enabled ? 'dot-live' : ''}`} /> {s.enabled ? 'on' : 'paused'}
            {s.override !== null ? ' · override' : ''}
          </span>
        ) : null}
      </div>
      <p className="hint">
        {s
          ? `Each wallet's first-ever sign-in gets ${fmtUsd(s.amountUsd)} once; ${cap ? `${fmtInt(cap)} wallets` : 'unlimited wallets'}, ${s.maxPerIpPerDay} per IP a day${s.requireMinHold ? ', holders only' : ''}. Amount and caps live in config/tokenomics.json; this switch pauses or resumes without a redeploy.`
          : 'Loading…'}
      </p>
      {st.error && !s ? <Notice kind="bad">{st.error}</Notice> : null}
      {s ? (
        <>
          <div className="tiles dense">
            <Tile label="Granted" value={fmtInt(s.granted)} delta={`${fmtUsd(s.grantedUsd)} in starter credits`} />
            <Tile label="Remaining" value={s.remaining === null ? '∞' : fmtInt(s.remaining)} delta={cap ? `of ${fmtInt(cap)} wallets · ${pct}% used` : 'no wallet cap'} />
          </div>
          {cap ? (
            <div className="meter" style={{ marginTop: 0 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Starter grants used">
              <i style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {s.enabled ? (
              <button className="btn secondary sm" disabled={toggle.busy} onClick={() => flip(false)}>
                {toggle.busy ? <Spinner /> : null} Pause grants
              </button>
            ) : (
              <button className="btn primary sm" disabled={toggle.busy} onClick={() => flip(true)}>
                {toggle.busy ? <Spinner /> : null} Resume grants
              </button>
            )}
            {s.override !== null ? (
              <button className="btn ghost sm" disabled={toggle.busy} onClick={() => flip(null)} title={`Config says ${s.configEnabled ? 'on' : 'off'}`}>
                Follow config ({s.configEnabled ? 'on' : 'off'})
              </button>
            ) : null}
            <button className="btn ghost sm" onClick={() => setShowGrants((v) => !v)} disabled={!s.grants?.length}>
              {showGrants ? 'Hide' : 'Show'} recent grants{s.grants?.length ? ` (${Math.min(s.grants.length, 12)})` : ''}
            </button>
          </div>
          {showGrants && s.grants?.length ? (
            <div className="tblwrap">
              <table className="tbl small">
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th className="num">Amount</th>
                    <th>IP hash</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {s.grants.slice(0, 12).map((g) => (
                    <tr key={g.wallet}>
                      <td className="mono">{shortAddr(g.wallet)}</td>
                      <td className="num">{fmtUsd(g.amountUsd)}</td>
                      <td className="mono">{g.ipHash}</td>
                      <td className="date">{fmtAgo(g.grantedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <Skeleton w="100%" h="64px" />
      )}
      <Result s={toggle} />
    </div>
  );
}

/**
 * Admin → Token. The $MESH token is launched by the team's developer on Pons (Robinhood Chain); the founder
 * pastes the addresses the dev hands back here instead of editing config/deploy.robinhood.json. Saved values
 * live in the gateway DB (chain_settings, audited) and win over the JSON when the adapter is built at start-up.
 * "Check" verifies them against the chain; the live adapter switches on at the next restart once token + fee
 * vault are known (the internal docs repo).
 */
const CHAIN_FIELD_HELP: Record<ChainField, { label: string; hint: string; placeholder?: string }> = {
  token: { label: 'Token', hint: 'The $MESH ERC-20 the Pons factory minted (from the dev: TokenLaunched event).', placeholder: '0x…' },
  feeVault: { label: 'Fee vault (PonsFeeVault)', hint: 'Our PonsFeeVault — the Pons creatorFeeRecipient.', placeholder: '0x…' },
  creditPool: { label: 'Credit pool wallet', hint: 'The credit reserve: the holder share of every sweep lands here in the stable, apart from the treasury. Read each epoch and published on /stats.', placeholder: '0x…' },
  treasury: { label: 'Treasury', hint: 'Treasury multisig; the treasury share of every sweep.', placeholder: '0x…' },
  stable: { label: 'Stable (USDG / USDC)', hint: 'What the sweep settles in. Needed before the first live sweep: with sweepMode swap and no stable the sweep reverts and the fees wait in the vault.', placeholder: '0x…' },
  swapRouter: { label: 'Swap router', hint: 'Uniswap v3 SwapRouter02, informative (the route is set on the vault).', placeholder: '0x… (optional)' },
  priceFeed: { label: 'ETH/USD price feed', hint: 'Chainlink aggregator; sets the slippage floor of each swap. Stale or unreadable → ETH fees stay unswept until it is fresh. Blank → fixedEthUsd from the JSON / env.', placeholder: '0x…' },
  deployBlock: { label: 'Deploy block', hint: 'Block of the launch tx; holder scans start here.', placeholder: 'e.g. 1842930' },
  excludeWallets: { label: 'Exclude wallets', hint: 'Bonding curve, pool, locker… one per line or comma-separated. Merged with the JSON list.' },
};
const ADDRESS_FIELDS: ChainField[] = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed'];

function fieldToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('\n');
  return String(v);
}

function TokenPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const cv = useAsync(() => api.adminChain(token), [token]);
  const v: ChainView | null = cv.data;
  const [form, setForm] = useState<Record<ChainField, string> | null>(null);
  const [save, runSave] = useAction(onUnauthorized);
  const [check, runCheck] = useAction(onUnauthorized);
  const [clear, runClear] = useAction(onUnauthorized);
  const [showEffective, setShowEffective] = useState(false);
  const [copied, copy] = useCopy();

  // Seed the form from the current overrides once loaded (the JSON values show as placeholders).
  useEffect(() => {
    if (!v || form) return;
    const f = {} as Record<ChainField, string>;
    for (const k of v.fields) f[k] = fieldToText(v.overrides[k]);
    setForm(f);
  }, [v, form]);

  if (cv.error && !v) return <Notice kind="bad">Could not load the chain settings: {cv.error}</Notice>;
  if (!v || !form) return <div className="panel"><span className="eyebrow">Token · Robinhood Chain via Pons</span><Skeleton w="100%" h="160px" /></div>;

  const set = (k: ChainField, val: string) => setForm((f) => (f ? { ...f, [k]: val } : f));
  const dirty = v.fields.some((k) => form[k].trim() !== fieldToText(v.overrides[k]).trim());
  const badAddr = ADDRESS_FIELDS.filter((k) => form[k].trim() && !/^0x[0-9a-fA-F]{40}$/.test(form[k].trim()));
  const badBlock = form.deployBlock.trim() !== '' && !/^\d+$/.test(form.deployBlock.trim());
  const canSave = dirty && badAddr.length === 0 && !badBlock && !save.busy;

  const submit = () =>
    runSave(
      () => {
        const body: Record<string, unknown> = { chainId: v.chainId ?? undefined };
        for (const k of ADDRESS_FIELDS) body[k] = form[k].trim() || null;
        body.deployBlock = form.deployBlock.trim() ? Number(form.deployBlock.trim()) : null;
        body.excludeWallets = form.excludeWallets.trim() ? form.excludeWallets : null;
        return api.adminChainSave(token, body);
      },
      () => {
        setForm(null);
        void cv.reload();
      },
    );

  const report = check.result as ChainCheckReport | undefined;
  const statusPill = (
    <span className={`pill sm ${v.adapter.ready ? 'outline-accent' : 'off'}`}>
      <span className={`dot ${v.adapter.status.startsWith('mock') ? '' : 'dot-live'}`} /> {v.adapter.status}
      {v.adapter.restartNeeded ? ' · restart to apply' : ''}
    </span>
  );

  return (
    <div className="stack sm" aria-label="Token and chain settings">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="eyebrow">Token · {v.chainName ?? v.chain} {v.chainId ? `#${v.chainId}` : ''} · {v.feeSource === 'pons' ? 'Pons launch' : v.feeSource}</span>
          {statusPill}
        </div>
        <span className="small muted">
          {v.explorer ? <a href={v.explorer} target="_blank" rel="noreferrer">explorer</a> : null}
          {v.explorer ? ' · ' : ''}
          <span className="mono">{v.file.path}</span>
        </span>
      </div>
      <div className="panel">
        <p className="hint">
          The dev launches $MESH on Pons and hands back the addresses; paste them here. Saved values win over <span className="mono">{v.file.path}</span> (shown as placeholders) and are audited.
          {v.adapter.waitingFor ? ` Adapter: ${v.adapter.waitingFor}.` : v.adapter.ready ? ' Token + fee vault are set: the live adapter runs after the next restart with MESH_ADAPTER=evm.' : ' Token + fee vault are required before the live adapter can start.'}
          {v.sweeper ? (
            <>
              {' '}Sweeper (gateway hot wallet): <span className="mono">{shortAddr(v.sweeper)}</span>{' '}
              <button className="btn ghost sm" type="button" onClick={() => copy(v.sweeper!)}>{copied ? 'copied' : 'copy'}</button>
            </>
          ) : null}
        </p>
        <div className="panels" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {ADDRESS_FIELDS.map((k) => {
            const h = CHAIN_FIELD_HELP[k];
            const fileVal = fieldToText(v.file.values[k]);
            const bad = badAddr.includes(k);
            const isOverridden = v.overridden.includes(k);
            return (
              <div className="field" key={k}>
                <label htmlFor={`chain-${k}`}>
                  {h.label}
                  {isOverridden ? <span className="pill sm outline-accent" style={{ marginLeft: 6 }}>override</span> : fileVal ? <span className="pill sm" style={{ marginLeft: 6 }}>from json</span> : null}
                </label>
                <input
                  id={`chain-${k}`}
                  className="input mono sm"
                  value={form[k]}
                  placeholder={fileVal || h.placeholder}
                  onChange={(e) => set(k, e.target.value)}
                  aria-invalid={bad || undefined}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="small muted">{bad ? 'Not a 0x address (40 hex chars).' : h.hint}</span>
              </div>
            );
          })}
          <div className="field">
            <label htmlFor="chain-deployBlock">
              {CHAIN_FIELD_HELP.deployBlock.label}
              {v.overridden.includes('deployBlock') ? <span className="pill sm outline-accent" style={{ marginLeft: 6 }}>override</span> : null}
            </label>
            <input id="chain-deployBlock" className="input mono sm" inputMode="numeric" value={form.deployBlock} placeholder={fieldToText(v.file.values.deployBlock) || CHAIN_FIELD_HELP.deployBlock.placeholder} onChange={(e) => set('deployBlock', e.target.value)} aria-invalid={badBlock || undefined} />
            <span className="small muted">{badBlock ? 'Digits only.' : CHAIN_FIELD_HELP.deployBlock.hint}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="chain-excludeWallets">
            {CHAIN_FIELD_HELP.excludeWallets.label}
            {v.overridden.includes('excludeWallets') ? <span className="pill sm outline-accent" style={{ marginLeft: 6 }}>override</span> : null}
          </label>
          <textarea id="chain-excludeWallets" className="input mono" rows={3} value={form.excludeWallets} placeholder={'0x<bonding curve>\n0x<pool after graduation>'} onChange={(e) => set('excludeWallets', e.target.value)} spellCheck={false} />
          <span className="small muted">
            {CHAIN_FIELD_HELP.excludeWallets.hint} Already excluded from the JSON: {((v.file.values.excludeWallets as string[] | null) ?? []).length} Pons contract{((v.file.values.excludeWallets as string[] | null) ?? []).length === 1 ? '' : 's'}; the fee vault, credit pool, treasury and sweeper are excluded implicitly.
          </span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn primary sm" disabled={!canSave} onClick={submit}>
            {save.busy ? <Spinner /> : null} Save
          </button>
          <button className="btn secondary sm" disabled={check.busy} onClick={() => runCheck(() => api.adminChainCheck(token))}>
            {check.busy ? <Spinner /> : null} Check on chain
          </button>
          <button className="btn ghost sm" onClick={() => setShowEffective((x) => !x)}>
            {showEffective ? 'Hide' : 'Show'} effective config
          </button>
          <button
            className="btn ghost sm"
            disabled={clear.busy || v.overridden.length === 0}
            onClick={() => {
              if (!window.confirm('Clear every saved override and fall back to the JSON file?')) return;
              void runClear(() => api.adminChainClear(token), () => { setForm(null); void cv.reload(); });
            }}
          >
            Clear overrides
          </button>
          {dirty ? <span className="small muted">unsaved changes</span> : null}
        </div>
        {save.error ? <Notice kind="bad">{save.error}</Notice> : save.result ? <Notice kind="ok">Saved. {v.adapter.restartNeeded || !v.adapter.ready ? 'Restart the gateway with MESH_ADAPTER=evm once Check is clean.' : ''}</Notice> : null}
        {clear.error ? <Notice kind="bad">{clear.error}</Notice> : null}
        {check.error ? <Notice kind="bad">{check.error}</Notice> : null}
        {report ? (
          <div className="stack sm">
            <div className="row between">
              <span className={`pill sm ${report.ok ? 'outline-accent' : 'off'}`}>
                <span className={`dot ${report.ok ? 'dot-live' : ''}`} /> {report.ok ? 'check passed' : 'check found problems'} · RPC {report.rpcReachable ? `ok (chain ${report.rpcChainId})` : 'unreachable'}
              </span>
              <span className="small muted">{fmtAgo(report.checkedAt)}</span>
            </div>
            <div className="tblwrap">
              <table className="tbl small">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.filter((i) => i.status !== 'skip').map((i) => (
                    <tr key={i.check}>
                      <td className="mono">{i.check}</td>
                      <td>
                        <span className={`pill sm ${i.status === 'ok' ? '' : i.status === 'warn' ? 'outline-accent' : 'off'}`}>{i.status}</span>
                      </td>
                      <td className="small" style={{ overflowWrap: 'anywhere' }}>{i.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {showEffective ? (
          <div className="panels" style={{ gap: 12 }}>
            <div className="stack sm">
              <span className="small muted">JSON file{v.file.error ? ` (error: ${v.file.error})` : ''}</span>
              <pre className="result">{JSON.stringify(v.file.values, null, 1)}</pre>
            </div>
            <div className="stack sm">
              <span className="small muted">Overrides (DB){v.overrideMeta.length ? ` · last change ${fmtAgo(Math.max(...v.overrideMeta.map((m) => m.updatedAt)))}` : ''}</span>
              <pre className="result">{JSON.stringify(v.overrides, null, 1)}</pre>
            </div>
            <div className="stack sm">
              <span className="small muted">Effective (what the adapter gets)</span>
              <pre className="result">{JSON.stringify(v.effective, null, 1)}</pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BetaPanels({ token, o, onUnauthorized, onChanged }: { token: string; o: AdminOverview; onUnauthorized: () => void; onChanged: () => void }) {
  const beta = o.beta!;
  const [status, setStatus] = useState<'waiting' | 'invited' | 'all'>('waiting');
  const wl = useAsync(() => api.adminWaitlist(token, status), [token, status], 60_000);
  const [admitN, setAdmitN] = useState(String(beta.batchSize));
  const [count, setCount] = useState('5');
  const [uses, setUses] = useState('1');
  const [admit, runAdmit] = useAction(onUnauthorized);
  const [invites, runInvites] = useAction(onUnauthorized);
  const [copied, copy] = useCopy();
  const admitted = (admit.result as { entries?: WaitlistEntry[] } | undefined)?.entries;
  const codes = (invites.result as { codes?: string[] } | undefined)?.codes;
  const codeLines = (rows: WaitlistEntry[]) => rows.map((e) => `${e.email ?? e.wallet ?? ''}\t${e.code ?? ''}`).join('\n');

  return (
    <>
      <div className="tiles">
        <Tile label="Waiting" value={fmtInt(beta.waiting)} delta={`${fmtInt(beta.total)} on the list`} />
        <Tile label="Invited" value={fmtInt(beta.invited)} delta="codes sent from the list" />
        <Tile label="Admitted wallets" value={fmtInt(beta.admitted)} delta="signed in with a code or admitted" />
        <Tile label="Live codes" value={fmtInt(beta.liveCodes)} delta={`${fmtInt(beta.liveUses)} uses left`} />
      </div>
      <div className="panels">
        <div className="panel" aria-label="Waitlist">
          <span className="eyebrow">Waitlist · admit the next batch</span>
          <p className="hint">
            Oldest {beta.batchSize} by default. Each e-mail entry gets a one-use code to send by hand; wallet entries are admitted straight away and sign in
            without a code. Watch the runbook signals between batches.
          </p>
          <div className="keybox">
            <input className="input num sm" type="number" min="1" max="5000" step="1" value={admitN} onChange={(e) => setAdmitN(e.target.value)} aria-label="How many to admit" />
            <button
              className="btn primary sm"
              disabled={admit.busy || !(Number(admitN) > 0) || beta.waiting === 0}
              onClick={() =>
                runAdmit(
                  () => api.adminAdmitWaitlist(token, Number(admitN)),
                  () => {
                    onChanged();
                    void wl.reload();
                  },
                )
              }
            >
              {admit.busy ? <Spinner /> : null} Admit next {admitN || '…'}
            </button>
          </div>
          {admit.error ? <Notice kind="bad">{admit.error}</Notice> : null}
          {admitted ? (
            <div className="stack sm">
              <div className="row between">
                <span className="small">
                  {admitted.length === 0 ? 'Nobody was waiting.' : `${fmtInt(admitted.length)} admitted. Send each code to its address:`}
                </span>
                {admitted.length ? (
                  <button className="btn ghost sm" onClick={() => void copy(codeLines(admitted))}>
                    {copied ? 'Copied' : 'Copy all'}
                  </button>
                ) : null}
              </div>
              {admitted.length ? (
                <div className="tblwrap">
                  <table className="tbl small">
                    <thead>
                      <tr>
                        <th>Who</th>
                        <th>Code</th>
                      </tr>
                    </thead>
                    <tbody>
                      {admitted.map((e) => (
                        <tr key={e.id}>
                          <td className="mono">{e.email ?? shortAddr(e.wallet ?? '', 6, 4)}</td>
                          <td className="mono">{e.wallet && !e.email ? 'admitted (no code needed)' : e.code}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="panel" aria-label="Invites">
          <span className="eyebrow">Invite codes · mint</span>
          <p className="hint">For friends, partners and support cases. Codes are shown once; a wallet that uses one stays admitted for good.</p>
          <div className="keybox">
            <input className="input num sm" type="number" min="1" max="1000" step="1" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Number of codes" />
            <span className="small muted">×</span>
            <input className="input num sm" type="number" min="1" max="10000" step="1" value={uses} onChange={(e) => setUses(e.target.value)} aria-label="Uses per code" />
            <button
              className="btn secondary sm"
              disabled={invites.busy || !(Number(count) > 0) || !(Number(uses) > 0)}
              onClick={() => runInvites(() => api.adminInvites(token, Number(count), Number(uses)), onChanged)}
            >
              {invites.busy ? <Spinner /> : null} Mint
            </button>
          </div>
          {invites.error ? <Notice kind="bad">{invites.error}</Notice> : null}
          {codes ? (
            <div className="stack sm">
              <div className="row between">
                <span className="small">
                  {fmtInt(codes.length)} code{codes.length === 1 ? '' : 's'}, {uses} use{Number(uses) === 1 ? '' : 's'} each:
                </span>
                <button className="btn ghost sm" onClick={() => void copy(codes.join('\n'))}>
                  {copied ? 'Copied' : 'Copy all'}
                </button>
              </div>
              <div className="codes" aria-label="Invite codes">
                {codes.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="stack sm" aria-label="Waitlist entries">
        <div className="row between">
          <span className="eyebrow">Waitlist · {status}</span>
          <div className="seg" role="tablist" aria-label="Waitlist filter">
            {(['waiting', 'invited', 'all'] as const).map((st) => (
              <button key={st} role="tab" aria-selected={status === st} className={status === st ? 'on' : ''} onClick={() => setStatus(st)}>
                {st}
              </button>
            ))}
          </div>
        </div>
        {wl.loading && !wl.data ? (
          <Skeleton w="100%" h="100px" />
        ) : wl.error && !wl.data ? (
          <Notice kind="bad">{wl.error}</Notice>
        ) : wl.data ? (
          <div className="tblwrap">
            <table className="tbl small">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Who</th>
                  <th>Joined</th>
                  <th>Invited</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {wl.data.entries.length === 0 ? (
                  <tr>
                    <td className="muted" colSpan={5}>
                      {status === 'waiting' ? 'Nobody waiting.' : 'Nothing here.'}
                    </td>
                  </tr>
                ) : (
                  wl.data.entries.slice(0, 50).map((e) => (
                    <tr key={e.id}>
                      <td className="muted">{e.id}</td>
                      <td className="mono" title={e.wallet ?? e.email ?? ''}>
                        {e.email ?? shortAddr(e.wallet ?? '', 6, 4)}
                      </td>
                      <td className="muted">{fmtAgo(e.createdAt)}</td>
                      <td className="muted">{e.invitedAt ? fmtAgo(e.invitedAt) : '—'}</td>
                      <td className="mono">{e.code ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}

function EpochTable({ o }: { o: AdminOverview }) {
  if (o.epochs.length === 0) return <p className="small muted">No epochs yet. Run one above.</p>;
  return (
    <div className="tblwrap">
      <table className="tbl small">
        <thead>
          <tr>
            <th>Epoch</th>
            <th>Status</th>
            <th className="num">Eligible</th>
            <th className="num">Fees</th>
            <th className="num">To holders</th>
            <th className="num">Treasury</th>
            <th>Fee tx</th>
          </tr>
        </thead>
        <tbody>
          {o.epochs.slice(0, 12).map((e) => (
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
              <td className="num pos">{fmtUsd(e.holderPoolUsd ?? 0)}</td>
              <td className="num">{fmtUsd(e.treasuryUsd ?? 0)}</td>
              <td className="mono muted">{e.feeTxId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseBatch(text: string): { items: Array<{ wallet: string; amountUsd: number }>; bad: string[]; total: number } {
  const items: Array<{ wallet: string; amountUsd: number }> = [];
  const bad: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [wallet, amt] = line.split(/[,\t;]\s*|\s{2,}|\s+(?=[\d.]+$)/).map((s) => s?.trim());
    const amountUsd = Number(amt);
    if (!wallet || !Number.isFinite(amountUsd) || amountUsd <= 0) bad.push(line);
    else items.push({ wallet, amountUsd });
  }
  return { items, bad, total: items.reduce((a, i) => a + i.amountUsd, 0) };
}

function summarizePayload(p: unknown): string {
  if (p === null || p === undefined) return '—';
  if (typeof p !== 'object') return String(p);
  const o = p as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'items' && Array.isArray(v)) {
      parts.push(`items=${v.length}`);
      continue;
    }
    if (v === null || v === undefined) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' · ') || '{}';
}
