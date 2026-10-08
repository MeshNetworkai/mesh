import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { installOneLiner } from './Node';
import { Engines } from '../components/Engines';
import { Terminal } from '../components/ui';
import { NODE_REWARD_CEILING_PER_M, PUBLIC_API_URL, TOKENOMICS, frontierPriceWords, nodeRewardPerM, pctFromBps } from '../config';
import { ROADMAP, STATUS_LABEL, type RoadmapStatus } from '../content/roadmap';
import { getCatalogue } from '../lib/api';
import { fmtCompact, fmtCost, fmtInt, fmtUsd } from '../lib/format';
import { useStats } from '../lib/hooks';
import type { Catalogue, CatalogueModel } from '../lib/types';

/* ---------- every number below comes from config/tokenomics.json (never hardcoded) ---------- */
const T = TOKENOMICS;
const feePct = pctFromBps(T.tradeFeeBps);
const holderPct = pctFromBps(T.holderShareBps);
const treasuryPct = pctFromBps(T.treasuryShareBps);
const minHold = `${fmtInt(T.minHoldTokens)} ${T.ticker}`;
const netPrice = fmtCost(T.networkPricePerMTokens);
const nodePay = fmtCost(T.nodeRewardUsdPerMTokens);
const epochMin = Math.round(T.epochSeconds / 60);
const epochWord = T.epochSeconds === 3600 ? 'hour' : `${epochMin} minutes`;
const marketFee = pctFromBps(T.marketplace.feeBps);
const marketFeeToHolders = pctFromBps(T.marketplace.feeToHoldersBps);
const maxDiscount = pctFromBps(T.marketplace.maxDiscountBps);
const listingDays = Math.round(T.marketplace.listingTtlHours / 24);
const usageHolderPct = pctFromBps(T.usageShare.holderBps);
const usageTreasuryPct = pctFromBps(T.usageShare.treasuryBps);
const samplePct = `${Number((T.verification.sampleRate * 100).toFixed(1))}%`;
const STARTER = T.starterCredits;
const tokensPerDollar = `${fmtCompact(Math.round(1 / T.networkPricePerMTokens))}M`;
const EXPIRY = T.creditExpiry;
const expiryDays = `${fmtInt(EXPIRY.days)} days`;
const DIRECT = T.directSales;
const upstreamFee = pctFromBps(T.upstreamFeeBps);
const nodeCeiling = fmtCost(NODE_REWARD_CEILING_PER_M);
const nodeCeilingPct = pctFromBps(T.nodeRewardMaxShareBps);
const nodeFloorMarginPct = pctFromBps(10_000 - T.nodeRewardMaxShareBps);
/** What is left of the network price after the node is paid, per 1M tokens: unstaked, and at the reward ceiling. */
const netMargin = fmtCost(Math.round((T.networkPricePerMTokens - T.nodeRewardUsdPerMTokens) * 1e6) / 1e6);
const netMarginAtCeiling = fmtCost(Math.round((T.networkPricePerMTokens - NODE_REWARD_CEILING_PER_M) * 1e6) / 1e6);
const starterWho = STARTER.requireMinHold ? `a wallet that holds at least ${minHold}` : 'a wallet';
const SETTLE = T.marketplace.settlementSymbol;
const NODE_PAYOUT = T.nodePayout;
const payoutHold = NODE_PAYOUT.holdSeconds >= 3600 ? `${Math.round(NODE_PAYOUT.holdSeconds / 3600) === 1 ? 'an hour' : `${Math.round(NODE_PAYOUT.holdSeconds / 3600)} hours`}` : `${Math.round(NODE_PAYOUT.holdSeconds / 60)} minutes`;

const MODEL = 'meta-llama/llama-3.1-8b-instruct';

const SNIPPETS = {
  curl: `export OPENAI_BASE_URL=${PUBLIC_API_URL}/v1
export OPENAI_API_KEY=mesh_sk_...

curl $OPENAI_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Mesh-Privacy: trusted" \\
  -d '{
    "model": "${MODEL}",
    "messages": [{"role": "user", "content": "Summarise this clause."}],
    "stream": true
  }'

# every reply says how it was served:
#   x-mesh-route, x-mesh-privacy, x-mesh-served-by
# non-streamed replies also set x-mesh-cost-usd, x-mesh-balance-usd`,
  python: `from openai import OpenAI

client = OpenAI(
    base_url="${PUBLIC_API_URL}/v1",
    api_key="mesh_sk_...",
)

stream = client.chat.completions.create(
    model="${MODEL}",   # or a short alias: llama-3.1-8b
    messages=[{"role": "user", "content": "Summarise this clause."}],
    stream=True,
    stream_options={"include_usage": True},
    extra_headers={"X-Mesh-Privacy": "trusted"},  # optional
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
    if chunk.usage:
        print("\\ncost:", getattr(chunk.usage, "cost", None))`,
  js: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${PUBLIC_API_URL}/v1",
  apiKey: process.env.MESH_API_KEY, // mesh_sk_...
  defaultHeaders: { "X-Mesh-Privacy": "trusted" }, // optional
});

