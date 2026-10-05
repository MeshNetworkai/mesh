import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GuestChat } from '../components/GuestChat';
import { BetaPill } from '../components/Nav';
import { Notice, Spinner, Tile } from '../components/ui';
import { STORAGE, TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtCompact, fmtCost, fmtInt, fmtTime, fmtUsd } from '../lib/format';
import { useStats } from '../lib/hooks';
import { errorMessage } from '../lib/toast';
import type { BetaInfo } from '../lib/types';

/* ---------- derived copy from config/tokenomics.json (never hardcoded) ---------- */
const T = TOKENOMICS;
const feePct = `${T.tradeFeeBps / 100}%`;
const holderPct = `${T.holderShareBps / 100}%`;
const treasuryPct = `${T.treasuryShareBps / 100}%`;
const minHold = `${fmtInt(T.minHoldTokens)} ${T.ticker}`;
const netPrice = fmtCost(T.networkPricePerMTokens);
const nodePay = fmtCost(T.nodeRewardUsdPerMTokens);
const epochMin = Math.round(T.epochSeconds / 60);
const epochWord = T.epochSeconds === 3600 ? 'hour' : `${epochMin} minutes`;

/**
 * Beta CTA: wallet or e-mail → POST /waitlist. Shown instead of "Connect wallet" while
 * `beta.inviteRequired`; people who already hold a code sign in from the small link under it.
 */
export function WaitlistForm({ beta, onConnect }: { beta: BetaInfo; onConnect: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ position: number; alreadyListed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.joinWaitlist(v.includes('@') ? { email: v } : { wallet: v });
      setDone({ position: r.position, alreadyListed: r.alreadyListed });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <div className="waitlist stack sm" id="waitlist" aria-live="polite">
        <Notice kind="ok">
          {done.alreadyListed ? 'You are already on the list' : 'You are on the list'}
          {done.position > 0 ? ` at position ${fmtInt(done.position)}` : ''}. Invites go out in batches; the code arrives at the address or wallet you gave.
        </Notice>
        <p className="small muted fine">
          Already have a code?{' '}
          <button type="button" className="linkbtn" onClick={onConnect}>
            Connect wallet
          </button>
        </p>
      </div>
    );
  }
  return (
    <form className="waitlist stack sm" id="waitlist" onSubmit={submit}>
      <div className="keybox">
        <input
          id="waitlist-id"
          className="input"
          placeholder="wallet address or e-mail"
          autoComplete="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Wallet address or e-mail"
          disabled={busy}
        />
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? <Spinner /> : null} Join the waitlist
        </button>
      </div>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <p className="small muted fine">
        {beta.label} is invite-only for now; invites go out in batches, oldest first. Have a code?{' '}
        <button type="button" className="linkbtn" onClick={onConnect}>
          Connect wallet
        </button>{' '}
        and enter it when asked.
      </p>
    </form>
  );
}

/* ---------- loop diagram ---------- */

function Arrow() {
  return (
    <span className="loop-arrow" aria-hidden="true">
      <svg viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 8h25M20 2l6 6-6 6" />
      </svg>
    </span>
  );
}

