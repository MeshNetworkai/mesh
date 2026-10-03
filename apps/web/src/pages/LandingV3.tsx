import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkline } from '../components/Sparkline';
import { Terminal } from '../components/ui';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { ApiError, getGuestQuota, onGuestRemaining, streamGuestChat, type ChatMessage, type ChatResult } from '../lib/api';
import { fmtCompact, fmtCost, fmtInt, fmtUsd } from '../lib/format';
import { useStats } from '../lib/hooks';
import './landing-v3.css';

/* ---------- copy derived from config/tokenomics.json (nothing hardcoded) ---------- */
const T = TOKENOMICS;
const feePct = `${T.tradeFeeBps / 100}%`;
const holderPct = `${T.holderShareBps / 100}%`;
const treasuryPct = `${T.treasuryShareBps / 100}%`;
const minHold = `${fmtInt(T.minHoldTokens)} ${T.ticker}`;
const netPrice = fmtCost(T.networkPricePerMTokens);
const nodePay = fmtCost(T.nodeRewardUsdPerMTokens);
const epochMin = Math.round(T.epochSeconds / 60);
const epochWord = T.epochSeconds === 3600 ? 'hour' : `${epochMin} minutes`;
const epochAdj = T.epochSeconds === 3600 ? 'hourly' : `every ${epochMin} minutes`;

/** Recolours the shared nav/footer to the v3 palette while this page is mounted. */
function useProductChrome() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('lv3-root');
    return () => root.classList.remove('lv3-root');
  }, []);
}