const stream = await client.chat.completions.create({
  model: "${MODEL}",
  messages: [{ role: "user", content: "Summarise this clause." }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  if (chunk.usage) console.log("\\ncost:", chunk.usage.cost);
}`,
};

const SELL_EXAMPLE = (() => {
  // $100 of credit at 30% off, the worked example in docs/MARKETPLACE.md, recomputed from config.
  const credits = 100;
  const discount = 0.3;
  const paid = credits * (1 - discount);
  const fee = paid * (T.marketplace.feeBps / 10000);
  const toHolders = fee * (T.marketplace.feeToHoldersBps / 10000);
  return { credits, discountPct: '30%', paid, fee, toHolders, toTreasury: fee - toHolders, seller: paid - fee };
})();

const STATUS_TONE: Record<RoadmapStatus, string> = { done: 'done', now: 'now', next: 'next', later: 'later', exploring: 'exploring' };

function price(p: { promptUsdPerM: number; completionUsdPerM: number }): string {
  return p.promptUsdPerM === p.completionUsdPerM ? `${fmtCost(p.promptUsdPerM)} flat` : `${fmtCost(p.promptUsdPerM)} / ${fmtCost(p.completionUsdPerM)}`;
}

/** The live catalogue (GET /v1/models) as four groups: network models, then frontier, fast and open upstream rows. */
function ModelTable({ cat, failed }: { cat: Catalogue | null; failed: boolean }) {
  const groups = useMemo(() => {
    const data = cat?.data ?? [];
    // A network model is listed under its full id and its short alias (same Ollama tag): one row, aliases in the code line.
    const seen = new Map<string, CatalogueModel & { aliases: string[] }>();
    for (const m of data.filter((r) => r.served !== 'upstream')) {
      const key = m.displayName;
      const prev = seen.get(key);
      if (!prev) seen.set(key, { ...m, aliases: [] });
      else if (m.id.includes('/') && !prev.id.includes('/')) seen.set(key, { ...m, aliases: [prev.id, ...prev.aliases] });
      else prev.aliases.push(m.id);
    }
    const network = [...seen.values()];
    const by = (tier: CatalogueModel['tier']) => data.filter((m) => m.served === 'upstream' && m.tier === tier);
    return [
      { name: 'On the network', note: `Macs first, upstream fallback · ${netPrice} per 1M tokens on a node`, rows: network },
      { name: 'Frontier', note: 'upstream, zero-data-retention providers only', rows: by('frontier') },
      { name: 'Fast', note: 'upstream, zero-data-retention providers only', rows: by('fast') },
      { name: 'Open weights, upstream', note: 'open models Mesh nodes do not run yet', rows: by('open') },
    ].filter((g) => g.rows.length);
  }, [cat]);

  if (failed) {
    return (
      <p className="small muted">
        The catalogue could not be loaded right now. <code>GET {PUBLIC_API_URL}/v1/models</code> is the source of truth; each row carries <code>served</code>,{' '}
        <code>listPrice</code>, <code>meshPrice</code> and <code>privacy</code>.
      </p>
    );
  }
  if (!cat) return <p className="small muted">Loading the catalogue from GET /v1/models…</p>;

  const upstreamNote =
    cat.pricing.upstreamDiscountBps > 0 ? `list minus ${pctFromBps(cat.pricing.upstreamDiscountBps)}` : cat.pricing.upstreamMarkupBps > 0 ? `list plus ${pctFromBps(cat.pricing.upstreamMarkupBps)}` : 'exactly list, no markup';

  return (
    <div className="stack sm">
      <div className="tblwrap">
        <table className="tbl small models" aria-label="Model catalogue">
          <thead>
            <tr>
              <th>Model</th>
              <th>Served by</th>
              <th className="num">List, per 1M in / out</th>
              <th className="num">On Mesh</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.name}>
                <tr className="group">
                  <td colSpan={4}>
                    <b>{g.name}</b> <span className="muted">· {g.note}</span>
                  </td>
                </tr>
                {g.rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span>{m.displayName}</span>
                      <br />
                      <code className="mono">{m.id}</code>
                      {'aliases' in m && (m as { aliases: string[] }).aliases.length ? <span className="muted"> or {(m as { aliases: string[] }).aliases.join(', ')}</span> : null}
                    </td>
                    <td className="muted">{m.served === 'upstream' ? 'upstream (ZDR)' : m.online > 0 ? `${m.online} node${m.online === 1 ? '' : 's'} online, upstream fallback` : 'upstream fallback until a node is online'}</td>
                    <td className="num muted">{price(m.listPrice)}</td>
                    <td className="num">{price(m.meshPrice)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Network rows bill the flat network price for prompt and reply together; upstream rows bill {upstreamNote}. Prices are OpenRouter list in USD per million tokens
        and are refreshed by script, so the table can lag a price change by a day.
      </p>
    </div>
  );
}


export function Docs() {
  const [tab, setTab] = useState<keyof typeof SNIPPETS>('curl');
  const { hash } = useLocation();
  const { data: stats } = useStats();
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [catFailed, setCatFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getCatalogue()
      .then((c) => !cancelled && setCat(c))
      .catch(() => !cancelled && setCatFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  // Engine 2: the gateway says whether the usage share is on. Off until it confirms (docs/PRICING.md §3).
  const usageOn = stats?.usageShareEnabled === true;
  // Upstream pricing as the catalogue reports it (the same numbers the prices in the table use), else /stats, else config.
  const discountBps = cat?.pricing.upstreamDiscountBps ?? stats?.upstreamDiscountBps ?? T.upstreamDiscountBps;
  const markupBps = cat?.pricing.upstreamMarkupBps ?? stats?.upstreamMarkupBps ?? T.upstreamMarkupBps;
  const frontierPrice = frontierPriceWords(markupBps, discountBps);
  // Net of what the upstream charges Mesh: what is left of the markup is the margin (negative = the treasury pays).
  const frontierMarginBps = (discountBps > 0 ? -discountBps : markupBps) - T.upstreamFeeBps;
  const expiryOn = stats ? stats.creditExpiryDays !== null && stats.creditExpiryDays !== undefined : EXPIRY.enabled;
  const reserve = stats?.reserve ?? null;

  useEffect(() => {
    if (!hash) return;
    const el = document.querySelector(hash);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [hash]);

  const FAQ: Array<[string, string | JSX.Element]> = [
    [
      'Coming from another credit gateway?',
      <>
        Keep your code. Change the base URL to <code>{PUBLIC_API_URL}/v1</code> and the key to a <code>mesh_sk_…</code> one; OpenRouter-style model ids work unchanged,
        streaming and the <code>usage</code> object are identical, and the only new thing is an optional <code>X-Mesh-Privacy</code> header. Snippets for curl, Python,
        Node, LangChain, the Vercel AI SDK and Cursor/Continue are in <Link to="/api#switch">Switch in a minute</Link>.
        {STARTER.enabled && STARTER.amountUsd > 0
          ? STARTER.requireMinHold
            ? ` If your wallet holds at least ${minHold}, its first sign-in is credited ${fmtUsd(STARTER.amountUsd)}.`
            : ` Your first sign-in is credited ${fmtUsd(STARTER.amountUsd)} so you can test before holding anything.`
          : ''}
        {DIRECT.enabled ? ` Holding nothing? Buy credits at face value from ${fmtUsd(DIRECT.minUsd, 0)} on the market page.` : ''}
      </>,
    ],
    [
      'Do I have to claim anything?',
      `No. At the top of every ${epochWord} the gateway looks at who held at least ${minHold} through the ${epochWord} and credits each wallet pro-rata. The credit shows up in your ledger with the epoch as its reference.`,
    ],
    [
      'What happens if trading stops?',
      <>
        Engine 1 pays nothing that {epochWord}: no trades, no fee, no fee credits. Credits already in your ledger still spend{expiryOn ? `, until they reach their ${expiryDays}` : ''}. Two things
        keep moving regardless: half of every marketplace fee is paid into the next pool whenever a sale happens, and the second engine pays in {usageHolderPct} of the margin on
        paid requests.{' '}
        {usageOn
          ? `It is on, but it is small: the margin is ${netMargin} per million tokens on a Mac and ${pctFromBps(Math.max(0, frontierMarginBps))} of list on frontier models, so it does not replace trading fees.`
          : 'It is switched off today.'}{' '}
        {DIRECT.enabled ? 'The gateway itself keeps working: anyone can buy credits at face value, so usage does not depend on the pool. ' : ''}
        Every epoch, including the empty ones, is on <Link to="/stats">the stats page</Link>.
      </>,
    ],
    [
      'What are credits worth?',
      `A credit dollar buys a dollar of inference at the catalogue price: frontier and fast models at ${frontierPrice}, and any model a Mac serves at ${netPrice} per million tokens, so the same dollar buys ${tokensPerDollar} tokens of an open model. Every reply shows what it cost and, on a node, what it saved versus list.`,
    ],
    [
      'Do credits expire?',
      expiryOn
        ? `Yes. Every credit lapses ${expiryDays} after it landed in your wallet, whatever its source: an hourly distribution, starter credit, credit bought on the marketplace or bought from Mesh. Requests always spend your oldest credit first, so regular use never loses anything. Your dashboard shows what lapses next and how much is inside its last 7 and 30 days. Listing credit for sale does not stop the clock; a buyer's credit starts a fresh ${expiryDays}.`
        : 'No. Credits do not expire while the service runs.',
    ],
    [
      'Can I withdraw credits?',
      `No. Credits are a licence to use the gateway, not money: they cannot be withdrawn or redeemed, and they only move between wallets through the marketplace${STARTER.transferable ? '' : ' (starter credit cannot be sold at all)'}. Proceeds from a sale land in a prepaid US-dollar balance, which can be withdrawn; during the beta the team processes withdrawals by hand.`,
    ],
    [
      'Can I get credits without holding the token?',
      DIRECT.enabled
        ? `Yes, two ways. Buy them from Mesh at face value: ${fmtUsd(1, 0)} from your prepaid balance buys ${fmtUsd(1, 0)} of credit, from ${fmtUsd(DIRECT.minUsd, 0)} to ${fmtUsd(DIRECT.maxUsd, 0)} a purchase. Or buy them below face value from a holder on the marketplace, when one is selling. Both spend on any model.`
        : 'Yes: buy them below face value from a holder on the marketplace, when one is selling.',
    ],
    [
      'What stands behind a credit?',
      <>
        The holder share of every fee sweep is swapped to a stablecoin on chain and sent to a credit-pool wallet that is separate from the treasury. Every {epochWord} the
        gateway reads that wallet and publishes its balance next to the credits owed on <Link to="/stats">the stats page</Link>, so anyone can check the coverage. It is a
        published number, not a guarantee and not a deposit: credits are still not redeemable for cash.{' '}
        {reserve?.source === 'chain' ? '' : 'Until the token launches there is nothing to read: fees are a test feed and no reserve is held.'}
      </>,
    ],
    [
      `Why is a frontier model ${frontierPrice}?`,
      T.upstreamFeeBps > 0 && markupBps > 0
        ? `Because that is what it costs. The upstream charges Mesh ${upstreamFee} on top of its list price when Mesh buys inference, so billing at list would make every frontier request a loss paid by the treasury. ${pctFromBps(markupBps)} covers that cost and leaves ${pctFromBps(Math.max(0, frontierMarginBps))} of list as margin, of which ${usageHolderPct} goes to the holder pool. Models a Mac serves are not affected: they stay at ${netPrice} per million tokens.`
        : `Frontier and fast models are billed at ${frontierPrice}; the catalogue shows both prices for every model.`,
    ],
    [
      'Which models can I use?',
      'Whatever GET /v1/models returns: the curated frontier, fast and open catalogue through zero-data-retention providers, plus the open models Macs in the network run, which also answer to short aliases. The catalogue above is that endpoint, live.',
    ],
    [
      'Is my prompt stored?',
      'The gateway logs the model, token counts, cost and latency of each request so it can bill you; it never stores the prompt or the reply. The node agent writes only job ids, counts and timings to its log and drops the text once the reply is sent. What we cannot change: the machine that runs the model has to see your prompt in plaintext while it runs. That is why there are privacy tiers.',
    ],
    [
      'What happens if I sell my tokens?',
      `Credits already in your ledger stay${EXPIRY.enabled ? ` until they reach their ${expiryDays}` : ''}. You stop receiving new ones from the first epoch where your time-weighted balance is below ${minHold}.`,
    ],
    ['Can I use several keys?', 'Yes. All keys spend from one balance. Each key can carry its own spend limit and default privacy tier. Revoke a key and requests using it fail immediately.'],
    [
      'Which chain is the token on?',
      'Robinhood Chain (an Arbitrum Orbit L2, chain id 4663). The team launches the token on launch day through the Pons launchpad; trading fees reach the gateway through our fee vault on that chain. Nothing about credits, keys, the marketplace or nodes depends on the chain.',
    ],
    [
      'Is there a free way to try it?',
      `Yes. The chat on the homepage answers ${fmtInt(T.guest.messagesPerDay)} messages a day per visitor with no wallet, served by the network and paid by the treasury${STARTER.enabled && STARTER.amountUsd > 0 ? `, and ${starterWho} is credited ${fmtUsd(STARTER.amountUsd)} on its first sign-in` : ''}.`,
    ],
  ];

  return (
    <div className="wrap docs">
      <section className="hero" style={{ paddingBlock: '32px 0' }}>
        <p className="eyebrow">Docs</p>
        <h1 className="display d-xl" style={{ fontSize: 'clamp(40px,7vw,88px)' }}>
          One key.
          <br />
          Any model.
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          {T.name} is an OpenAI-compatible gateway whose credits come from trading fees{usageOn ? ' and from usage' : ''}, served by Macs and by frontier providers.{' '}
          <span className="dim">This page covers how credits work, how to spend, sell, buy and earn them, and what is live.</span>
        </p>
        <div className="chips">
          <a className="chip" href="#credits">
            Credits
          </a>
          <a className="chip" href="#backing">
            Expiry and reserve
          </a>
          <a className="chip" href="#use">
            Using them
          </a>
          <a className="chip" href="#models">
            Models
          </a>
          <a className="chip" href="#market">
            Marketplace
          </a>
          <a className="chip" href="#run">
            Running a Mac
          </a>
          <a className="chip" href="#privacy">
            Privacy
          </a>
          <a className="chip" href="#staking">
            Staking
          </a>
          <a className="chip" href="#faq">
            FAQ
          </a>
          <a className="chip" href="#roadmap">
            Roadmap
          </a>
          <Link className="chip" to="/api">
            API reference
          </Link>
        </div>
      </section>

      <section id="what">
        <div className="sec-head">
          <p className="eyebrow">What Mesh is</p>
          <div className="stack">
            <h2>
              A token whose trading fees buy AI inference <span className="muted">for the people holding it.</span>
            </h2>
            <p>
              A {feePct} fee on every ${T.ticker} trade is swept once an {epochWord}. {holderPct} of it is split, pro rata, across every wallet holding at least {minHold}{' '}
              as credits denominated in US dollars; {treasuryPct} goes to the treasury, which pays the Macs. Holders spend credits through an OpenAI-compatible gateway with
              their own keys, on open models answered by Macs in the network for a flat {netPrice} per million tokens, or on Claude, GPT, Gemini, Grok, DeepSeek and more
              through zero-data-retention providers at {frontierPrice}. Credits nobody will use are sold on the marketplace{DIRECT.enabled ? ', and anyone can buy credits from Mesh at face value' : ''}
              .{expiryOn ? ` A credit lapses ${expiryDays} after it lands.` : ''} Credits are a share of fees, not a promise: an {epochWord} with no trades distributes nothing from
              fees, and the full epoch history is public.
            </p>
            <p>
              Mesh is in open beta. No invite is needed: connect a wallet and you are in. The token is launched by the team on launch day on Robinhood Chain; until
              that day the fee feed is a test harness and the credits it mints are beta credits under the same terms as everything else here.
            </p>
          </div>
        </div>
      </section>

      <section id="credits">
        <div className="sec-head">
          <p className="eyebrow">Credits</p>
          <div className="stack">
            <h2>
              Two engines, one hourly pool. <span className="muted">Pro-rata, nothing to claim.</span>
            </h2>
            <p>
              Every {epochWord} the gateway builds one pool and splits it across eligible wallets. Engine 1 is the trading fee and is always on. Engine 2 is a share of the
              margin Mesh makes on paid requests and marketplace sales; it is built, audited and {usageOn ? 'on' : 'switched off until the pricing decision'}. Both land in
              the same pool, both are split the same way.
            </p>
            <Engines usageShareOn={usageOn} upstreamDiscountBps={discountBps} upstreamMarkupBps={markupBps} />
            <div className="rows">
              <div className="bigrow">
                <span className="display d-l">{feePct}</span>
                <p className="desc">Fee on every ${T.ticker} trade, collected by the fee vault and swept each {epochWord}. Engine 1.</p>
                <span className="eyebrow">Trade fee</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{holderPct}</span>
                <p className="desc">Of collected fees becomes inference credits, one US dollar of credit per dollar of fee. The other {treasuryPct} funds the treasury.</p>
                <span className="eyebrow">To holders</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{usageHolderPct}</span>
                <p className="desc">
                  Of the margin on paid requests goes to the pool when engine 2 is on; {usageTreasuryPct} stays with the treasury. {usageOn ? 'On now.' : 'Built, off today.'}
                </p>
                <span className="eyebrow">Usage share</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{minHold}</span>
                <p className="desc">Minimum time-weighted balance through the {epochWord} to be credited. Below it, nothing; above it, pro rata.</p>
                <span className="eyebrow">Minimum hold</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{epochMin}m</span>
                <p className="desc">Epoch length. Distribution runs at the top of the {epochWord} and shows in your ledger as a “distribution” row with the epoch as its reference.</p>
                <span className="eyebrow">Epoch</span>
              </div>
            </div>
            <h3>How your share is worked out</h3>
            <ul>
              <li>
                <b>Time-weighted.</b> Your balance is averaged over the whole {epochWord}, not read at the top of it. Buying ten minutes before the epoch closes earns a sixth of a
                full {epochWord}; selling ten minutes after it opens keeps a sixth. Snapshot timing cannot be gamed.
              </li>
              <li>
                <b>Pro rata.</b> Your share = your eligible balance ÷ the sum of all eligible balances × the pool. Wallets below {minHold} are left out; the pool and contract
                wallets are excluded.
              </li>
              <li>
                <b>Exact.</b> The pool is split in integer micro-dollars with a deterministic remainder, so the credits issued always equal the fees collected. Check it on{' '}
                <Link to="/stats">the stats page</Link>.
              </li>
              <li>
                <b>Staking</b> multiplies a node operator's rewards and queue position, not the holder pool (see <a href="#staking">Staking</a>). A holding-age weighting exists
                in the gateway and is off.
              </li>
            </ul>
            {STARTER.enabled && STARTER.amountUsd > 0 ? (
              <>
                <h3>Starter credits</h3>
                <p>
                  The first time {starterWho} signs in it is credited {fmtUsd(STARTER.amountUsd)}, once per wallet{STARTER.maxWallets > 0 ? ` and for the first ${fmtInt(STARTER.maxWallets)} wallets` : ''}, as a
                  “starter” row in the ledger, so a new holder can create a key and send real requests in the first {epochWord}.{' '}
                  {STARTER.transferable
                    ? ''
                    : 'Starter credit can be spent on any model but cannot be listed on the marketplace; requests use it up first, so what you earn or buy stays sellable. '}
                  The grant is rate-limited per network address and can be paused; <code>GET /stats</code> shows how many are left.
                  {STARTER.requireMinHold && DIRECT.enabled ? ' A wallet that holds nothing can still try Mesh: the homepage chat is free, and credits can be bought at face value.' : ''}
                </p>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section id="backing">
        <div className="sec-head">
          <p className="eyebrow">Expiry and reserve</p>
          <div className="stack">
            <h2>
              What limits a credit, <span className="muted">and what stands behind it.</span>
            </h2>
            <div className="rows">
              {EXPIRY.enabled ? (
                <div className="bigrow">
                  <span className="display d-l">{fmtInt(EXPIRY.days)}d</span>
                  <p className="desc">A credit lapses this long after it lands, whatever its source. Requests spend the oldest credit first.</p>
                  <span className="eyebrow">Expiry</span>
                </div>
              ) : null}
              <div className="bigrow">
                <span className="display d-l">1 : 1</span>
                <p className="desc">
                  One dollar of credit per dollar of the holder share of fees, settled in a stablecoin and held apart from the treasury. Published every {epochWord}.
                </p>
                <span className="eyebrow">Reserve</span>
              </div>
              {DIRECT.enabled ? (
                <div className="bigrow">
                  <span className="display d-l">{fmtUsd(1, 0)}</span>
                  <p className="desc">
                    Buys {fmtUsd(1, 0)} of credit from Mesh, from {fmtUsd(DIRECT.minUsd, 0)} to {fmtUsd(DIRECT.maxUsd, 0)} a purchase, with no token and no seller needed.
                  </p>
                  <span className="eyebrow">Direct price</span>
                </div>
              ) : null}
            </div>
            {EXPIRY.enabled ? (
              <>
                <h3 id="expiry">Credits expire after {expiryDays}</h3>
                <ul>
                  <li>
                    <b>Every credit, one rule.</b> Hourly distributions, starter credit, credit bought on the marketplace and credit bought from Mesh all lapse {expiryDays}{' '}
                    after they land. The date is set when the credit arrives and nothing extends it.
                  </li>
                  <li>
                    <b>Oldest first.</b> A request always spends your oldest credit, so a wallet that uses its credits loses nothing. Only credit that sat unused for the whole{' '}
                    {expiryDays} lapses, as an “expiry” row in your ledger.
                  </li>
                  <li>
                    <b>You see it coming.</b> Your <Link to="/app">dashboard</Link> shows the next amount to lapse and its date, and how much of your balance is inside its last
                    7 and 30 days. <code>GET /me</code> returns the same under <code>expiry</code>.
                  </li>
                  <li>
                    <b>Listing does not stop the clock.</b> Credit in an open listing keeps ageing; if the listing is cancelled or runs out, what comes back has its original
                    date. Credit that sells starts a fresh {expiryDays} for the buyer.
                  </li>
                  <li>
                    <b>Why.</b> Credits are owed in dollars of inference. Without a limit, credit nobody uses would pile up as a debt that outlasts the fees that paid for it.
                    Lapsed credit lowers what the reserve has to cover.
                  </li>
                </ul>
              </>
            ) : null}
            <h3 id="reserve">The reserve</h3>
            <ul>
              <li>
                <b>Swapped at the sweep.</b> Trading fees arrive in ETH. Each {epochWord} the fee vault swaps them to a stablecoin on chain and splits the result: {holderPct} to
                the credit-pool wallet, {treasuryPct} to the treasury. Credits are minted against the dollars actually received, so the pool does not carry the ETH price.
              </li>
              <li>
                <b>Held apart.</b> The credit pool is its own wallet. It pays for the inference credits buy; it is not the treasury and does not fund operations.
                {DIRECT.enabled ? ' Payments for credits bought from Mesh back those credits the same way.' : ''}
              </li>
              <li>
                <b>Published.</b> After every epoch the gateway reads the pool's stablecoin balance and puts it next to the credits owed (spendable credit plus credit escrowed in
                open listings) on <Link to="/stats">the stats page</Link> and in <code>GET /report</code> under <code>totals.reserve</code>, with the coverage ratio and the time
                of the reading. Coverage below {pctFromBps(T.reserve.minCoverageBps)} is flagged as short.
              </li>
              <li>
                <b>What it is not.</b> A guarantee, a deposit or a redemption right. The wallet is controlled by the operator; the number tells you whether the credits
                outstanding are covered, and credits still cannot be turned back into cash.
              </li>
              <li>
                <b>Before the token launch</b> there is no reserve to read: fees come from a test feed, the report says <code>source: mock</code> and claims no coverage.
              </li>
            </ul>
            <h3 id="price-feed">When the price feed is stale</h3>
            <p>
              The swap needs a current ETH price to set its slippage floor. If the price feed is more than an hour old or cannot be read, the gateway leaves the ETH fees where
              they are, in the launchpad's escrow or our fee vault, and mints no credits for them that {epochWord}. Nothing is lost: the next epoch with a fresh price sweeps
              them, and they go to the holders of that {epochWord}. No credits are ever minted against a guessed price.
            </p>
          </div>
        </div>
      </section>

      <section id="use">
        <div className="sec-head">
          <p className="eyebrow">Using credits</p>
          <div className="stack">
            <h2>
              Chat here, or point any OpenAI client at Mesh. <span className="muted">Same request shape, same streaming, plus a cost line.</span>
            </h2>
            <ul>
              <li>
                <b>Chat.</b> <Link to="/app/chat">The chat page</Link> uses one of your keys, lets you pick any model and a privacy tier, and shows under every reply which
                tier served it, the model, what it cost, what it saved versus list and how long it took. No wallet? The homepage chat answers {fmtInt(T.guest.messagesPerDay)}{' '}
                messages a day for free.
              </li>
              <li>
                <b>Keys.</b> Create them under <Link to="/app/keys">Keys</Link>. A key is shown once. Each key can carry a name, a lifetime spend limit and a default privacy
                tier; all keys spend from the wallet's one balance. Revoke a key and requests using it fail immediately.
              </li>
              <li>
                <b>OpenAI compatibility.</b> Base URL <code>{PUBLIC_API_URL}/v1</code>, header <code>Authorization: Bearer mesh_sk_…</code>, endpoints{' '}
                <code>POST /v1/chat/completions</code> (stream or not) and <code>GET /v1/models</code>. The request body, SSE chunks, <code>[DONE]</code> and the{' '}
                <code>usage</code> object are what your client already expects, with <code>usage.cost</code> in USD added. Errors are OpenAI-shaped:{' '}
                <code>402 insufficient_quota</code> means your balance is zero{EXPIRY.enabled ? ' (credit past its date no longer counts)' : ''}, <code>429</code> is the per-key rate limit. Failed requests are never charged.
              </li>
              <li>
                <b>How it was served.</b> Every reply carries <code>x-mesh-route</code>, <code>x-mesh-privacy</code> and <code>x-mesh-served-by</code>; non-streamed replies add{' '}
                <code>x-mesh-cost-usd</code> and <code>x-mesh-balance-usd</code>. <code>usage.cost</code> is always what your wallet was charged, streamed or not. Node-served
                replies add <code>mesh.listCostUsd</code> and <code>mesh.savedUsd</code> next to <code>usage</code>; upstream replies add <code>mesh.listCostUsd</code>, the
                upstream's own list cost before the markup.
              </li>
              <li>
                Every endpoint, with request and response examples, is on the <Link to="/api">API reference</Link>; the raw OpenAPI 3.1 document is at{' '}
                <code>{PUBLIC_API_URL}/openapi.json</code>. Switching from another gateway is two string edits: <Link to="/api#switch">Switch in a minute</Link>.
              </li>
            </ul>
            <div className="tabs" role="tablist" aria-label="Language">
              {(Object.keys(SNIPPETS) as Array<keyof typeof SNIPPETS>).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {k === 'js' ? 'JavaScript' : k === 'python' ? 'Python' : 'curl'}
                </button>
              ))}
            </div>
            <Terminal code={SNIPPETS[tab]} label={`${tab} example`} />
          </div>
        </div>
      </section>

      <section id="models">
        <div className="sec-head">
          <p className="eyebrow">Models and prices</p>
          <div className="stack">
            <h2>
              Open models on Macs, frontier models upstream. <span className="muted">Two prices, both in the catalogue.</span>
            </h2>
            <div className="rows">
              <div className="bigrow">
                <span className="display d-l">{netPrice}</span>
                <p className="desc">
                  Per million tokens, prompt and reply together, whatever the model, when a Mac in the network answers. The Mac is paid {nodePay} per million, a staked one up
                  to {nodeCeiling}; the {netMarginAtCeiling} to {netMargin} left over is the margin the usage share splits.
                </p>
                <span className="eyebrow">Network price</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{discountBps > 0 ? `−${pctFromBps(discountBps)}` : markupBps > 0 ? `+${pctFromBps(markupBps)}` : 'list'}</span>
                <p className="desc">
                  Frontier and fast models (Claude, GPT, Gemini, Grok, DeepSeek, Kimi, Mistral and more) go to the upstream at {frontierPrice}, routed only to
                  zero-data-retention providers.{' '}
                  {T.upstreamFeeBps > 0
                    ? `The upstream charges Mesh ${upstreamFee} on top of list, so ${frontierMarginBps >= 0 ? `the markup covers that cost and ${pctFromBps(frontierMarginBps)} of list is margin` : 'the treasury funds the difference'}.`
                    : 'A discount, when one is set, is funded by the treasury.'}
                </p>
                <span className="eyebrow">Frontier price</span>
              </div>
            </div>
            <p>
              Routing is automatic. Ask for an open model the network runs and an idle, reputable Mac of the right privacy tier serves it at the network price; if none is
              online, or it fails before the first token, the request goes upstream and you pay the upstream price. The reply always says which path it took. Nothing to
              toggle.
            </p>
            <ModelTable cat={cat} failed={catFailed} />
          </div>
        </div>
      </section>

      <section id="market">
        <div className="sec-head">
          <p className="eyebrow">Marketplace</p>
          <div className="stack">
            <h2>
              Sell what you will not use. <span className="muted">Buy below face value.</span>
            </h2>
            <p>
              Credits never go on chain. What moves on chain is {SETTLE}: buyers pay for credits with it and sellers are paid in it.
            </p>
            <p>
              Holders{NODE_PAYOUT.enabled ? ' and node operators' : ''} who will not spend their credits list them at a discount of up to {maxDiscount}. Anyone buys them below face value and spends them on any model. Mesh
              keeps {marketFee} of the price; {marketFeeToHolders} of that fee goes into the next {epochWord}'s holder pool and the rest to the treasury. The book is public
              at <Link to="/app/market">the market page</Link>.
            </p>
            <div className="rows">
              <div className="bigrow">
                <span className="display d-l">{marketFee}</span>
                <p className="desc">Fee on every sale, paid by the seller. {marketFeeToHolders} of it to holders next {epochWord}, the rest to the treasury.</p>
                <span className="eyebrow">Fee</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">0–{maxDiscount}</span>
                <p className="desc">Discount range a seller can choose. Deeper than that would make a credit dollar worth more than a dollar of inference, which invites arbitrage.</p>
                <span className="eyebrow">Discount</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{listingDays}d</span>
                <p className="desc">A listing stays open this long, then whatever is left returns to the seller. Minimum listing {fmtUsd(T.marketplace.minListingUsd, 0)}; fills down to a cent.</p>
                <span className="eyebrow">Listing</span>
              </div>
            </div>
            <h3>How to sell</h3>
            <ul>
              <li>Pick an amount and a discount. The credit leaves your spendable balance at once and sits in escrow, so the gateway cannot serve requests against it.</li>
              {STARTER.transferable ? null : (
                <li>
                  <b>Starter credit cannot be listed.</b> Only credit you earned or bought is sellable; the market page shows how much that is. Requests use starter credit first.
                </li>
              )}
              {EXPIRY.enabled ? (
                <li>
                  <b>The {expiryDays} keep counting.</b> A listing does not pause expiry. If credit comes back from a cancelled or lapsed listing it has its original date, so
                  list credit while it still has time to sell.
                </li>
              ) : null}
              <li>Buyers take any part of the listing. Each fill pays you the discounted price minus the fee, into your prepaid US-dollar balance.</li>
              <li>Cancel any time, or let it expire after {listingDays} days; the remainder returns to your credits.</li>
              <li>Withdraw the prepaid balance from the market page. The amount leaves your balance when you ask; during the beta the team pays it out in {SETTLE} and marks it done.</li>
            </ul>
            <h3>How to buy</h3>
            <ul>
              <li>Choose a discount tier on the book, or quote an amount. You pay from your prepaid balance and the credits land in your ledger at face value, immediately.</li>
              <li>
                <b>Prepaid balance during the beta.</b> There is no on-chain checkout yet. The team tops up a buyer's prepaid balance after a hand-sent {SETTLE} payment, audited
                with a reference. Self-serve {SETTLE} checkout replaces this after the token launch (see <a href="#roadmap">Roadmap</a>).
              </li>
              <li>
                Bought credits spend like any other credit, on any model, under any privacy tier{EXPIRY.enabled ? `, and start a fresh ${expiryDays} when they land` : ''}.
              </li>
            </ul>
            {DIRECT.enabled ? (
              <>
                <h3 id="buy-direct">Or buy from Mesh at face value</h3>
                <p>
                  When nobody is selling, or you would rather not wait for a seller, buy credits from Mesh on <Link to="/app/market">the market page</Link>:{' '}
                  {fmtUsd(1, 0)} from your prepaid balance buys {fmtUsd(1, 0)} of credit, from {fmtUsd(DIRECT.minUsd, 0)} to {fmtUsd(DIRECT.maxUsd, 0)} a purchase, with no fee.
                  It needs no ${T.ticker} and no seller. The payment backs the credit in the reserve; Mesh earns only the ordinary margin when the credit is spent. A
                  marketplace listing is cheaper whenever one is open, because sellers price below face value.
                </p>
              </>
            ) : null}
            <h3>Worked example</h3>
            <p>
              {fmtUsd(SELL_EXAMPLE.credits, 0)} of credit listed at {SELL_EXAMPLE.discountPct} off: the buyer pays {fmtUsd(SELL_EXAMPLE.paid)} and receives{' '}
              {fmtUsd(SELL_EXAMPLE.credits, 0)} of credit. The fee is {fmtUsd(SELL_EXAMPLE.fee)}; the seller receives {fmtUsd(SELL_EXAMPLE.seller)};{' '}
              {fmtUsd(SELL_EXAMPLE.toHolders, 3)} goes to holders and {fmtUsd(SELL_EXAMPLE.toTreasury, 3)} to the treasury. Every step is integer micro-dollars and the pieces add
              up exactly; the ledger entries behind each trade are in <code>docs/MARKETPLACE.md</code> in the repo.
            </p>
          </div>
        </div>
      </section>

      <section id="run">
        <div className="sec-head">
          <p className="eyebrow">Running a Mac</p>
          <div className="stack">
            <h2>
              Leave a Mac open, <span className="muted">serve replies, earn.</span>
            </h2>
            <p>
              Any Apple Silicon Mac with 16 GB or more. The <code>mesh-node</code> agent talks to a local Ollama, pulls jobs from the gateway over HTTPS (no inbound ports),
              streams the reply back and keeps nothing. You earn {nodePay} per million tokens served, tracked per job; a staked node earns more, up to {nodeCeilingPct} of what
              the user paid for the job ({nodeCeiling} per million).
            </p>
            {NODE_PAYOUT.enabled ? (
              <>
                <h3 id="node-payouts">How you are paid</h3>
                <ul>
                  <li>
                    <b>In AI credits, every {epochWord}.</b> What your Macs earned is added to the credit balance of the wallet they are linked to, as a “Node rewards” row in
                    your ledger. Nothing is sent on chain and there is nothing to claim.
                  </li>
                  <li>
                    <b>After a short hold.</b> A reward is paid about {payoutHold} after its job, so a spot check can still withhold it. Amounts under{' '}
                    {fmtUsd(NODE_PAYOUT.minUsd)} wait and are paid together. A quarantined node is paid once an operator clears it.
                  </li>
                  <li>
                    <b>Spend them or sell them.</b> They are ordinary credits: use them on any model, or list them on <Link to="/app/market">the marketplace</Link> and
                    withdraw the proceeds in {SETTLE}. That is how a node operator turns earnings into money.{EXPIRY.enabled ? ` Like all credits they lapse after ${expiryDays} if unused.` : ''}
                  </li>
                </ul>
              </>
            ) : (
              <p>Earnings show as a US-dollar counter today.</p>
            )}
            <h3>Link, then install</h3>
            <ul>
              <li>
                <b>Link code.</b> On <Link to="/app/node">Run a node</Link>, click “Link a Mac”. Your wallet signs once, in the browser, and you get a one-time code that
                lasts 15 minutes. The Mac only ever sees the code; no key touches it.
              </li>
              <li>
                <b>Terminal.</b> One line, pasted on the Mac. It installs Ollama if it is missing, pulls a model that fits the RAM, registers the Mac with the code and starts
                a background service that survives reboots.
              </li>
              <li>
                <b>Homebrew.</b> <code>brew install meshnetworkai/tap/mesh-node</code>, then <code>mesh-node setup --link &lt;code&gt;</code>. Same agent, hash-pinned.
              </li>
              <li>
                <b>Menu-bar app.</b> Status next to the clock, earnings, pause and resume, link a Mac, check for updates. The beta build is unsigned and opens through System
                Settings → Privacy &amp; Security → Open Anyway; the SHA-256 is on <Link to="/download">Download for Mac</Link>.
              </li>
            </ul>
            <Terminal code={installOneLiner(null)} label="Install the node agent" wrap />
            <h3>Day to day</h3>
            <ul>
              <li>
                <code>mesh-node status</code> for uptime and earnings, <code>mesh-node pause</code> / <code>resume</code> (pause finishes the jobs it is running first),{' '}
                <code>mesh-node logs</code>, <code>mesh-node update</code> (checks daily, verifies the hash, swaps atomically, rolls back on failure),{' '}
                <code>mesh-node service uninstall</code> to remove it.
              </li>
              <li>
                <b>Several jobs at once.</b> A Mac with headroom can run jobs in parallel: set <code>maxParallel</code> in the agent config. Requests queue for a busy node for a
                few seconds before going upstream, so a node that is briefly full still gets the work.
              </li>
              <li>
                <b>Reputation.</b> Nodes below the success-rate threshold over their recent jobs stop receiving work until they recover. Jobs that fail before the first token are
                retried on another node, then fall back upstream; nothing is charged to the user and nothing is paid to the node.
              </li>
              <li>
                Live status for your wallet, per node, is on the <Link to="/app/node">Node tab</Link>: chip, RAM, models, uptime, jobs, earnings, verification state, pledge.
              </li>
            </ul>
            <h3 id="verification">Verification</h3>
            <p>
              {samplePct} of network jobs are re-run on a second node from the same anonymised payload and compared in memory; neither output is stored. A node whose answer does
              not hold up loses the reward for that job and its reputation drops; {T.verification.quarantineAfterMismatches} mismatches in a row quarantine it until an operator
              clears it. New nodes are checked more often until they have {fmtInt(T.verification.minJobsBeforeTrust)} clean jobs. A check never widens who can see a prompt: a
              trusted job is only re-checked by another trusted node or the ZDR upstream, and a job served by your own Mac is never re-checked anywhere.
            </p>
          </div>
        </div>
      </section>

      <section id="privacy">
        <div className="sec-head">
          <p className="eyebrow">Privacy tiers</p>
          <div className="stack">
            <h2>
              Pick who may see a prompt. <span className="muted">The honest version.</span>
            </h2>
            <p>
              Any machine that runs a model sees the prompt in plaintext while it runs; no software setting changes that. What Mesh does is let you choose <em>which</em>{' '}
              machines, strip everything else from the job, and never keep the text anywhere. Pick a tier per request with the <code>X-Mesh-Privacy</code> header (or{' '}
              <code>mesh.privacy</code> in the body), per key under <Link to="/app/keys">Keys</Link>, or leave the default: <b>{T.privacy.defaultTier}</b>.
            </p>
            <ul>
              <li>
                <b>Trusted nodes</b> (<code>trusted</code>) — your own Macs (nodes whose reward wallet is the wallet making the request), allowlisted operators, and operators with
                a {T.privacy.trustedMinStakeTier} stake who signed the operator pledge. If none is online the request goes to the ZDR upstream, never to other nodes.
              </li>
              <li>
                <b>Any network node</b> (<code>network</code>) — any online, reputable node. Cheapest; the operator could in principle inspect memory while serving you.
              </li>
              <li>
                <b>Upstream (ZDR)</b> (<code>upstream_zdr</code>) — skips the network for OpenRouter with <code>provider.data_collection = "deny"</code>: zero-data-retention
                providers only, at the upstream price.
              </li>
            </ul>
            <p>
              A node receives only <code>{'{jobId, model, messages, params, maxTokens, deadlineMs, attempt}'}</code>: no wallet, key, IP, user agent or request id, and messages
              reduced to role and text. Frontier models go upstream under any tier, with the ZDR flag set unless you explicitly chose <code>network</code>. Every reply says which
              tier served it in <code>x-mesh-privacy</code> and <code>mesh.servedBy</code>. Full threat model: <code>docs/PRIVACY.md</code> in the repo; what we log and keep:{' '}
              <Link to="/privacy">Privacy</Link>.
            </p>
          </div>
        </div>
      </section>

      <section id="staking">
        <div className="sec-head">
          <p className="eyebrow">Staking</p>
          <div className="stack">
            <h2>
              Lock tokens, <span className="muted">earn more per job and serve trusted requests.</span>
            </h2>
            <p>
              Staking is for node operators. Locking ${T.ticker} multiplies what your Macs earn per job and moves them to the front of the queue; the top tier plus the signed
              operator pledge makes a node <b>trusted</b>, so it can serve the default privacy tier for other people. The contract holds your tokens and nothing else; rewards
              are paid by the gateway. The staking contract is written and tested and goes live with the token: your tier shows on <Link to="/app/stake">Stake</Link> the moment
              the contract address lands in the deploy config.
            </p>
            <div className="tblwrap">
              <table className="tbl small" aria-label="Stake tiers">
                <thead>
                  <tr>
                    <th>Tier</th>
                    <th className="num">Minimum stake</th>
                    <th className="num">Lock</th>
                    <th className="num">Multiplier</th>
                    <th className="num">Earns, per 1M tokens</th>
                    <th>Trusted</th>
                  </tr>
                </thead>
                <tbody>
                  {T.stakeTiers.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name.charAt(0).toUpperCase() + t.name.slice(1)}</td>
                      <td className="num">{t.minStake === 0 ? '—' : `${fmtInt(t.minStake)} ${T.ticker}`}</td>
                      <td className="num">{t.lockDays ? `${t.lockDays} days` : 'none'}</td>
                      <td className="num">{t.multiplier}×</td>
                      <td className="num">
                        {fmtCost(nodeRewardPerM(t.multiplier))}
                        {T.nodeRewardUsdPerMTokens * t.multiplier > NODE_REWARD_CEILING_PER_M ? <span className="muted"> · ceiling</span> : null}
                      </td>
                      <td className="muted">{t.name === T.privacy.trustedMinStakeTier ? 'with the operator pledge' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              A job never pays its node more than {nodeCeilingPct} of what the user was billed, so every job leaves at least {nodeFloorMarginPct} for the margin and for
              spot-check re-runs. At {netPrice} per million that ceiling is {nodeCeiling}: a multiplier lifts the {nodePay} base rate up to it and no further. Where two tiers
              reach the ceiling they earn the same per job and differ by queue position and by whether the node can be trusted.
            </p>
          </div>
        </div>
      </section>

      <section id="stats">
        <div className="sec-head">
          <p className="eyebrow">The stats page</p>
          <div className="stack">
            <h2>
              Everything on the record, <span className="muted">down to the dollar.</span>
            </h2>
            <p>
              <Link to="/stats">The stats page</Link> is the public ledger: live network figures, every epoch with its fees, pool and eligible wallets (the empty ones
              too), the weekly report of fees in against credits out, the credit reserve against credits owed, credit that has lapsed, credits sold directly, the treasury
              ledger, marketplace fills and fees, and the usage share{usageOn ? '' : ' (reported as off)'}. It is computed from the same rows your dashboard uses. The raw data is public at <code>{PUBLIC_API_URL}/stats</code>,{' '}
              <code>/epochs</code>, <code>/report</code> and <code>/market/stats</code>; counts and dollar totals, never wallets, keys or prompts.
            </p>
          </div>
        </div>
      </section>

      <section id="faq">
        <div className="sec-head">
          <p className="eyebrow">FAQ</p>
          <div className="stack">
            <h2>Short answers.</h2>
            <div className="faq">
              {FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="risk">
        <div className="sec-head">
          <p className="eyebrow">Risk</p>
          <div className="stack">
            <h2>
              Credits are a share of fees, <span className="muted">not a promise.</span>
            </h2>
            <p>
              Fee credits exist only when people trade ${T.ticker}; the usage share exists only when it is switched on and there is a margin to share, and that margin is
              small. An {epochWord} with no trades and no sales is an {epochWord} with no distribution, and an {epochWord} with a stale price feed mints nothing until the feed
              is fresh. Credits are a licence to use the gateway, not money: they have no cash value, cannot be withdrawn,{' '}
              {EXPIRY.enabled ? `lapse ${expiryDays} after they land if unused, ` : ''}and leave your wallet only through the marketplace{STARTER.transferable ? '' : ' (starter credit not at all)'}
              . Marketplace fees are not refunded{DIRECT.enabled ? ', and neither are credits bought from Mesh' : ''}. The published reserve is a number you can check, not a
              guarantee or a right to redeem. The token can lose all its value. Nothing here is investment advice
              {T.geoBlock.length ? <>, and Mesh is not available to residents of {T.geoBlock.join(', ')}</> : null}.
            </p>
            <h3>Where it is still rough</h3>
            <p>
              One gateway, one database, one operator, in open beta. The token is not deployed yet, so fees come from a test feed, there is no reserve to publish and staking
              waits for the contract; node rewards are paid in credits, which turn into {SETTLE} only if a buyer takes them on the marketplace; prepaid balances, which pay for
              marketplace buys and direct purchases, are topped up and withdrawn by the team by hand. Unsigned Mac builds. We will say when
              these change, here and on the <a href="#roadmap">roadmap</a>.
            </p>
            <p>
              Full text: <Link to="/risk">Risk disclosure</Link> · <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>.
            </p>
          </div>
        </div>
      </section>

      <section id="roadmap">
        <div className="sec-head">
          <p className="eyebrow">Roadmap</p>
          <div className="stack">
            <h2>
              What is live, what is next. <span className="muted">No dates.</span>
            </h2>
            <p>
              Three phases. Items move between them as work lands; nothing below is a promise, and the token launch is the one event most of it waits for.
            </p>
            <div className="roadmap">
              {ROADMAP.map((phase) => (
                <div className="roadmap-phase" key={phase.id} id={`roadmap-${phase.id}`}>
                  <div className="roadmap-head">
                    <h3>{phase.name}</h3>
                    <p className="small">{phase.summary}</p>
                  </div>
                  <ul className="plain roadmap-items">
                    {phase.items.map((it) => (
                      <li key={it.title} className={`roadmap-item ${STATUS_TONE[it.status]}`}>
                        <span className="pill sm roadmap-status">
                          <span className="dot" aria-hidden="true" />
                          {STATUS_LABEL[it.status]}
                        </span>
                        <span className="roadmap-text">
                          <b>{it.title}</b>
                          <span className="muted">{it.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
