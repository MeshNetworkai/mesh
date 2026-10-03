import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { installOneLiner } from './Node';
import { Terminal } from '../components/ui';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { fmtCost, fmtInt } from '../lib/format';

const MODEL = 'meta-llama/llama-3.1-8b-instruct';

const SNIPPETS = {
  curl: `export OPENAI_BASE_URL=${PUBLIC_API_URL}/v1
export OPENAI_API_KEY=mesh_sk_...

curl $OPENAI_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL}",
    "messages": [{"role": "user", "content": "Summarise this clause."}],
    "stream": true
  }'

# response headers on non-streamed calls:
#   x-mesh-cost-usd, x-mesh-balance-usd`,
  python: `from openai import OpenAI

client = OpenAI(
    base_url="${PUBLIC_API_URL}/v1",
    api_key="mesh_sk_...",
)

stream = client.chat.completions.create(
    model="${MODEL}",
    messages=[{"role": "user", "content": "Summarise this clause."}],
    stream=True,
    stream_options={"include_usage": True},
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
  dangerouslyAllowBrowser: false,
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

const FAQ: Array<[string, string]> = [
  [
    'Do I have to claim anything?',
    `No. At the top of every hour the gateway looks at who held at least ${fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker} and credits each wallet pro-rata. The credit shows up in your ledger with the epoch as its reference.`,
  ],
  [
    'What are credits worth?',
    'One credit dollar buys one dollar of inference at the upstream price, with no markup today. When a Mesh node serves the request you pay the flat network price instead, so the same dollar goes further. Every reply shows what it cost (and what it saved versus list) under the message, and the same figure is subtracted from your ledger.',
  ],
  ['Do credits expire?', 'Not while your account is active. They are not transferable and cannot be withdrawn; they are only spendable on inference.'],
  [
    'Which models can I use?',
    'Whatever GET /v1/models returns for your key: the OpenRouter catalogue filtered by the model policy, plus the open models served by Macs in the network (marked mesh_network: true). Those are the ones billed at the flat network price.',
  ],
  [
    'Is my prompt stored?',
    'The gateway logs the model, token counts, cost and latency of each request so it can bill you; it never stores the prompt or the reply. The node agent writes only job ids, counts and timings to its log and drops the text once the reply is sent. What we cannot change: the machine that runs the model has to see your prompt in plaintext while it runs. That is why there are privacy tiers (see "Privacy tiers" above).',
  ],
  [
    'What happens if I sell?',
    `Credits already in your ledger stay. You stop receiving new ones from the first epoch where your balance is below ${fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker}.`,
  ],
  ['Can I use several keys?', 'Yes. All keys spend from one balance. Revoke a key and requests using it fail immediately.'],
];

export function Docs() {
  const [tab, setTab] = useState<keyof typeof SNIPPETS>('curl');
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.querySelector(hash);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [hash]);

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
          Mesh is an OpenAI-compatible gateway paid for by trading fees. <span className="dim">This page covers how credits work, how to use your key and what to expect.</span>
        </p>
        <div className="chips">
          <a className="chip" href="#credits">
            Credits
          </a>
          <a className="chip" href="#use">
            Using your key
          </a>
          <a className="chip" href="#run">
            Running a node
          </a>
          <a className="chip" href="#privacy">
            Privacy tiers
          </a>
          <a className="chip" href="#faq">
            FAQ
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
              A {TOKENOMICS.tradeFeeBps / 100}% fee on every ${TOKENOMICS.ticker} trade is swept once an hour; half goes to the network treasury
              and half is split, pro rata, across every wallet holding at least {fmtInt(TOKENOMICS.minHoldTokens)} tokens as credits denominated
              in US dollars. Holders spend those credits through an OpenAI-compatible gateway with their own API keys. Requests for the supported
              open models are served by Macs running Ollama inside the Mesh network, which earn a share of the price per token; everything else
              is routed to OpenRouter at cost. Credits are a share of fees, not a promise: an hour with no trades distributes nothing, and the
              full epoch history is public.
            </p>
          </div>
        </div>
      </section>

      <section id="credits">
        <div className="sec-head">
          <p className="eyebrow">Credits</p>
          <div className="stack">
            <h2>
              Half of every fee becomes AI. <span className="muted">Every hour, pro-rata, nothing to claim.</span>
            </h2>
            <div className="rows">
              <div className="bigrow">
                <span className="display d-l">{TOKENOMICS.tradeFeeBps / 100}%</span>
                <p className="desc">Fee on every ${TOKENOMICS.ticker} trade, collected by the fee vault on {TOKENOMICS.chain}.</p>
                <span className="eyebrow">Trade fee</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{TOKENOMICS.holderShareBps / 100}%</span>
                <p className="desc">
                  Of collected fees is converted to inference credits and split across wallets holding ≥ {fmtInt(TOKENOMICS.minHoldTokens)}{' '}
                  {TOKENOMICS.ticker} through the hour. The rest funds the treasury.
                </p>
                <span className="eyebrow">To holders</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">{TOKENOMICS.epochSeconds / 60}m</span>
                <p className="desc">Epoch length. Distribution runs at the top of the hour and shows in your ledger as a “distribution” row.</p>
                <span className="eyebrow">Epoch</span>
              </div>
            </div>
            <p>
              Your share of an epoch = your eligible balance ÷ sum of all eligible balances × holder pool. Staking tiers (week 2) multiply your
              weight: {TOKENOMICS.stakeTiers.map((t) => `${t.name} ${t.multiplier}×`).join(', ')}.
            </p>
          </div>
        </div>
      </section>

      <section id="network-credits">
        <div className="sec-head">
          <p className="eyebrow">Network credits</p>
          <div className="stack">
            <h2>
              Credits go further on Mesh nodes. <span className="muted">Same key, same request, a flat price instead of list.</span>
            </h2>
            <p>
              Every request has a list price: what the upstream provider charges for that model per token, the same number you would pay with your
              own provider key. When the gateway routes your request to a Mesh node instead, you are not billed list. You pay one flat network
              price, {fmtCost(TOKENOMICS.networkPricePerMTokens)} per million tokens (prompt and reply together), whatever the model.
            </p>
            <div className="rows">
              <div className="bigrow">
                <span className="display d-l">{fmtCost(TOKENOMICS.networkPricePerMTokens)}</span>
                <p className="desc">Per 1M tokens when a Mesh node answers. Deducted from your credits like any other request.</p>
                <span className="eyebrow">Network price</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">list ÷ paid</span>
                <p className="desc">
                  Your effective multiplier. If list would have been $0.0025 and you paid $0.0003, that request went 8× further. The Dashboard shows
                  your running multiplier across every node-served request.
                </p>
                <span className="eyebrow">× further</span>
              </div>
              <div className="bigrow">
                <span className="display d-l">$0</span>
                <p className="desc">
                  Saved on a model that is already cheaper than the network price at list. Savings never go negative: the figure shown is what you
                  kept, not a penalty.
                </p>
                <span className="eyebrow">Floor</span>
              </div>
            </div>
            <ul>
              <li>
                Each node-served reply carries <code>mesh.listCostUsd</code> and <code>mesh.savedUsd</code> next to <code>usage.cost</code> (final
                streamed chunk, or the JSON body plus an <code>x-mesh-saved-usd</code> header when not streaming). The chat shows it as “saved $…
                vs list”.
              </li>
              <li>
                <code>GET /me</code> returns <code>savings</code>: <code>usd24h</code>, <code>usdTotal</code>, <code>networkSharePercent</code>{' '}
                (how many of your requests nodes served) and <code>multiplier</code>. <code>GET /stats</code> adds <code>networkSavingsUsd24h</code>{' '}
                for the whole network.
              </li>
              <li>
                Routing is automatic: when an idle node advertises the model you asked for, it serves the request; otherwise the upstream does and
                you pay list. Nothing to toggle, and the node operator is paid from the treasury share, not from your credits.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section id="use">
        <div className="sec-head">
          <p className="eyebrow">Using your key</p>
          <div className="stack">
            <h2>
              Point any OpenAI client at Mesh. <span className="muted">Same request shape, same streaming, plus a cost line.</span>
            </h2>
            <ul>
              <li>
                Base URL: <code>{PUBLIC_API_URL}/v1</code>
              </li>
              <li>
                Auth: <code>Authorization: Bearer mesh_sk_…</code> — create keys under App → Keys. A key is shown once.
              </li>
              <li>
                Endpoints: <code>POST /v1/chat/completions</code> (stream or not), <code>GET /v1/models</code>.
              </li>
              <li>
                The final streamed chunk carries <code>usage</code> including <code>usage.cost</code> in USD. Non-streamed replies also set{' '}
                <code>x-mesh-cost-usd</code> and <code>x-mesh-balance-usd</code>. Replies served by a Mesh node add <code>mesh.savedUsd</code> (see{' '}
                <a href="#network-credits">Network credits</a>).
              </li>
              <li>
                Errors are OpenAI-shaped. <code>402 insufficient_quota</code> means your credit balance is zero; <code>429</code> is the per-key rate limit.
              </li>
              <li>
                Every endpoint, with request and response examples, is on the <Link to="/api">API reference</Link>; the raw OpenAPI 3.1
                document is at <code>{PUBLIC_API_URL}/openapi.json</code>.
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

      <section id="run">
        <div className="sec-head">
          <p className="eyebrow">Running a node</p>
          <div className="stack">
            <h2>
              Leave a Mac open, <span className="muted">serve replies, earn.</span>
            </h2>
            <p>
              The <code>mesh-node</code> agent registers with <code>POST /nodes/register</code>, heartbeats every 20 seconds, long-polls{' '}
              <code>GET /nodes/:id/jobs/next</code> and runs each job against a local Ollama, streaming the reply back as chunks. No inbound ports,
              no prompt written to disk. Earnings are shown as credits now and move to {TOKENOMICS.ticker} once the token layer ships.
            </p>
            <Terminal code={installOneLiner(null)} label="Install the node agent" wrap />
            <p>
              Then <code>mesh-node status</code> for uptime and earnings, <code>mesh-node pause</code> / <code>resume</code>,{' '}
              <code>mesh-node logs</code>, <code>mesh-node service uninstall</code> to remove it. Live status for your wallet is on the{' '}
              <Link to="/app/node">Node tab</Link>.
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
              Any machine that runs a model sees the prompt in plaintext while it runs; no software setting changes that. What Mesh does is
              let you choose <em>which</em> machines, strip everything else from the job, and never keep the text anywhere. Pick a tier per
              request with the <code>X-Mesh-Privacy</code> header (or <code>mesh.privacy</code> in the body), per key under{' '}
              <Link to="/app/keys">Keys</Link>, or leave the default: <b>trusted</b>.
            </p>
            <ul>
              <li>
                <b>Trusted nodes</b> — Macs whose operator staked gold and signed the operator pledge, or that we allowlisted. If none is online
                the request goes to the ZDR upstream, never to other nodes.
              </li>
              <li>
                <b>Any network node</b> — any online node. Cheapest; the operator could in principle inspect memory while serving you.
              </li>
              <li>
                <b>Upstream (ZDR)</b> — OpenRouter with <code>provider.data_collection = "deny"</code>: zero-data-retention providers only, list
                price.
              </li>
            </ul>
            <p>
              A node receives only <code>{'{jobId, model, messages, params, maxTokens, deadlineMs, attempt}'}</code>: no wallet, key, IP, user
              agent or request id, and messages reduced to role + text. Every reply says which tier served it in <code>mesh.servedBy</code>.
              Full threat model: <code>docs/PRIVACY.md</code> in the repo.
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
              Credits exist only when people trade {TOKENOMICS.ticker}. An hour with no trades is an hour with no distribution. Credits have no cash
              value, cannot be withdrawn or transferred, and the per-request price follows the upstream provider. The token can lose value. Nothing here
              is investment advice, and Mesh is not available to residents of {TOKENOMICS.geoBlock.join(', ')}.
            </p>
            <h3>Where it is still rough</h3>
            <p>
              One gateway, one SQLite file, one operator. The chain adapter and on-chain node payouts are the next steps; until then node rewards
              are a counter you can watch, not a paycheck. Sessions live in the browser. We will say when these change.
            </p>
            <p>
              Full text: <Link to="/risk">Risk disclosure</Link> · <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
