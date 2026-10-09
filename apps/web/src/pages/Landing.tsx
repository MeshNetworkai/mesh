import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FLEET_PUBLIC } from '../content/flags';
import { Engines } from '../components/Engines';
import { GuestChat } from '../components/GuestChat';
import { Hero3D, hero3dEnabled } from '../components/Hero3D';
import { MarketDepthBook } from '../components/MarketDepth';
import { BetaPill } from '../components/Nav';
import { SpendCompare } from '../components/SpendCompare';
import { Terminal } from '../components/ui';
import { NODE_REWARD_CEILING_PER_M, PUBLIC_API_URL, STORAGE, TOKENOMICS, frontierPriceTag, frontierPriceWords, pctFromBps } from '../config';
import { fmtCompact, fmtCost, fmtInt, fmtUsd } from '../lib/format';
import { useStats } from '../lib/hooks';

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
/** Marketplace fee (docs/MARKETPLACE.md, config `marketplace.feeBps`); the live value is also on GET /market/config. */
const MARKET_FEE_PCT = pctFromBps(T.marketplace.feeBps);
const MAX_DISCOUNT_PCT = pctFromBps(T.marketplace.maxDiscountBps);
const EXPIRY_DAYS = T.creditExpiry.enabled ? `${fmtInt(T.creditExpiry.days)} days` : null;
const nodeCeiling = fmtCost(NODE_REWARD_CEILING_PER_M);


/* ---------- copy blocks ---------- */

/** Six points, written against the one-pager comparison without naming the other product. */
const WHY = (usageOn: boolean, frontierPrice: string) => [
  {
    k: 'Two engines',
    t: 'Two engines, not one',
    c: usageOn
      ? `Trading fees fund the hourly pool, and so does the margin on paid requests. Holders earn when people use the network, not only when they trade it.`
      : `Trading fees fund the hourly pool today. The second engine, a share of the margin on paid requests, is built and switched off.`,
  },
  {
    k: 'Cost',
    t: 'Credits are served by Macs, not bought from a cloud',
    c: `A dollar of credit spent on an open model buys ${fmtCompact(Math.round(1 / T.networkPricePerMTokens))}M tokens at ${netPrice} per million, answered by a Mac that is paid ${nodePay} (${nodeCeiling} at most when staked). The cost of that answer is the Mac, not a cloud invoice, and what is left over is the margin holders share.`,
  },
  {
    k: 'Market',
    t: 'Sell what you do not use',
    c: `List unused credit at any discount up to ${MAX_DISCOUNT_PCT}; buyers pay below face value and spend it on any model. The fee is ${MARKET_FEE_PCT}, half of it back to holders in the next ${epochWord}.`,
  },
  {
    k: 'Models',
    t: 'Frontier models and a cheaper open tier',
    c: `Claude, GPT, Gemini, Grok and DeepSeek through one key at ${frontierPrice}, which covers what the upstream charges us, routed only to zero-data-retention providers; Llama and Qwen on Macs for a flat ${netPrice} per million.`,
  },
  {
    k: 'Privacy',
    t: 'Nodes never see who asked',
    c: 'A Mac receives the model and the messages, nothing else. Three tiers per request: trusted, network, or upstream only. A sampled share of node answers is re-run elsewhere and compared.',
  },
  {
    k: 'Record',
    t: 'Everything on the record',
    c: 'Every epoch, the treasury ledger, marketplace fills and the usage share are public down to the dollar. Fees are settled in a stablecoin and the holder half is held apart as a reserve, published every hour next to the credits it backs.',
  },
];

const TIERS = [
  {
    name: 'Trusted nodes',
    desc: 'Your own Macs, allowlisted operators, and gold-staked operators who signed the operator pledge. If none is online the request goes to the ZDR upstream, never to other nodes.',
    tag: 'default',
  },
  { name: 'Any network node', desc: 'Any online node. Cheapest; the operator could in principle inspect memory while serving you.', tag: 'cheapest' },
  { name: 'Upstream (ZDR)', desc: `Skips the network for zero-data-retention providers only, at ${frontierPriceWords()}.`, tag: frontierPriceTag() },
];

