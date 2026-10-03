import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Readout } from '../components/Readout';
import { Skeleton, Terminal } from '../components/ui';
import { PUBLIC_API_URL, STORAGE, TOKENOMICS } from '../config';
import { useAuth } from '../lib/auth';
import { fmtCost, fmtInt } from '../lib/format';
import { useStats } from '../lib/hooks';
import { STAKING_TARGET } from '../lib/staking';
import { installOneLiner } from './Node';

const ROWS = [
  {
    word: 'Hold',
    desc: `Keep ${fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker} in your wallet and AI credits arrive every hour, paid for by trading fees. Nothing to claim, and the full epoch history is public.`,
    live: true,
    to: undefined as string | undefined,
  },
  {
    word: 'Ask',
    desc: `One API key for any model, wherever an OpenAI key works. When a Mesh node answers you pay a flat ${fmtCost(TOKENOMICS.networkPricePerMTokens)} per million tokens instead of list, and nothing is stored after the reply.`,
    live: true,
  },
  {
    word: 'Run',
    desc: `Leave your Mac open with Ollama and earn ${fmtCost(TOKENOMICS.nodeRewardUsdPerMTokens)} per million tokens it serves, tracked per job. One command to join, stop any time.`,
    live: true,
    to: '/app/node',
  },
  {
    word: 'Stake',
    desc: `Lock ${TOKENOMICS.ticker} to earn a bigger share and move your node to the front of the queue.`,
    // "Week 2" until the staking contract address is in the deploy json.
    live: STAKING_TARGET !== null,
    to: '/app/stake',
  },
];

