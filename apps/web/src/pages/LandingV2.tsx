import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TOKENOMICS } from '../config';
import { ApiError, getGuestQuota, onGuestRemaining, streamGuestChat, type ChatMessage, type ChatResult } from '../lib/api';
import { fmtCompact, fmtCost, fmtInt, fmtUsd } from '../lib/format';
import { useStats } from '../lib/hooks';
import './landing-v2.css';

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

const FONT_ID = 'lv2-fraunces';
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300&display=swap';

/** Loads the display serif once and recolours the shared chrome (nav/footer) while this page is mounted. */
function useEditorialChrome() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('lv2-root');
    if (!document.getElementById(FONT_ID)) {
      const pre = document.createElement('link');
      pre.rel = 'preconnect';
      pre.href = 'https://fonts.gstatic.com';
      pre.crossOrigin = 'anonymous';
      pre.dataset.lv2 = '1';
      const link = document.createElement('link');
      link.id = FONT_ID;
      link.rel = 'stylesheet';
      link.href = FONT_HREF;
      document.head.append(pre, link);
    }
    return () => {
      root.classList.remove('lv2-root');
    };
  }, []);
}

/* ---------- hero chat ---------- */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  result?: ChatResult | null;
}

const PROMPTS = ['Explain how Mesh pays for AI', 'Write a tweet about privacy', 'What runs on my Mac?'];

