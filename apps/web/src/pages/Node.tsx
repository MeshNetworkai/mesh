import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, Notice, Skeleton, Spinner, Terminal } from '../components/ui';
import { MOCK, PUBLIC_API_URL, TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtCompact, fmtCost, fmtDate, fmtInt, shortAddr } from '../lib/format';
import { useCopy, useMyNodes, useNodes } from '../lib/hooks';
import { errorMessage, useToast } from '../lib/toast';
import type { LinkCode, NodePledge, NodeView, PledgeText } from '../lib/types';

/**
 * The exact one-liner. The script is served by this web origin; the bundle comes from the gateway.
 * With a link code (from "Link a Mac") the Mac never needs a wallet key: `--link <code>`. The
 * `--wallet` form is legacy and only works on gateways that allow unsigned registration.
 */
export function installOneLiner(wallet: string | null, link: string | null = null): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://mesh.example';
  const who = link ? `--link ${link}` : wallet ? `--wallet ${wallet}` : '--link <code>';
  return `curl -fsSL ${origin}/install-node.sh | sh -s -- ${who} --gateway ${PUBLIC_API_URL} --web ${origin}`;
}

const STEPS: Array<[string, string]> = [
  ['Link', 'Click "Link a Mac": your wallet signs once, here in the browser, and you get a one-time code (15 min).'],
  ['Ollama', 'The installer adds Ollama with Homebrew if it is missing, makes sure it runs, and pulls llama3.1:8b (14B on 32 GB+).'],
  ['Register', 'mesh-node setup --link <code> registers the Mac to your wallet. No key ever touches the machine.'],
  ['Service', 'Starts the node in the background and at login (launchd). mesh-node status shows counts and earnings only.'],
];

/** One-line status for the pledge card. */
export function pledgeSummary(p: NodePledge | undefined): { tone: 'ok' | 'warn' | 'off'; text: string } {
  if (!p) return { tone: 'off', text: 'Pledge status unavailable' };
  if (p.trusted && p.trustedVia === 'allowlist') return { tone: 'ok', text: 'Trusted · allowlisted wallet' };
  if (p.trusted) return { tone: 'ok', text: `Trusted · ${p.stakeTier ?? 'staked'} stake + pledge` };
  if (p.signed && !p.stakeOk) return { tone: 'warn', text: `Pledged · needs ${p.requiredStakeTier ?? 'a higher'} stake to be trusted` };
  if (!p.signed && p.stakeOk) return { tone: 'warn', text: 'Stake ok · sign the pledge to be trusted' };
  return { tone: 'off', text: `Not trusted · needs ${p.requiredStakeTier ?? 'gold'} stake and the pledge` };
}

export const LINK_CODE_TTL_SEC = 15 * 60;

/** Seconds left on a link code (0 when expired). */
export function linkSecondsLeft(link: Pick<LinkCode, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(link.expiresAt).getTime() - now) / 1000));
}

export const fmtCountdown = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Ticks once a second while a code is live; returns seconds left. */
function useCountdown(link: LinkCode | null): number {
  const [left, setLeft] = useState(() => (link ? linkSecondsLeft(link) : 0));
  useEffect(() => {
    if (!link) return;
    setLeft(linkSecondsLeft(link));
    const id = window.setInterval(() => setLeft(linkSecondsLeft(link)), 1000);
    return () => window.clearInterval(id);
  }, [link]);
  return link ? left : 0;
}

/**
 * "Link a Mac": challenge → wallet signs in the browser → POST /nodes/link → one-time code + the
 * install one-liner carrying `--link <code>`. The Mac only ever sees the code.
 */