const SWITCH_SNIPPET = `base_url = "${PUBLIC_API_URL}/v1"\napi_key  = "mesh_sk_…"   # from /app/keys`;

/* ---------- page ---------- */

const CHAT_ID = 'guest-chat';

export function Landing() {
  const { data: stats, error } = useStats();
  // Engine 2 (docs/PRICING.md): the gateway says whether the usage-revenue share is on. Off until it confirms.
  const usageOn = stats?.usageShareEnabled ?? TOKENOMICS.usageShare.enabled; // the gateway's live flag; the shipped config until it answers
  const discountBps = stats?.upstreamDiscountBps ?? T.upstreamDiscountBps;
  const markupBps = stats?.upstreamMarkupBps ?? T.upstreamMarkupBps;
  const frontierPrice = frontierPriceWords(markupBps, discountBps);
  const frontierPhrase = discountBps > 0 ? `frontier models ${discountBps / 100}% below list` : 'frontier models through zero-data-retention providers';
  const directOn = stats?.directSalesEnabled ?? T.directSales.enabled;
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

  // Quiet scroll reveal: sections fade up once, 12px, 600ms. Off under prefers-reduced-motion (CSS).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.wrap > section:not(.home-hero), .wrap > .spend'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    els.forEach((el) => el.classList.add('reveal'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    els.forEach((el) => io.observe(el));
    // Belt and braces: whatever has not revealed after a few seconds (odd embeds, print) shows anyway.
    const all = window.setTimeout(() => els.forEach((el) => el.classList.add('in')), 4000);
    return () => {
      io.disconnect();
      window.clearTimeout(all);
    };
  }, []);

  const focusChat = () => {
    const el = document.getElementById(CHAT_ID);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => el?.querySelector('textarea')?.focus({ preventScroll: true }), 400);
  };

  return (
    <div className="wrap">
      {/* 1 · hero: one centred column; the live chat is the object, wide, with the model picker visible */}
      <section className="hero home-hero" aria-labelledby="hero-h1">
        {hero3dEnabled() ? <Hero3D /> : null}
        <div className="home-hero-copy">
          <p className="eyebrow">
            {T.name} · ${T.ticker}
            <BetaPill />
          </p>
          <h1 className="display home-h1" id="hero-h1">
            Trades fund it.
            <br />
            Macs serve it.
            <br />
            <em>Holders earn it.</em>
          </h1>
          <p className="lede">
            Hold {minHold} and AI credits land in your wallet every {epochWord}, paid from the {feePct} trading fee
            {usageOn ? ' and a share of paid usage' : ''}. Spend them on open models served by Macs in the network or on {frontierPhrase} — or sell what you do not use.
            {EXPIRY_DAYS ? ` Credits last ${EXPIRY_DAYS}.` : ''}
          </p>
        </div>
        <GuestChat id={CHAT_ID} />
        <div className="tiles dense home-figures" aria-label="Key figures">
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
            <span className="l">Network price</span>
            <span className="n">{netPrice}</span>
            <span className="d">per million tokens on a Mac</span>
          </div>
          <div className="tile">
            <span className="l">Node pay</span>
            <span className="n">{nodePay}</span>
            <span className="d">per million tokens served</span>
          </div>
          <div className="tile">
            <span className="l">Marketplace fee</span>
            <span className="n">{MARKET_FEE_PCT}</span>
            <span className="d">half of it back to holders</span>
          </div>
        </div>
      </section>

      {/* 1b · the price comparison, straight from the catalogue */}
      <SpendCompare />

      {/* 2 · how the money moves */}
      <section aria-labelledby="how-h">
        <div className="sec-head">
          <p className="eyebrow" id="how-h">
            How the money moves
          </p>
          <div className="stack sm">
            <h2 className="display d-m">
              Two engines, one hourly pool.
            </h2>
            <p className="sub">
              Trading pays a {feePct} fee; {holderPct} becomes credits for holders every {epochWord}, {treasuryPct} goes to the treasury. Paid requests and marketplace sales leave a
              margin{usageOn ? ', and a share of it joins the same pool' : '; the holder share of it is switched off'}. The treasury pays the Macs. Fees are swapped to a
              stablecoin as they are swept, and the holder half is kept apart as the reserve behind the credits.
            </p>
          </div>
        </div>
        <Engines usageShareOn={usageOn} upstreamDiscountBps={discountBps} upstreamMarkupBps={markupBps} />
        <p className="engines-note">
          Nothing is minted to pay anyone. <Link to="/docs#backing">How credits are backed, and when they expire</Link>
        </p>
      </section>

      {/* 3 · four ways in */}
      <section aria-labelledby="ways-h">
        <div className="sec-head">
          <p className="eyebrow" id="ways-h">
            Four ways in
          </p>
          <div className="stack sm">
            <h2 className="display d-m">
              Use it, sell it, run it, or hold it.
            </h2>
            <p className="sub">Each role pays the others. You do not need a Mac to use the network, a wallet to try it, or the token to run a node.</p>
          </div>
        </div>
        <div className="pillars four">
          <article className="pillar">
            <span className="display d-l n">01</span>
            <h3 className="display d-s">Use it</h3>
            <ul>
              <li>Credits land in your wallet every {epochWord}, paid by trading fees.</li>
              <li>One OpenAI-compatible key: SDKs, editors, shell scripts, anything.</li>
              <li>Or just chat in the browser. {minHold} is the ticket{directOn ? '; without it, buy credits at face value' : ''}.</li>
              {EXPIRY_DAYS ? <li>Credits last {EXPIRY_DAYS} from the day they land. The oldest are spent first.</li> : null}
            </ul>
            <Link className="arrow-link" to="/app/chat">
              Open the chat
            </Link>
          </article>
          <article className="pillar">
            <span className="display d-l n">02</span>
            <h3 className="display d-s">Sell what you don't use</h3>
            <ul>
              <li>List unused credit at a discount; buyers get it below face value.{T.starterCredits.transferable ? '' : ' Starter credit is for spending, not selling.'}</li>
              <li>{MARKET_FEE_PCT} fee on the sale, half of it back to holders next {epochWord}.</li>
            </ul>
            <MarketDepthBook />
            <Link className="arrow-link" to="/app/market">
              Open the market
            </Link>
          </article>
          <article className="pillar">
            <span className="display d-l n">03</span>
            <h3 className="display d-s">Run a Mac</h3>
            <ul>
              <li>Leave an Apple Silicon Mac open. One command, or the menu-bar app.</li>
              <li>Earn {nodePay} per million tokens served, tracked per job; up to {nodeCeiling} when staked.</li>
              {T.nodePayout.enabled ? <li>Paid every {epochWord} in credits: spend them, or sell them for {T.marketplace.settlementSymbol}.</li> : null}
              <li>Pause any time. Nothing about the person asking reaches your machine.</li>
            </ul>
            <Link className="arrow-link" to="/app/node">
              Run a node
            </Link>
          </article>
          <article className="pillar">
            <span className="display d-l n">04</span>
            <h3 className="display d-s">Hold the token</h3>
            <ul>
              <li>Hold {minHold} and credits drop every {epochWord}. Nothing to claim.</li>
              <li>{usageOn ? 'Fees and the usage share, pro-rata, down to the wallet.' : 'The full epoch history is public, down to the wallet.'}</li>
              <li>Stake for a bigger share when staking is live.</li>
            </ul>
            <Link className="arrow-link" to="/docs">
              Read the docs
            </Link>
          </article>
        </div>
      </section>

      {/* 4 · why it's different */}
      <section aria-labelledby="why-h">
        <div className="sec-head">
          <p className="eyebrow" id="why-h">
            Why it's different
          </p>
          <div className="stack sm">
            <h2 className="display d-m">Real fees. Real margins. Real machines.</h2>
            <p className="sub">Everything on the record, down to the wallet.</p>
          </div>
        </div>
        <div className="why">
          {WHY(usageOn, frontierPrice).map((w) => (
            <div className="why-item" key={w.k}>
              <h3 className="display d-s">{w.t}</h3>
              <p>
                {w.c}
                {w.k === 'Record' ? (
                  <>
                    {' '}
                    <Link to="/stats">See the stats</Link>.
                  </>
                ) : null}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 5 · switch in a minute */}
      <section aria-labelledby="switch-h" className="switch-strip">
        <div className="switch-copy">
          <p className="eyebrow" id="switch-h">
            Switch in a minute
          </p>
          <h2 className="display d-m">
            Change two strings. Keep your code.
          </h2>
          <p className="sub">
            Point any OpenAI-compatible client at the gateway and swap the key. Model ids are unchanged; <code className="mono">GET /v1/models</code> lists the catalogue with the
            Mesh price next to list.
          </p>
          <Link className="arrow-link" to="/api#switch">
            Snippets for curl, Python, Node, Cursor and more
          </Link>
        </div>
        <Terminal code={SWITCH_SNIPPET} label="Base URL and key" wrap />
      </section>

      {/* 6 · privacy */}
      <section aria-labelledby="priv-h">
        <div className="ink privacy">
          <span className="glow" aria-hidden="true" />
          <div className="privacy-copy">
            <p className="eyebrow">Privacy, stated plainly</p>
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

      {/* 7 · live line: a single row, the full ledger lives on /stats */}
      <section aria-labelledby="nums-h" className="liveline">
        <p className="eyebrow" id="nums-h">
          Live
        </p>
        <p className="liveline-row" role={error && !stats ? 'status' : undefined}>
          {error && !stats ? (
            <span className="muted">Live stats unavailable right now.</span>
          ) : (
            <>
              {FLEET_PUBLIC ? (
                <span>
                  <b className="num">{fmtInt(stats?.nodesOnline ?? null)}</b> Macs online
                </span>
              ) : null}
              <span>
                <b className="num">{fmtCompact(stats?.requestsLast24h ?? null)}</b> requests in 24h
              </span>
              {/* Fees and credits appear once the first real sweep has happened; "$0" before launch says nothing. */}
              {(stats?.totalFeesUsd ?? 0) > 0 ? (
                <span>
                  <b className="num">{fmtUsd(stats?.totalFeesUsd ?? null, 0)}</b> fees collected
                </span>
              ) : null}
              {(stats?.creditsDistributedUsd ?? 0) > 0 ? (
                <span>
                  <b className="num">{fmtUsd(stats?.creditsDistributedUsd ?? null, 0)}</b> credits issued
                </span>
              ) : null}
            </>
          )}
          <Link className="arrow-link" to="/stats">
            All the stats
          </Link>
        </p>
      </section>

      {/* 8 · final CTA */}
      <section className="final" aria-labelledby="final-h">
        <div className="final-row">
          <div className="stack">
            <h2 className="display d-l" id="final-h">
              Try it in a minute.
            </h2>
            <p className="sub">Five free messages a day, no wallet. Hold {minHold} for the hourly credits, or run a Mac and get paid for the answers it serves.</p>
          </div>
          <div className="row">
            <button type="button" className="btn primary" onClick={focusChat}>
              Start chatting
            </button>
            <Link className="btn secondary" to="/app/node">
              Run a node
            </Link>
            <Link className="btn ghost" to="/docs">
              Read the docs
            </Link>
          </div>
        </div>
        <p className="risk small muted">
          Credits are a share of fees, not a promise: <Link to="/risk">read the risks</Link>. {T.name} stores no prompts and no replies; the machine
          that serves you sees your text, which is why you choose the tier.
        </p>
      </section>
    </div>
  );
}