const GLYPH_PROPS = { viewBox: '0 0 72 72', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const LOOP = [
  {
    k: 'Trade',
    b: feePct,
    t: 'A trader swaps the token',
    c: `Every ${T.ticker} swap pays a ${feePct} fee into the protocol. That fee is the only thing that funds the network.`,
    glyph: (
      <svg {...GLYPH_PROPS} className="glyph" aria-hidden="true">
        <circle cx="26" cy="36" r="14" />
        <circle cx="46" cy="36" r="14" className="ac" />
        <path d="M14 58h44" />
        <path d="M58 54l4 4-4 4" className="ac" />
      </svg>
    ),
  },
  {
    k: 'Split',
    b: `${holderPct} / ${treasuryPct}`,
    t: `Fees become credits every ${epochWord}`,
    c: `${holderPct} is converted into AI credits for every wallet holding at least ${minHold}, pro-rata. ${treasuryPct} goes to the treasury.`,
    glyph: (
      <svg {...GLYPH_PROPS} className="glyph" aria-hidden="true">
        <path d="M36 12v18" />
        <path d="M36 30L18 48M36 30l18 18" />
        <rect x="10" y="48" width="16" height="12" className="soft" />
        <rect x="46" y="48" width="16" height="12" />
        <circle cx="36" cy="12" r="3" className="ac" />
      </svg>
    ),
  },
  {
    k: 'Spend',
    b: `${netPrice} / M`,
    t: 'Credits buy answers',
    c: `Holders spend credits; anyone else pays a flat ${netPrice} per million tokens when a node serves the request. One key, any OpenAI client.`,
    glyph: (
      <svg {...GLYPH_PROPS} className="glyph" aria-hidden="true">
        <rect x="12" y="18" width="48" height="30" rx="2" />
        <path d="M20 28h22M20 36h14" />
        <path d="M36 48v10M26 58h20" />
        <circle cx="50" cy="36" r="2.5" className="ac" />
      </svg>
    ),
  },
  {
    k: 'Serve',
    b: 'Macs',
    t: 'Macs answer, privately',
    c: 'Requests are stripped to the model and the messages and served by Apple Silicon Macs running the node app. Nothing is stored after the reply.',
    glyph: (
      <svg {...GLYPH_PROPS} className="glyph" aria-hidden="true">
        <rect x="14" y="16" width="44" height="30" rx="3" />
        <path d="M14 40h44M30 52h12M36 46v6" />
        <path d="M24 30l5 4 5-4" className="ac" />
        <path d="M40 26l4 0M40 30l4 0" className="ac" />
      </svg>
    ),
  },
  {
    k: 'Earn',
    b: `${nodePay} / M`,
    t: 'Node owners get paid',
    c: `Each Mac earns ${nodePay} per million tokens it serves, tracked per job and paid from the treasury share of the same fees.`,
    glyph: (
      <svg {...GLYPH_PROPS} className="glyph" aria-hidden="true">
        <path d="M14 56V30M26 56V22M38 56V38M50 56V16" />
        <path d="M10 60h52" />
        <circle cx="50" cy="16" r="3" className="ac" />
        <path d="M14 30l12-8 12 16 12-22" className="ac" strokeDasharray="2 3" />
      </svg>
    ),
  },
];

const WHY = [
  {
    k: 'i · Funding',
    t: 'Credits are a share of real fees',
    c: `Not an emission schedule. ${holderPct} of every ${feePct} fee is converted into AI credits each ${epochWord}; when trading is quiet, so are the credits.`,
  },
  {
    k: 'ii · Privacy',
    t: 'Nodes never see who asked',
    c: 'Requests are served by independent Macs that receive only the model and the messages. Choose a tier per request: trusted, network, or a zero-data-retention upstream.',
  },
  {
    k: 'iii · Price',
    t: 'A flat price per million tokens',
    c: `${netPrice} per million tokens whenever a node serves you, instead of list pricing. Every reply says what it cost and who served it.`,
  },
  {
    k: 'iv · Hardware',
    t: 'Runs on machines people already own',
    c: 'The node app is one command on an Apple Silicon Mac. No racks, no procurement, no capital expenditure to recoup.',
  },
  {
    k: 'v · Audit',
    t: 'Everything is auditable',
    c: 'Epochs, the weekly report and the treasury ledger are public. Anyone can check that the credits issued match the fees collected.',
  },
  {
    k: 'vi · Compatibility',
    t: 'Works wherever an OpenAI key works',
    c: 'Point an existing client at the gateway and change nothing else. The same key, the same models, a different bill.',
  },
];

const TIERS = [
  {
    name: 'Trusted nodes',
    desc: 'Your own Macs, allowlisted operators, and gold-staked operators who signed the operator pledge. If none is online the request goes to the ZDR upstream, never to other nodes.',
    tag: 'default',
  },
  { name: 'Any network node', desc: 'Any online node. Cheapest; the operator could in principle inspect memory while serving you.', tag: 'cheapest' },
  { name: 'Upstream (ZDR)', desc: 'Skips the network for zero-data-retention providers only, at list price.', tag: 'list price' },
];

/* ---------- page ---------- */

const CHAT_ID = 'guest-chat';

export function Landing() {
  const { data: stats, loading, error } = useStats();
  const { session, openModal } = useAuth();
  const beta = stats?.beta ?? null;
  const waitlistCta = Boolean(beta?.enabled && beta.inviteRequired) && !session;
  const skel = loading && !stats;
  // `?ref=CODE` from a referral link: keep it until the wallet signs in and claims it on the dashboard.
  // Kept only while the points programme is on (built, disabled by default).
  const [params] = useSearchParams();
  useEffect(() => {
    const ref = params.get('ref');
    if (!ref || !stats?.pointsEnabled) return;
    try {
      localStorage.setItem(STORAGE.referralCode, ref.trim().toUpperCase().slice(0, 6));
    } catch {
      /* ignore */
    }
  }, [params, stats?.pointsEnabled]);

  const focusChat = () => {
    const el = document.getElementById(CHAT_ID);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => el?.querySelector('textarea')?.focus({ preventScroll: true }), 400);
  };

  return (
    <div className="wrap">
      {/* 1 · hero: copy left, live guest chat right, key figures underneath */}
      <section className="hero eco-hero" aria-labelledby="hero-h1">
        <div className="eco-hero-grid">
          <div className="eco-hero-copy">
            <p className="eyebrow">
              {T.name} · ${T.ticker} · {T.chain.charAt(0).toUpperCase() + T.chain.slice(1)}
              <BetaPill />
            </p>
            <h1 className="display eco-h1" id="hero-h1">
              Trades fund it.
              <br />
              Macs serve it.
              <br />
              <em>Holders use it.</em>
            </h1>
            <p className="lede">
              Every swap of ${T.ticker} pays a {feePct} fee. Half becomes AI credits for holders each {epochWord}; the requests are answered privately
              by Macs in the network, and the people who run them are paid per million tokens.
            </p>
            {waitlistCta && beta ? <WaitlistForm beta={beta} onConnect={openModal} /> : null}
          </div>
          <GuestChat id={CHAT_ID} />
        </div>
        <div className="tiles dense eco-figures" aria-label="Key figures">
          <div className="tile">
            <span className="l">Fee</span>
            <span className="n">{feePct}</span>
            <span className="d">on every swap</span>
          </div>
          <div className="tile">
            <span className="l">To holders</span>
            <span className="n">{holderPct}</span>
            <span className="d">of each fee, as credits</span>
          </div>
          <div className="tile">
            <span className="l">Min hold</span>
            <span className="n">{minHold}</span>
            <span className="d">to be credited</span>
          </div>
          <div className="tile">
            <span className="l">Price / M</span>
            <span className="n">{netPrice}</span>
            <span className="d">when a node serves you</span>
          </div>
          <div className="tile">
            <span className="l">Node pay / M</span>
            <span className="n">{nodePay}</span>
            <span className="d">per million tokens served</span>
          </div>
        </div>
      </section>

      {/* 2 · how the ecosystem works */}
      <section aria-labelledby="how-h">
        <div className="sec-head">
          <p className="eyebrow" id="how-h">
            01 · How the ecosystem works
          </p>
          <div className="stack sm">
            <h2 className="display d-m">
              The fee goes round, <span className="muted">and comes back as answers.</span>
            </h2>
            <p className="sub">
              Nothing here is minted to pay anyone. Trading pays the holders, the holders pay the Macs, the Macs keep the network cheap enough to
              trade on.
            </p>
          </div>
        </div>
        <div className="loop" role="list">
          {LOOP.map((n, i) => (
            <div key={n.k} style={{ display: 'contents' }}>
              <div className="loop-node" role="listitem">
                {n.glyph}
                <div>
                  <p className="k">
                    <span>
                      {String(i + 1).padStart(2, '0')} · {n.k}
                    </span>
                    <b className="num">{n.b}</b>
                  </p>
                  <p className="t display d-s">{n.t}</p>
                  <p className="c">{n.c}</p>
                </div>
              </div>
              {i < LOOP.length - 1 ? <Arrow /> : null}
            </div>
          ))}
          <p className="loop-return">
            <span className="ret" aria-hidden="true">
              ↺
            </span>
            <span>
              The treasury share that pays the Macs comes from the same fee, so every {epochWord} of trading funds the next {epochWord} of answers.
            </span>
          </p>
        </div>
      </section>

      {/* 3 · three ways in */}
      <section aria-labelledby="ways-h">
        <div className="sec-head">
          <p className="eyebrow" id="ways-h">
            02 · Three ways in
          </p>
          <div className="stack sm">
            <h2 className="display d-m">
              Use it, run it, <span className="muted">or hold it.</span>
            </h2>
            <p className="sub">Each role pays the others. You do not need a Mac to use the network, or to hold the token to run one.</p>
          </div>
        </div>
        <div className="pillars">
          <article className="pillar">
            <span className="display d-l n">01</span>
            <h3 className="display d-s">Use it</h3>
            <ul>
              <li>Credits land in your wallet every {epochWord}, paid by trading fees.</li>
              <li>One OpenAI-compatible key: SDKs, editors, shell scripts, anything.</li>
              <li>Or just chat in the browser. {minHold} is the only ticket.</li>
            </ul>
            <Link className="arrow-link" to="/app/chat">
              Open the chat
            </Link>
          </article>
          <article className="pillar">
            <span className="display d-l n">02</span>
            <h3 className="display d-s">Run a Mac</h3>
            <ul>
              <li>Leave an Apple Silicon Mac open. One command, or download the menu-bar app.</li>
              <li>Earn {nodePay} per million tokens served, tracked per job.</li>
              <li>Pause any time. Nothing about the person asking ever reaches your machine.</li>
            </ul>
            <Link className="arrow-link" to="/download">
              Download for Mac
            </Link>
          </article>
          <article className="pillar">
            <span className="display d-l n">03</span>
            <h3 className="display d-s">Hold the token</h3>
            <ul>
              <li>Hold {minHold} and credits drop every {epochWord}. Nothing to claim.</li>
              <li>The full epoch history is public, down to the wallet.</li>
              <li>Stake for a bigger share when staking is live.</li>
            </ul>
            <Link className="arrow-link" to="/docs">
              Read the docs
            </Link>
          </article>
        </div>
      </section>

      {/* 4 · why this is different */}
      <section aria-labelledby="why-h">
        <div className="sec-head">
          <p className="eyebrow" id="why-h">
            03 · Why this is different
          </p>
          <h2 className="display d-m">
            Real fees, real machines, <span className="muted">everything on the record.</span>
          </h2>
        </div>
        <div className="why">
          {WHY.map((w) => (
            <div className="why-item" key={w.k}>
              <span className="k">{w.k}</span>
              <h3 className="display d-s">{w.t}</h3>
              <p>{w.c}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 5 · privacy */}
      <section aria-labelledby="priv-h">
        <div className="ink privacy">
          <span className="glow" aria-hidden="true" />
          <div className="privacy-copy">
            <p className="eyebrow">04 · Privacy, stated plainly</p>
            <h2 className="display d-l" id="priv-h">
              You choose who sees a prompt.
            </h2>
            <p>
              Any machine that runs a model sees the prompt in plaintext while it runs. What {T.name} does is let you choose <i>which</i> machines,
              strip everything else from the job, and never keep the text anywhere. Pick a tier per request or per key.
            </p>
          </div>
          <ul className="tiers">
            {TIERS.map((t) => (
              <li key={t.name}>
                <span className="name display d-s">{t.name}</span>
                <span className="desc">{t.desc}</span>
                <span className="tag eyebrow">{t.tag}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6 · live numbers */}
      <section aria-labelledby="nums-h">
        <div className="sec-head">
          <p className="eyebrow" id="nums-h">
            05 · Live numbers
          </p>
          <div className="stack sm">
            <h2 className="display d-m">
              The network, <span className="muted">as it stands.</span>
            </h2>
            {stats ? <p className="small muted num">Updated {fmtTime(stats.generatedAt)}</p> : null}
          </div>
        </div>
        <div className="tiles">
          <Tile label="Fees collected" value={fmtUsd(stats?.totalFeesUsd ?? null, 0)} delta="all time" loading={skel} />
          <Tile label="Credits issued" value={fmtUsd(stats?.creditsDistributedUsd ?? null, 0)} delta={`${holderPct} of fees, every ${epochWord}`} loading={skel} />
          <Tile label="Requests" value={fmtCompact(stats?.requestsLast24h ?? null)} delta="last 24 hours" loading={skel} />
          <Tile label="Nodes online" value={fmtInt(stats?.nodesOnline ?? null)} delta="Macs serving right now" loading={skel} />
        </div>
        <p className="row between small muted">
          <span role={error && !stats ? 'status' : undefined}>
            {error && !stats
              ? `Live numbers unavailable right now (${error}).`
              : `${fmtInt(stats?.epochsRun ?? null)} epochs run · ${fmtInt(stats?.holdersEligibleLastEpoch ?? null)} wallets credited last epoch`}
          </span>
          <Link to="/report">Weekly report</Link>
        </p>
      </section>

      {/* 7 · final CTA */}
      <section className="final" aria-labelledby="final-h">
        <h2 className="display d-xl" id="final-h">
          Three doors. <em>Same room.</em>
        </h2>
        <div className="row">
          <button type="button" className="btn primary" onClick={focusChat}>
            Start chatting
          </button>
          <Link className="btn secondary" to="/download">
            Run a node
          </Link>
          <Link className="btn secondary" to="/docs">
            Read the docs
          </Link>
        </div>
        <p className="risk small muted">
          Credits are a share of fees, not a promise: <Link to="/risk">read the risks</Link>. {T.name} stores no prompts and no replies; the machine
          that serves you sees your text, which is why you choose the tier.
        </p>
      </section>
    </div>
  );
}