function LinkMac() {
  const { session, token, openModal, signMessage } = useAuth();
  const [link, setLink] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<'idle' | 'challenge' | 'signing' | 'linking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const left = useCountdown(link);
  const expired = link !== null && left === 0;

  const start = useCallback(async () => {
    if (!session || !token) return openModal();
    setError(null);
    try {
      setBusy('challenge');
      const ch = await api.getRegisterChallenge(session.wallet);
      setBusy('signing');
      const { signature, chain } = await signMessage(ch.message);
      setBusy('linking');
      setLink(await api.createLinkCode(token, { nonce: ch.nonce, signature, chain }));
    } catch (err) {
      const msg = errorMessage(err);
      setError(/reject|denied|cancel/i.test(msg) ? 'Signature cancelled.' : msg);
    } finally {
      setBusy('idle');
    }
  }, [session, token, openModal, signMessage]);

  const code = link && !expired ? link.code : null;
  const oneLiner = installOneLiner(null, code);
  const busyLabel = busy === 'challenge' ? 'Preparing…' : busy === 'signing' ? 'Sign in your wallet…' : busy === 'linking' ? 'Creating code…' : null;

  return (
    <div className="stack sm">
      <div className="row between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <span className="field">
          <span className="lbl">Install · one line · paste in Terminal</span>
        </span>
        <button className={`btn ${code ? 'secondary' : 'primary'}`} onClick={start} disabled={busy !== 'idle'} aria-busy={busy !== 'idle'}>
          {busy !== 'idle' ? <Spinner /> : null}
          {busyLabel ?? (!session ? 'Connect wallet to link a Mac' : code ? 'New code' : expired ? 'Link another Mac' : 'Link a Mac')}
        </button>
      </div>

      {code && link ? (
        <div className="linkcode" role="status" aria-live="polite">
          <div className="linkcode-main">
            <span className="small muted">One-time link code · paid to {shortAddr(link.wallet, 5, 4)}</span>
            <span className="linkcode-code mono" aria-label={`Link code ${code.split('').join(' ')}`}>
              {code.slice(0, 4)}
              <span className="sep">-</span>
              {code.slice(4)}
            </span>
          </div>
          <div className="linkcode-side">
            <span className={`pill sm${left <= 60 ? ' warn' : ''}`}>
              <span className="dot dot-live" aria-hidden="true" />
              expires in <span className="mono">{fmtCountdown(left)}</span>
            </span>
            <button className="btn sm ghost" onClick={() => copy(code)} aria-label="Copy link code">
              {copied ? 'Copied' : 'Copy code'}
            </button>
          </div>
        </div>
      ) : null}
      {expired ? <Notice kind="warn">That link code expired after 15 minutes. Click “Link another Mac” for a fresh one.</Notice> : null}
      {error ? <Notice kind="bad">{error}</Notice> : null}

      <Terminal label="Install the node agent" code={oneLiner} wrap />
      {code ? (
        <p className="small muted" style={{ margin: 0 }}>
          Already installed? Run <code className="mono">mesh-node setup --link {code}</code> instead. The code works once and is bound to your wallet;
          the Mac never holds a key.{MOCK ? ' Mock mode: the code is not registered anywhere.' : ''}
        </p>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {session ? 'Click “Link a Mac” to sign once with your wallet and fill in the code.' : 'Connect a wallet, then “Link a Mac” fills in the code.'} Your
          wallet signs here in the browser; the Mac only needs the code.
        </p>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Afterwards: <code className="mono">mesh-node status</code>, <code className="mono">mesh-node pause</code> /{' '}
        <code className="mono">resume</code>, <code className="mono">mesh-node logs</code>,{' '}
        <code className="mono">mesh-node service uninstall</code>.
      </p>
    </div>
  );
}

function statusOf(n: NodeView): 'online' | 'busy' | 'offline' {
  const s = (n.stats?.status ?? n.status ?? '').toLowerCase();
  if (s === 'busy') return 'busy';
  if (s === 'online' || s === 'idle') return 'online';
  return 'offline';
}

/**
 * "Operator pledge": the owner signs a fixed text (docs/PRIVACY.md) with the reward wallet. Together with
 * a gold stake (or an allowlisted wallet) that makes the node eligible for `trusted` jobs. Mock mode signs
 * through the same flow without a real wallet.
 */
function PledgeCard({ n, onChanged }: { n: NodeView; onChanged: () => void }) {
  const { token, signMessage } = useAuth();
  const toast = useToast();
  const [text, setText] = useState<PledgeText | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'signing' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pledge = text ?? n.stats?.pledge;
  const summary = pledgeSummary(pledge);

  const show = async () => {
    if (!token) return;
    setError(null);
    setBusy('loading');
    try {
      setText(await api.getPledge(token, n.nodeId));
      setOpen(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('idle');
    }
  };

  const sign = async () => {
    if (!token || !text) return;
    setError(null);
    try {
      setBusy('signing');
      const { signature, chain } = MOCK ? { signature: 'mock', chain: 'solana' as const } : await signMessage(text.message);
      setBusy('saving');
      const res = await api.signPledge(token, n.nodeId, { signature, chain });
      setText(res);
      setOpen(false);
      toast.ok(res.trusted ? 'Pledge signed: this node now serves trusted requests' : 'Pledge signed. It becomes trusted once the stake requirement is met.');
      onChanged();
    } catch (err) {
      const msg = errorMessage(err);
      setError(/reject|denied|cancel/i.test(msg) ? 'Signature cancelled.' : msg);
    } finally {
      setBusy('idle');
    }
  };

  const pillCls = summary.tone === 'ok' ? 'pill sm' : summary.tone === 'warn' ? 'pill sm warn' : 'pill sm off';
  return (
    <div className="stack sm" aria-label="Operator pledge">
      <div className="row between" style={{ alignItems: 'center', gap: 8 }}>
        <span className={pillCls} title={pledge?.signedAt ? `signed ${fmtDate(pledge.signedAt)}` : undefined}>
          <span className={`dot${summary.tone === 'ok' ? ' dot-live' : ''}`} aria-hidden="true" />
          {summary.text}
        </span>
        {pledge?.signed ? (
          <button className="btn ghost sm" onClick={show} disabled={busy !== 'idle'}>
            View pledge
          </button>
        ) : (
          <button className="btn secondary sm" onClick={show} disabled={busy !== 'idle' || !token} aria-busy={busy !== 'idle'}>
            {busy === 'loading' ? <Spinner /> : null}
            Sign the operator pledge
          </button>
        )}
      </div>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {open && text ? (
        <Modal title="Operator pledge" onClose={() => setOpen(false)}>
          <p className="small muted">
            Signing this with <span className="mono">{shortAddr(text.wallet, 5, 4)}</span> commits you, as the operator of{' '}
            <span className="mono">{shortAddr(text.nodeId, 9, 4)}</span>, to the four points below. With a {text.requiredStakeTier ?? 'gold'} stake (or an
            allowlisted wallet) the node then receives <b>trusted</b> requests. No transaction, no fee.
          </p>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
            {text.message}
          </pre>
          <p className="small muted">
            We cannot technically prevent an operator from inspecting memory on their own machine; the pledge, the stake at risk and the ability to
            revoke trusted status are what back the trusted tier. {MOCK ? 'Mock mode: nothing is signed or stored.' : ''}
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              {text.signed ? 'Close' : 'Cancel'}
            </button>
            {!text.signed ? (
              <button type="button" className="btn primary" onClick={sign} disabled={busy !== 'idle'} aria-busy={busy !== 'idle'}>
                {busy !== 'idle' ? <Spinner /> : null}
                {busy === 'signing' ? 'Sign in your wallet…' : busy === 'saving' ? 'Saving…' : 'Sign with wallet'}
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function NodeCard({ n, onChanged }: { n: NodeView; onChanged: () => void }) {
  const status = statusOf(n);
  const st = n.stats;
  const chip = n.chip ?? st?.chip ?? null;
  const ram = n.ramGb ?? st?.ramGb ?? null;
  const models = n.models.length ? n.models : (st?.models ?? []);
  const lastSeen = st?.lastSeen ?? n.lastSeen ?? null;
  const pillCls = status === 'offline' ? 'pill sm off' : status === 'busy' ? 'pill sm busy' : 'pill sm';
  return (
    <article className={`nodecard ${status}`} aria-label={`Node ${n.nodeId}`}>
      <div className="row between">
        <span className={pillCls}>
          <span className={`dot${status === 'offline' ? '' : ' dot-live'}`} aria-hidden="true" />
          {status}
        </span>
        <span className="small muted">
          last seen <span className="mono">{fmtAgo(lastSeen)}</span>
        </span>
      </div>
      <div className="nodecard-id">
        <span className="display d-s">{chip ?? 'Unknown chip'}</span>
        <span className="mono small muted" title={n.nodeId}>
          {ram !== null ? `${fmtInt(ram)} GB` : '— GB'} · {shortAddr(n.nodeId, 9, 4)}
          {n.agentVersion ? ` · v${n.agentVersion}` : ''}
        </span>
      </div>
      <div className="row" aria-label="Models">
        {models.length ? (
          models.map((m) => (
            <span key={m} className="pill sm mono">
              {m}
            </span>
          ))
        ) : (
          <span className="small muted">no models advertised</span>
        )}
      </div>
      <dl className="nodestats">
        <div>
          <dt>Uptime · 24h</dt>
          <dd>{st ? `${st.uptimePct24h.toFixed(1)}%` : <Skeleton w="5ch" />}</dd>
        </div>
        <div>
          <dt>Jobs · 24h</dt>
          <dd>{st ? fmtInt(st.jobs24h) : <Skeleton w="5ch" />}</dd>
        </div>
        <div>
          <dt>Tokens · 24h</dt>
          <dd>{st ? fmtCompact(st.tokens24h) : <Skeleton w="5ch" />}</dd>
        </div>
        <div>
          <dt>Earned · 24h</dt>
          <dd className="pos">{st ? fmtCost(st.earnedUsd24h) : <Skeleton w="6ch" />}</dd>
        </div>
        <div>
          <dt>Earned · total</dt>
          <dd className="pos">{st ? fmtCost(st.earnedUsdTotal) : <Skeleton w="6ch" />}</dd>
        </div>
        {st?.verification && st.verification.enabled !== false ? (
          <div title="Spot checks: a sample of your jobs is re-run elsewhere and compared. ok / suspect / mismatch">
            <dt>Spot checks</dt>
            <dd className="mono">
              {st.verification.checked === 0 ? (
                <span className="muted">none yet</span>
              ) : (
                <>
                  <span className="pos">{st.verification.ok}</span> / {st.verification.suspect} / <span className={st.verification.mismatch ? 'neg' : ''}>{st.verification.mismatch}</span>
                </>
              )}
            </dd>
          </div>
        ) : null}
      </dl>
      {st?.verification?.quarantined ? (
        <Notice kind="bad">
          This node is quarantined after repeated spot-check mismatches and receives no jobs. Reason: {st.verification.quarantineReason ?? 'verification mismatches'}. Check the Mac
          (model files, Ollama version, nothing modifying the agent) and ask us to clear it.
        </Notice>
      ) : null}
      <PledgeCard n={n} onChanged={onChanged} />
    </article>
  );
}

export function NodePage() {
  const { session, openModal } = useAuth();
  const mine = useMyNodes(15_000);
  const net = useNodes(60_000);
  const nodes = mine.data ?? [];
  const online = nodes.filter((n) => statusOf(n) !== 'offline').length;
  const earned24h = nodes.reduce((a, n) => a + (n.stats?.earnedUsd24h ?? 0), 0);

  return (
    <>
      <div className="row between">
        <span className="display d-s">Run a node</span>
        <span className="small muted">
          {net.data ? `${fmtInt(net.data.online)} nodes online across the network` : ''}
          {MOCK ? ' · mock data' : ''}
        </span>
      </div>

      <div className="grid g2 nodeintro">
        <div className="stack">
          <p className="lede" style={{ margin: 0 }}>
            Leave your Mac open and get paid for the answers it serves. The agent talks to a local Ollama, pulls jobs from the gateway over
            HTTPS (no inbound ports, nothing stored) and streams the reply back.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Earnings are shown as $ credits today, settled from the treasury share of trading fees; they move to {TOKENOMICS.ticker} once the
            token layer ships. Apple Silicon with 16 GB+ is the target; Linux works with Ollama installed.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            What you see here, in <code className="mono">mesh-node status</code> and in the menu bar app is counts and earnings only. Jobs arrive
            without any detail about who sent them, and the agent never writes a prompt or reply to disk. Stake gold and sign the operator pledge
            below to serve <b>trusted</b> requests.
          </p>
        </div>
        <ol className="nodesteps" aria-label="What the installer does">
          {STEPS.map(([k, v], i) => (
            <li key={k}>
              <span className="n">0{i + 1}</span>
              <span>
                <b>{k}</b> <span className="muted">{v}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <LinkMac />

      <div className="row between">
        <span className="display d-s">Your nodes</span>
        {session && nodes.length ? (
          <span className="small muted">
            {online} of {nodes.length} online · {fmtCost(earned24h)} earned in 24h · refreshes every 15 s
          </span>
        ) : null}
      </div>

      {!session ? (
        <Empty
          title="Connect a wallet to see your nodes"
          action={
            <button className="btn primary" onClick={openModal}>
              Connect wallet
            </button>
          }
        >
          Nodes registered to the wallet you sign in with show up here with uptime and earnings.
        </Empty>
      ) : mine.error && !mine.data ? (
        <Notice kind="bad">Could not load your nodes: {mine.error}</Notice>
      ) : mine.loading && !mine.data ? (
        <div className="nodecards">
          {[0, 1].map((i) => (
            <div className="nodecard" key={i} aria-hidden="true">
              <Skeleton w="7ch" h="1.4em" />
              <Skeleton w="60%" h="1.6em" />
              <Skeleton w="40%" />
              <Skeleton w="100%" h="3em" />
            </div>
          ))}
        </div>
      ) : nodes.length === 0 ? (
        <Empty title="No node yet">
          Click “Link a Mac”, then run the install command on the Mac. It registers to <span className="mono">{shortAddr(session.wallet, 5, 4)}</span>{' '}
          and shows up here within a minute.
        </Empty>
      ) : (
        <div className="nodecards">
          {nodes.map((n) => (
            <NodeCard key={n.nodeId} n={n} onChanged={() => void mine.reload()} />
          ))}
        </div>
      )}
    </>
  );
}