/* ---------- icons (24px grid, 1.5px stroke) ---------- */
const I = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const Icon = {
  swap: (
    <svg {...I}>
      <path d="M4 7h13M14 3l4 4-4 4M20 17H7M10 13l-4 4 4 4" />
    </svg>
  ),
  fee: (
    <svg {...I}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01" />
    </svg>
  ),
  split: (
    <svg {...I}>
      <path d="M12 3v6M12 9l-6 5v4M12 9l6 5v4" />
      <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  key: (
    <svg {...I}>
      <circle cx="8" cy="14" r="4" />
      <path d="M11 11l9-7M17 7l2 2M14.5 9.5l2 2" />
    </svg>
  ),
  mac: (
    <svg {...I}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M3 13h18M9 20h6M12 16v4" />
    </svg>
  ),
  coins: (
    <svg {...I}>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.5" />
      <path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </svg>
  ),
  check: (
    <svg {...I} strokeWidth={2}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  ),
  arrowR: (
    <svg {...I}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  dot: (
    <svg viewBox="0 0 8 8" aria-hidden="true">
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  ),
};

/* ---------- hero chat: a product window ---------- */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  result?: ChatResult | null;
}

const PROMPTS = ['How does Mesh pay for itself?', 'How private is a request?', 'What does running a node earn?'];

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
        /* quota unknown until the first send */
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

  const freeLabel = remaining === null ? `${limit ?? '—'} free messages` : `${remaining}${limit ? `/${limit}` : ''} free messages`;

  return (
    <div className="lv3-win" id="lv3-chat" aria-label="Try the network">
      <div className="lv3-win-bar">
        <span className="lv3-win-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="lv3-win-title">
          {T.name} <span className="sep">·</span>{' '}
          <span className="lv3-mono" aria-live="polite">
            {freeLabel}
          </span>
        </span>
        <span className="lv3-win-live">
          <span className="lv3-pulse" aria-hidden="true" />
          live
        </span>
      </div>

      <div className="lv3-chat-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions text">
        {turns.length === 0 ? (
          <div className="lv3-chat-empty">
            <p>
              Ask anything. No key, no wallet — a Mac on the network answers, and it never learns who asked.
            </p>
            <div className="lv3-chips" aria-label="Suggested prompts">
              {PROMPTS.map((p) => (
                <button key={p} type="button" className="lv3-chip" onClick={() => void send(p)} disabled={streaming || exhausted || !enabled}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => {
            const live = i === turns.length - 1 && t.role === 'assistant' && streaming;
            return (
              <div className={`lv3-msg ${t.role}`} key={i}>
                <div className="lv3-bubble">
                  {t.content}
                  {live ? <span className="lv3-caret" aria-hidden="true" /> : null}
                </div>
                {t.role === 'assistant' && t.result ? (
                  <span className="lv3-served lv3-mono">
                    served by {t.result.servedBy} · {(t.result.latencyMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {exhausted ? (
        <div className="lv3-wall" role="status">
          <span>Free messages used — connect a wallet to keep going.</span>
          <button type="button" className="lv3-btn sm primary" onClick={() => navigate('/app/chat')}>
            Open chat
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="lv3-chat-err" role="alert">
          {error}
        </p>
      ) : null}

      <form className="lv3-chat-form" onSubmit={onSubmit}>
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={exhausted ? 'Free messages used for today' : 'Message the network…'}
          aria-label="Message"
          disabled={exhausted || !enabled}
        />
        {streaming ? (
          <button type="button" className="lv3-btn sm" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="lv3-btn sm primary" disabled={!input.trim() || exhausted || !enabled} aria-label="Send">
            Send
          </button>
        )}
      </form>
      <p className="lv3-chat-foot lv3-mono">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span>OpenAI-compatible</span>
      </p>
    </div>
  );
}

/* ---------- flow diagram ---------- */

const FLOW: Array<{ icon: ReactNode; k: string; title: string; line: string; tag?: string }> = [
  { icon: Icon.swap, k: 'Trade', title: `A trader swaps ${T.ticker}`, line: `On ${T.chain}, like any other token.` },
  { icon: Icon.fee, k: 'Fee', title: `${feePct} fee`, line: 'Collected by the protocol on every swap. The only funding source.', tag: feePct },
  {
    icon: Icon.split,
    k: 'Split',
    title: `${holderPct} credits · ${treasuryPct} treasury`,
    line: `${holderPct} becomes ${epochAdj} AI credits for every wallet holding ≥ ${minHold}, pro-rata. ${treasuryPct} funds the treasury.`,
    tag: `${holderPct}/${treasuryPct}`,
  },
  {
    icon: Icon.key,
    k: 'Use',
    title: 'Users & API keys',
    line: `Spend credits, or pay a flat ${netPrice} per million tokens. One key works in any OpenAI client.`,
    tag: `${netPrice}/M`,
  },
  { icon: Icon.mac, k: 'Serve', title: 'Macs running the node', line: 'Apple Silicon machines pick up the job. They receive the model and the messages — nothing about you.' },
  { icon: Icon.coins, k: 'Earn', title: `Node owners earn ${nodePay}/M`, line: 'Per million tokens served, tracked per job and paid from the treasury share.', tag: `${nodePay}/M` },
];

function FlowArrow() {
  return (
    <span className="lv3-flow-arrow" aria-hidden="true">
      <svg viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12h26M23 7l5 5-5 5" />
      </svg>
    </span>
  );
}

function Flow() {
  return (
    <div className="lv3-flow" role="list">
      {FLOW.map((n, i) => (
        <div key={n.k} className="lv3-flow-item">
          <article className="lv3-flow-card" role="listitem">
            <div className="lv3-flow-top">
              <span className="lv3-flow-ic">{n.icon}</span>
              <span className="lv3-flow-k lv3-mono">
                {String(i + 1).padStart(2, '0')} {n.k}
              </span>
            </div>
            <h3>{n.title}</h3>
            <p>{n.line}</p>
            {n.tag ? <span className="lv3-flow-tag lv3-mono">{n.tag}</span> : null}
          </article>
          {i < FLOW.length - 1 ? <FlowArrow /> : null}
        </div>
      ))}
      <div className="lv3-flow-return" aria-hidden="true">
        <span className="lv3-mono">treasury share pays node rewards</span>
        <i className="lv3-flow-return-head" />
      </div>
    </div>
  );
}

/* ---------- product cards' mock UI ---------- */

function MockKeyRow() {
  return (
    <div className="lv3-mock lv3-mock-key" aria-hidden="true">
      <div className="row head">
        <span>Key</span>
        <span>Price / M</span>
        <span>Status</span>
      </div>
      <div className="row">
        <span className="lv3-mono">mesh_sk_••••7f2a</span>
        <span className="lv3-mono">{netPrice}</span>
        <span className="pill ok">active</span>
      </div>
      <div className="row">
        <span className="lv3-mono">mesh_sk_••••c91e</span>
        <span className="lv3-mono">{netPrice}</span>
        <span className="pill">ZDR only</span>
      </div>
    </div>
  );
}

function MockMenubar({ nodes }: { nodes: number | null }) {
  return (
    <div className="lv3-mock lv3-mock-menu" aria-hidden="true">
      <div className="bar">
        <span className="lv3-mono">{T.name}</span>
        <span className="status">
          <span className="lv3-pulse" />
          Serving
        </span>
      </div>
      <div className="kv">
        <span>Jobs today</span>
        <b className="lv3-mono">128</b>
      </div>
      <div className="kv">
        <span>Earned today</span>
        <b className="lv3-mono">{fmtUsd(1.84)}</b>
      </div>
      <div className="kv">
        <span>Nodes online</span>
        <b className="lv3-mono">{nodes === null ? '—' : fmtInt(nodes)}</b>
      </div>
      <div className="foot">
        <span>Pause</span>
        <span>Open dashboard</span>
      </div>
    </div>
  );
}

const FALLBACK_SERIES = [0.6, 0.8, 0.7, 1.1, 1.0, 1.4, 1.2, 1.6, 1.5, 1.9, 1.7, 2.2].map((feesUsd) => ({ feesUsd }));

function MockCredits({ series, last }: { series: Array<{ feesUsd: number }>; last: string | null }) {
  return (
    <div className="lv3-mock lv3-mock-credits" aria-hidden="true">
      <div className="kv">
        <span>Credits this {epochWord}</span>
        <b className="lv3-mono">{last ?? '—'}</b>
      </div>
      <div className="plot">
        <Sparkline points={series} label={`${epochAdj} credits, last 24 hours`} />
      </div>
      <div className="kv small">
        <span>Holding ≥ {minHold}</span>
        <span className="lv3-mono">auto, nothing to claim</span>
      </div>
    </div>
  );
}

/* ---------- page ---------- */

export function LandingV3() {
  useProductChrome();
  const { data: stats, loading, error } = useStats();
  const skel = loading && !stats;
  const series = stats?.series24h?.length ? stats.series24h.map((p) => ({ feesUsd: p.creditsDistributedUsd })) : FALLBACK_SERIES;
  const lastCredit = stats?.series24h?.length ? fmtUsd(stats.series24h[stats.series24h.length - 1].creditsDistributedUsd) : null;

  const focusChat = () => {
    const el = document.getElementById('lv3-chat');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => el?.querySelector('textarea')?.focus({ preventScroll: true }), 350);
  };

  return (
    <div className="lv3">
      {/* 1 · hero */}
      <section className="lv3-hero" aria-labelledby="lv3-h1">
        <div className="lv3-hero-copy">
          <p className="lv3-eyebrow">
            <span className="lv3-pill">${T.ticker} on {T.chain}</span>
            <span className="lv3-mono">{feePct} swap fee · {holderPct} to holders</span>
          </p>
          <h1 id="lv3-h1">
            Private AI.
            <br />
            Paid for by trading, <span className="lv3-ac">served by Macs.</span>
          </h1>
          <p className="lv3-lede">
            Every ${T.ticker} swap pays a {feePct} fee. Half becomes AI credits for holders every {epochWord}; requests are answered by independent Macs that
            never learn who asked, and the people running them are paid per million tokens.
          </p>
          <div className="lv3-cta-row">
            <button type="button" className="lv3-btn primary lg" onClick={focusChat}>
              Start chatting
            </button>
            <Link className="lv3-btn lg" to="/download">
              Run a node
            </Link>
          </div>
          <p className="lv3-trust">
            <span>No sign-up</span>
            <span>Nodes never see who asked</span>
            <span>OpenAI-compatible</span>
          </p>
        </div>
        <GuestChat />
      </section>

      {/* 2 · how it fits together */}
      <section className="lv3-sec" aria-labelledby="lv3-how">
        <header className="lv3-sec-head">
          <p className="lv3-kicker lv3-mono">How it fits together</p>
          <h2 id="lv3-how">One fee funds the whole loop.</h2>
          <p>
            Nothing is minted to pay anyone. Trading pays the holders, holders and API keys pay for answers, Macs serve them, and the treasury pays the
            Macs — all from the same {feePct}.
          </p>
        </header>
        <Flow />
      </section>

      {/* 3 · three products */}
      <section className="lv3-sec" aria-labelledby="lv3-ways">
        <header className="lv3-sec-head">
          <p className="lv3-kicker lv3-mono">Three ways in</p>
          <h2 id="lv3-ways">Use it. Run it. Hold it.</h2>
          <p>Each role pays the others. You don&rsquo;t need a Mac to use the network, or the token to run one.</p>
        </header>
        <div className="lv3-products">
          <article className="lv3-card lv3-product">
            <MockKeyRow />
            <div className="body">
              <p className="lv3-kicker lv3-mono">Use</p>
              <h3>One key, any OpenAI client</h3>
              <p>
                Chat in the browser or point your SDK, editor or shell at the gateway. Spend credits, or pay {netPrice} per million tokens when a node
                serves you.
              </p>
              <Link className="lv3-link" to="/app/chat">
                Open the chat {Icon.arrowR}
              </Link>
            </div>
          </article>
          <article className="lv3-card lv3-product">
            <MockMenubar nodes={skel ? null : (stats?.nodesOnline ?? null)} />
            <div className="body">
              <p className="lv3-kicker lv3-mono">Run</p>
              <h3>Turn an idle Mac into income</h3>
              <p>
                One command or a menu-bar app on Apple Silicon. Earn {nodePay} per million tokens served, tracked per job. Pause whenever you like.
              </p>
              <Link className="lv3-link" to="/download">
                Download for Mac {Icon.arrowR}
              </Link>
            </div>
          </article>
          <article className="lv3-card lv3-product">
            <MockCredits series={series} last={lastCredit} />
            <div className="body">
              <p className="lv3-kicker lv3-mono">Hold</p>
              <h3>Credits land every {epochWord}</h3>
              <p>
                Hold {minHold} and {holderPct} of fees reaches your wallet as AI credits, pro-rata, every {epochWord}. Nothing to claim; every epoch is
                public.
              </p>
              <Link className="lv3-link" to="/docs">
                Read the docs {Icon.arrowR}
              </Link>
            </div>
          </article>
        </div>
      </section>

      {/* 4 · why it's different */}
      <section className="lv3-sec" aria-labelledby="lv3-why">
        <header className="lv3-sec-head">
          <p className="lv3-kicker lv3-mono">Why it&rsquo;s different</p>
          <h2 id="lv3-why">Real fees, real machines, everything on the record.</h2>
        </header>
        <ul className="lv3-why">
          {[
            ['Credits are a share of real fees', `${holderPct} of every ${feePct} fee becomes credits each ${epochWord}. Not an emission schedule: quiet trading means fewer credits, never invented ones.`],
            ['Nodes never see who asked', 'Served by independent Macs that receive only the model and the messages. Three privacy tiers per request: trusted, network, or a ZDR upstream.'],
            ['A flat per-million price', `${netPrice} per million tokens whenever a node serves you, instead of list price. Every reply says what it cost and who served it.`],
            ['Hardware people already own', 'One command or a download on an Apple Silicon Mac. No racks, no procurement, no capital to recoup.'],
            ['Everything auditable', 'Epochs, the weekly report and the treasury ledger are public. Anyone can check credits issued against fees collected.'],
            ['Works wherever an OpenAI key works', 'Change the base URL and the key. Same SDKs, same request shape, a different bill.'],
          ].map(([h, p]) => (
            <li key={h}>
              <span className="lv3-check">{Icon.check}</span>
              <div>
                <h3>{h}</h3>
                <p>{p}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 5 · live metrics */}
      <section className="lv3-sec" aria-labelledby="lv3-live">
        <header className="lv3-sec-head row">
          <div>
            <p className="lv3-kicker lv3-mono">Live</p>
            <h2 id="lv3-live">The network right now.</h2>
          </div>
          <span className="lv3-mono lv3-muted">
            {stats ? `updated ${new Date(stats.generatedAt * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : error ? 'unavailable' : 'loading…'}
          </span>
        </header>
        <div className="lv3-metrics">
          <Metric k="Fees collected" v={skel ? null : fmtUsd(stats?.totalFeesUsd ?? null, 0)} d="all time" />
          <Metric k="Credits issued" v={skel ? null : fmtUsd(stats?.creditsDistributedUsd ?? null, 0)} d={`${holderPct} of fees, ${epochAdj}`} />
          <Metric k="Requests" v={skel ? null : fmtCompact(stats?.requestsLast24h ?? null)} d="last 24 hours" />
          <Metric k="Nodes online" v={skel ? null : fmtInt(stats?.nodesOnline ?? null)} d="Macs serving now" />
        </div>
      </section>

      {/* 6 · developers */}
      <section className="lv3-sec" aria-labelledby="lv3-dev">
        <div className="lv3-dev">
          <div className="lv3-dev-copy">
            <p className="lv3-kicker lv3-mono">Developers</p>
            <h2 id="lv3-dev">Swap one URL.</h2>
            <p>The gateway speaks the OpenAI chat-completions API. Keep your client; change the base URL and the key.</p>
            <Link className="lv3-link" to="/api">
              API reference {Icon.arrowR}
            </Link>
          </div>
          <div className="lv3-dev-term">
            <Terminal
              label="curl example"
              code={`curl ${PUBLIC_API_URL}/v1/chat/completions \\\n  -H "Authorization: Bearer mesh_sk_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"meta-llama/llama-3.1-8b-instruct",\n       "messages":[{"role":"user","content":"hi"}]}'`}
            />
          </div>
        </div>
      </section>

      {/* 7 · footer CTA */}
      <section className="lv3-final" aria-labelledby="lv3-final-h">
        <h2 id="lv3-final-h">Try it before you trust it.</h2>
        <p>Free messages, no account. Then hold, run, or plug in a key.</p>
        <div className="lv3-cta-row center">
          <button type="button" className="lv3-btn primary lg" onClick={focusChat}>
            Start chatting
          </button>
          <Link className="lv3-btn lg" to="/download">
            Run a node
          </Link>
          <Link className="lv3-btn lg" to="/docs">
            Read the docs
          </Link>
        </div>
        <p className="lv3-risk">
          Credits are a share of fees, not a promise: <Link to="/risk">read the risks</Link>.
        </p>
      </section>
    </div>
  );
}

function Metric({ k, v, d }: { k: string; v: string | null; d: string }) {
  return (
    <div className="lv3-card lv3-metric">
      <span className="k">{k}</span>
      <span className="v lv3-mono">{v === null ? <span className="lv3-skel" aria-hidden="true" /> : v}</span>
      <span className="d">{d}</span>
    </div>
  );
}