function GuestChat() {
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    getGuestQuota()
      .then((q) => {
        if (!alive) return;
        setRemaining(q.remaining);
        setLimit(q.limit);
        setEnabled(q.enabled);
        if (q.remaining <= 0) setExhausted(true);
      })
      .catch(() => {
        /* quota unknown: the first send will tell us */
      });
    const off = onGuestRemaining((n) => {
      if (!alive) return;
      setRemaining(n);
      if (n <= 0) setExhausted(true);
    });
    return () => {
      alive = false;
      off();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || exhausted) return;
      setError(null);
      setInput('');
      const history: ChatMessage[] = [...turns.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content }];
      setTurns((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '', result: null }]);
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const result = await streamGuestChat({ messages: history, signal: ac.signal }, (delta) => {
          setTurns((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        });
        setTurns((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, result };
          return next;
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // drop the empty assistant turn
        setTurns((prev) => (prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1].content ? prev.slice(0, -1) : prev));
        if (err instanceof ApiError && (err.code === 'guest_quota_exhausted' || err.status === 429)) {
          setExhausted(true);
          setRemaining(0);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [turns, streaming, exhausted],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };
  const stop = () => abortRef.current?.abort();

  const quotaText = remaining === null ? '— free' : `${remaining}${limit ? ` / ${limit}` : ''} free`;

  return (
    <div className="lv2-chat" id="lv2-chat" aria-label="Try the network">
      <div className="lv2-chat-head">
        <span>
          <span className="lv2-dot" aria-hidden="true" />
          Live · {T.name} network
        </span>
        <span className="quota" aria-live="polite">
          {quotaText}
        </span>
      </div>

      <div className="lv2-chat-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions text">
        {turns.length === 0 ? (
          <div className="lv2-chat-empty">
            <p className="serif">
              Ask the network anything. <em>No key, no wallet.</em>
            </p>
            <div className="lv2-chips" aria-label="Suggested prompts">
              {PROMPTS.map((p) => (
                <button key={p} type="button" className="lv2-chip" onClick={() => void send(p)} disabled={streaming || exhausted || !enabled}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => {
            const isLast = i === turns.length - 1;
            const live = isLast && t.role === 'assistant' && streaming;
            return (
              <div className={`lv2-msg ${t.role}`} key={i}>
                <span className="who">{t.role === 'user' ? 'You' : T.name}</span>
                <div className="body">
                  {t.content}
                  {live ? <span className="lv2-caret" aria-hidden="true" /> : null}
                </div>
                {t.role === 'assistant' && t.result ? (
                  <span className="served">
                    served by {t.result.servedBy} · {(t.result.latencyMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {exhausted ? (
        <div className="lv2-chat-wall" role="status">
          <span>You&rsquo;ve used your free messages — connect a wallet to keep going.</span>
          <button type="button" className="lv2-btn sm solid" onClick={() => navigate('/app/chat')}>
            Open chat
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="lv2-chat-err" role="alert">
          {error}
        </p>
      ) : null}

      <form className="lv2-chat-form" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={exhausted ? 'Free messages used for today' : 'Ask the network… Enter to send'}
          aria-label="Message"
          disabled={exhausted || !enabled}
        />
        {streaming ? (
          <button type="button" className="lv2-btn sm" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="lv2-btn sm solid" disabled={!input.trim() || exhausted || !enabled}>
            Send
          </button>
        )}
      </form>
      <p className="lv2-chat-note">
        <span>
          {limit ?? 5} free messages, no sign-up — served by the {T.name} network.
        </span>
        <span className="lv2-mono">Shift+Enter for a new line</span>
      </p>
    </div>
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

/* ---------- page ---------- */

export function LandingV2() {
  useEditorialChrome();
  const { data: stats, loading, error } = useStats();
  const skel = loading && !stats;

  const focusChat = () => {
    const el = document.getElementById('lv2-chat');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => el?.querySelector('textarea')?.focus({ preventScroll: true }), 400);
  };

  return (
    <div className="lv2">
      {/* 1 · hero */}
      <section className="lv2-hero" aria-labelledby="lv2-h1">
        <div className="lv2-hero-copy">
          <p className="lv2-eyebrow">
            {T.name} · ${T.ticker} on {T.chain}
          </p>
          <h1 className="serif h1" id="lv2-h1">
            Trades fund it.
            <br />
            Macs serve it.
            <br />
            <em>Holders use it.</em>
          </h1>
          <p className="lv2-lede">
            Every swap of ${T.ticker} pays a {feePct} fee. Half becomes AI credits for holders each {epochWord}; the requests are answered privately
            by Macs in the network, and the people who run them are paid per million tokens.
          </p>
          <p className="lv2-hero-meta">
            <span>
              Fee <b>{feePct}</b>
            </span>
            <span>
              To holders <b>{holderPct}</b>
            </span>
            <span>
              Min hold <b>{minHold}</b>
            </span>
            <span>
              Price / M <b>{netPrice}</b>
            </span>
            <span>
              Node pay / M <b>{nodePay}</b>
            </span>
          </p>
        </div>
        <GuestChat />
      </section>

      {/* 2 · how the ecosystem works */}
      <section className="lv2-sec" aria-labelledby="lv2-how">
        <div className="lv2-sec-head">
          <p className="no">
            <span>01 — How the ecosystem works</span>
            <span>One loop, five parts</span>
          </p>
          <h2 className="serif h2" id="lv2-how">
            The fee goes round, <em>and comes back as answers.</em>
          </h2>
          <p className="sub">
            Nothing here is minted to pay anyone. Trading pays the holders, the holders pay the Macs, the Macs keep the network cheap enough to
            trade on.
          </p>
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
                    <b>{n.b}</b>
                  </p>
                  <p className="t">{n.t}</p>
                  <p className="c">{n.c}</p>
                </div>
              </div>
              {i < LOOP.length - 1 ? <Arrow /> : null}
            </div>
          ))}
          <p className="loop-return">
            <span className="serif" aria-hidden="true">
              ↺
            </span>
            <span>
              The treasury share that pays the Macs comes from the same fee, so every {epochWord} of trading funds the next {epochWord} of answers.
            </span>
          </p>
        </div>
      </section>

      {/* 3 · three pillars */}
      <section className="lv2-sec" aria-labelledby="lv2-ways">
        <div className="lv2-sec-head">
          <p className="no">
            <span>02 — Three ways in</span>
            <span>Pick one, or all three</span>
          </p>
          <h2 className="serif h2" id="lv2-ways">
            Use it, run it, <em>or hold it.</em>
          </h2>
          <p className="sub">Each role pays the others. You do not need a Mac to use the network, or to hold the token to run one.</p>
        </div>
        <div className="pillars">
          <article className="pillar">
            <span className="n">01</span>
            <h3 className="serif h3">Use it</h3>
            <ul>
              <li>Credits land in your wallet every {epochWord}, paid by trading fees.</li>
              <li>One OpenAI-compatible key: SDKs, editors, shell scripts, anything.</li>
              <li>Or just chat in the browser. {fmtInt(T.minHoldTokens)} {T.ticker} is the only ticket.</li>
            </ul>
            <Link className="arrow-link" to="/app/chat">
              Open the chat
            </Link>
          </article>
          <article className="pillar">
            <span className="n">02</span>
            <h3 className="serif h3">Run a Mac</h3>
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
            <span className="n">03</span>
            <h3 className="serif h3">Hold the token</h3>
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
      <section className="lv2-sec" aria-labelledby="lv2-why">
        <div className="lv2-sec-head">
          <p className="no">
            <span>03 — Why this is different</span>
            <span>Six plain statements</span>
          </p>
          <h2 className="serif h2" id="lv2-why">
            Real fees, real machines, <em>everything on the record.</em>
          </h2>
        </div>
        <div className="why">
          <div className="why-item">
            <span className="k">i · funding</span>
            <h3 className="serif h3">Credits are a share of real fees</h3>
            <p>
              Not an emission schedule. {holderPct} of every {feePct} fee is converted into AI credits each {epochWord}; when trading is quiet, so are
              the credits.
            </p>
          </div>
          <div className="why-item">
            <span className="k">ii · privacy</span>
            <h3 className="serif h3">Nodes never see who asked</h3>
            <p>
              Requests are served by independent Macs that receive only the model and the messages. Choose a tier per request: trusted, network, or a
              zero-data-retention upstream.
            </p>
          </div>
          <div className="why-item">
            <span className="k">iii · price</span>
            <h3 className="serif h3">A flat price per million tokens</h3>
            <p>{netPrice} per million tokens whenever a node serves you, instead of list pricing. Every reply says what it cost and who served it.</p>
          </div>
          <div className="why-item">
            <span className="k">iv · hardware</span>
            <h3 className="serif h3">Runs on machines people already own</h3>
            <p>The node app is one command on an Apple Silicon Mac. No racks, no procurement, no capital expenditure to recoup.</p>
          </div>
          <div className="why-item">
            <span className="k">v · audit</span>
            <h3 className="serif h3">Everything is auditable</h3>
            <p>
              Epochs, the weekly report and the treasury ledger are public. Anyone can check that the credits issued match the fees collected.
            </p>
          </div>
          <div className="why-item">
            <span className="k">vi · compatibility</span>
            <h3 className="serif h3">Works wherever an OpenAI key works</h3>
            <p>Point an existing client at the gateway and change nothing else. The same key, the same models, a different bill.</p>
          </div>
        </div>
      </section>

      {/* 5 · privacy strip */}
      <section className="lv2-sec" aria-labelledby="lv2-priv">
        <div className="privacy">
          <div className="left">
            <p className="lv2-eyebrow">04 — Privacy, stated plainly</p>
            <h2 className="serif h2" id="lv2-priv">
              You choose who <em>sees a prompt.</em>
            </h2>
            <p className="intro">
              Any machine that runs a model sees the prompt in plaintext while it runs. What {T.name} does is let you choose <i>which</i> machines,
              strip everything else from the job, and never keep the text anywhere. Pick a tier per request or per key.
            </p>
          </div>
          <ul className="tiers">
            <li>
              <span className="name">Trusted nodes</span>
              <span className="lv2-desc">
                Your own Macs, allowlisted operators, and gold-staked operators who signed the operator pledge. If none is online the request goes to
                the ZDR upstream, never to other nodes.
              </span>
              <span className="tag">default</span>
            </li>
            <li>
              <span className="name">Any network node</span>
              <span className="lv2-desc">Any online node. Cheapest; the operator could in principle inspect memory while serving you.</span>
              <span className="tag">cheapest</span>
            </li>
            <li>
              <span className="name">Upstream (ZDR)</span>
              <span className="lv2-desc">Skips the network for zero-data-retention providers only, at list price.</span>
              <span className="tag">list price</span>
            </li>
          </ul>
        </div>
      </section>

      {/* 6 · live numbers */}
      <section className="lv2-sec" aria-labelledby="lv2-nums">
        <div className="lv2-sec-head">
          <p className="no">
            <span>05 — Live numbers</span>
            <span className="lv2-num">{stats ? `updated ${new Date(stats.generatedAt * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          </p>
          <h2 className="serif h2" id="lv2-nums">
            The network, <em>as it stands.</em>
          </h2>
        </div>
        <div className="numbers">
          <Stat k="Fees collected" v={skel ? null : fmtUsd(stats?.totalFeesUsd ?? null, 0)} d="all time" />
          <Stat k="Credits issued" v={skel ? null : fmtUsd(stats?.creditsDistributedUsd ?? null, 0)} d={`${holderPct} of fees, every ${epochWord}`} />
          <Stat k="Requests" v={skel ? null : fmtCompact(stats?.requestsLast24h ?? null)} d="last 24 hours" />
          <Stat k="Nodes online" v={skel ? null : fmtInt(stats?.nodesOnline ?? null)} d="Macs serving right now" />
        </div>
        <p className="numbers-foot">
          <span>
            {error && !stats ? `Live numbers unavailable right now (${error}).` : `${fmtInt(stats?.epochsRun ?? null)} epochs run · ${fmtInt(stats?.holdersEligibleLastEpoch ?? null)} wallets credited last epoch`}
          </span>
          <Link to="/report">Weekly report</Link>
        </p>
      </section>

      {/* 7 · final CTA */}
      <section className="final" aria-labelledby="lv2-final">
        <h2 className="serif h1" id="lv2-final">
          Three doors. <em>Same room.</em>
        </h2>
        <div className="ctas">
          <button type="button" className="lv2-btn solid" onClick={focusChat}>
            Start chatting
          </button>
          <Link className="lv2-btn" to="/download">
            Run a node
          </Link>
          <Link className="lv2-btn" to="/docs">
            Read the docs
          </Link>
        </div>
        <p className="risk">
          Credits are a share of fees, not a promise: <Link to="/risk">read the risks</Link>. {T.name} stores no prompts and no replies; the machine
          that serves you sees your text, which is why you choose the tier.
        </p>
      </section>
    </div>
  );
}

function Stat({ k, v, d }: { k: string; v: string | null; d: string }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className="v">{v === null ? <span className="lv2-skel" aria-hidden="true" /> : v}</span>
      <span className="d">{d}</span>
    </div>
  );
}