export function Landing() {
  const { data: stats, loading, error } = useStats();
  const { session, openModal } = useAuth();
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
  const avgCost = stats && stats.requestsLast24h > 0 ? stats.spendLast24hUsd / stats.requestsLast24h : null;

  return (
    <div className="wrap">
      <section className="hero">
        <p className="eyebrow">
          {TOKENOMICS.name} · ${TOKENOMICS.ticker} · {TOKENOMICS.chain}
        </p>
        <h1 className="display d-xl">
          Trading pays for
          <br />
          private AI.
        </h1>
        <p className="eyebrow" style={{ letterSpacing: '.3em' }}>
          Hold · Earn · Ask · Own it
        </p>
        <p className="lede" style={{ textAlign: 'center' }}>
          Hold {fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker} and AI credits arrive every hour, paid for by trading fees.{' '}
          <span className="dim">
            One API key for any model. Requests for the open models run on Macs in the Mesh network, with nothing stored after the reply.
          </span>
        </p>
        <Readout stats={stats} loading={loading} />
        {error && !stats ? (
          <p className="small muted" role="status">
            Live numbers unavailable right now ({error}). Countdown runs from the configured epoch.
          </p>
        ) : null}
        <div className="chips">
          <Link className="chip" to="/app/chat">
            Chat
          </Link>
          <Link className="chip" to="/docs#use">
            Code
          </Link>
          <Link className="chip" to="/app/keys">
            API key
          </Link>
          <Link className="chip" to="/app/node">
            Run a node
          </Link>
        </div>
        <p className="muted small">
          Free to try with a connected wallet. Credits accrue every hour you hold {fmtInt(TOKENOMICS.minHoldTokens)} {TOKENOMICS.ticker}. Credits
          are a share of fees, not a promise: <Link to="/risk">read the risks</Link>.
        </p>
        {!session ? (
          <button className="btn primary" onClick={openModal}>
            Connect wallet
          </button>
        ) : (
          <Link className="btn primary" to="/app">
            Open dashboard
          </Link>
        )}
      </section>

      <section aria-labelledby="products">
        <div className="sec-head">
          <p className="eyebrow" id="products">
            What Mesh does
          </p>
          <h2 className="display d-m">
            Each product is one word. <span className="muted">Half of every trading fee becomes AI for the people holding the token.</span>
          </h2>
        </div>
        <div className="rows">
          {ROWS.map((r) => (
            <div className="bigrow" key={r.word}>
              {r.to ? (
                <Link className="display d-l rowlink" to={r.to}>
                  {r.word}
                </Link>
              ) : (
                <span className="display d-l">{r.word}</span>
              )}
              <p className="desc">
                {r.desc}
                {stats?.pointsEnabled && 'note' in r && typeof r.note === 'string' ? (
                  <>
                    <br />
                    <Link className="note" to="/leaderboard?board=points">
                      {r.note}
                    </Link>
                  </>
                ) : null}
              </p>
              <span className={`live${r.live ? '' : ' soon'}`}>
                <i aria-hidden="true" />
                {r.live ? 'Live' : 'Week 2'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Privacy statement">
        <div className="ink">
          <span className="glow" aria-hidden="true" />
          <p className="eyebrow">Privacy, stated plainly</p>
          <h2 className="display d-l">
            You choose who
            <br />
            sees a prompt.
          </h2>
          <p>
            The gateway strips every request down to the model and the messages before a node sees it: no wallet, key, IP or user agent.
            It never stores prompts or replies, and neither does the node agent. What no one can promise is that the machine running the
            model does not see your text: it has to. So you pick the tier per request. <b>Trusted</b> nodes have staked and signed the
            operator pledge; <b>any node</b> is cheapest; <b>upstream (ZDR)</b> skips the network for zero-data-retention providers. Every
            reply says which one answered.
          </p>
          <div className="stats">
            <div>
              <span className="eyebrow">Requests · 24h</span>
              <b>{loading && !stats ? <Skeleton w="5ch" /> : fmtInt(stats?.requestsLast24h ?? null)}</b>
            </div>
            <div>
              <span className="eyebrow">Avg cost / reply</span>
              <b>{loading && !stats ? <Skeleton w="6ch" /> : fmtCost(avgCost)}</b>
            </div>
            <div>
              <span className="eyebrow">Prompts stored by Mesh</span>
              <b>0</b>
            </div>
            <div>
              <span className="eyebrow">Nodes online</span>
              <b>{loading && !stats ? <Skeleton w="3ch" /> : fmtInt(stats?.nodesOnline ?? null)}</b>
            </div>
          </div>
        </div>
      </section>

      <section id="how" aria-labelledby="how-h">
        <div className="sec-head">
          <p className="eyebrow" id="how-h">
            How it works
          </p>
          <h2 className="display d-m">
            Three steps. <span className="muted">No card, no account, no prompt written to disk.</span>
          </h2>
        </div>
        <div className="steps">
          <div className="step">
            <span className="n">01 · HOLD</span>
            <h3 className="display d-s">Hold {fmtInt(TOKENOMICS.minHoldTokens)} {TOKENOMICS.ticker} through the hour</h3>
            <p>
              Every {TOKENOMICS.epochSeconds / 60} minutes the gateway sweeps trading fees, keeps {TOKENOMICS.holderShareBps / 100}% for
              holders and credits each eligible wallet pro-rata. Nothing to claim.
            </p>
            <Terminal
              label="Check your balance"
              code={`# sign in with your wallet, then\ncurl ${PUBLIC_API_URL}/me \\\n  -H "Authorization: Bearer $MESH_JWT"`}
            />
          </div>
          <div className="step">
            <span className="n">02 · ASK</span>
            <h3 className="display d-s">Point any OpenAI client at Mesh</h3>
            <p>Create a key in the app. It works wherever an OpenAI key works: SDKs, Cursor, shell scripts.</p>
            <Terminal
              label="Use your key"
              code={`export OPENAI_BASE_URL=${PUBLIC_API_URL}/v1\nexport OPENAI_API_KEY=mesh_sk_...\n\ncurl $OPENAI_BASE_URL/chat/completions \\\n  -H "Authorization: Bearer $OPENAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"meta-llama/llama-3.1-8b-instruct",\n       "messages":[{"role":"user","content":"hi"}]}'`}
            />
          </div>
          <div className="step" id="run">
            <span className="n">03 · RUN</span>
            <h3 className="display d-s">Serve answers from your Mac</h3>
            <p>
              One command installs the node agent, registers with the gateway and starts earning for the replies it serves. Credits now,{' '}
              {TOKENOMICS.ticker} once the token layer ships. <Link to="/app/node">Open the Node tab</Link> for your live status.
            </p>
            <Terminal label="Install the node agent" code={`# paste in Terminal (macOS, Apple Silicon); get <code> from Run a node -> Link a Mac\n${installOneLiner(null)}`} wrap />
          </div>
        </div>
      </section>
    </div>
  );
}
