import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Notice } from '../components/ui';
import { PUBLIC_API_URL, TOKENOMICS, pctFromBps } from '../config';
import { fmtCost, fmtInt } from '../lib/format';

/**
 * Plain-English legal pages: /terms, /privacy, /risk. Drafts, marked as such on every page.
 * Numbers come from config/tokenomics.json so the text cannot drift from what the gateway does.
 */

const REGION_NAMES: Record<string, string> = { AE: 'the United Arab Emirates', US: 'the United States', GB: 'the United Kingdom' };
const regions = TOKENOMICS.geoBlock.map((c) => REGION_NAMES[c] ?? c);
const regionList = regions.length <= 1 ? regions.join('') : `${regions.slice(0, -1).join(', ')} and ${regions[regions.length - 1]}`;
const UPDATED = '2026-10-05';
const marketFee = pctFromBps(TOKENOMICS.marketplace.feeBps);
const epochWord = TOKENOMICS.epochSeconds === 3600 ? 'hour' : `${Math.round(TOKENOMICS.epochSeconds / 60)} minutes`;

function Draft() {
  return (
    <Notice>
      <b>Draft, not legal advice.</b> This text is a plain-English draft written by the operator. It has not been reviewed by a lawyer. It
      will be replaced before the token is tradeable, and the date at the top will change when it does.
    </Notice>
  );
}

function Clause({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="clause" id={`c${n.replace(/\./g, '-')}`}>
      <span className="eyebrow">{n}</span>
      <div className="stack sm">
        <h3 className="display d-s">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function LegalNav() {
  const { pathname } = useLocation();
  const items: Array<[string, string]> = [
    ['/terms', 'Terms'],
    ['/privacy', 'Privacy'],
    ['/risk', 'Risk'],
  ];
  return (
    <nav className="chips" aria-label="Legal pages">
      {items.map(([to, label]) => (
        <Link key={to} className={`chip${pathname === to ? ' on' : ''}`} to={to} aria-current={pathname === to ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function LegalPage({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede: string; children: ReactNode }) {
  return (
    <div className="wrap docs legal">
      <section className="hero" style={{ paddingBlock: '32px 0' }}>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="display d-xl" style={{ fontSize: 'clamp(40px,7vw,88px)' }}>
          {title}
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          {lede}
        </p>
        <LegalNav />
        <p className="small muted">
          Draft · updated {UPDATED} · {TOKENOMICS.name} · ${TOKENOMICS.ticker} · open beta
        </p>
      </section>
      <section>
        <div className="sec-head">
          <p className="eyebrow">Read first</p>
          <div className="stack">
            <Draft />
          </div>
        </div>
      </section>
      {children}
    </div>
  );
}

const GEO = TOKENOMICS.geoBlock.length === 0 ? null : (
  <p>
    The service is not offered to, and may not be used by, anyone who lives in or is connecting from {regionList} (country codes{' '}
    {TOKENOMICS.geoBlock.join(', ')}). The gateway refuses sign-in and inference requests from those regions when geo-blocking is enforced,
    and we may add regions. Using a VPN or any other means to get around this is a breach of these terms and we may close the account.
  </p>
);

export function Terms() {
  return (
    <LegalPage eyebrow="Terms of use" title={<>Plain terms.</>} lede="What you agree to when you connect a wallet, use a key, or run a node. Short on purpose.">
      <section id="service">
        <div className="sec-head">
          <p className="eyebrow">The service</p>
          <div className="stack">
            <Clause n="1" title="Who we are and what this is">
              <p>
                {TOKENOMICS.name} is an OpenAI-compatible inference gateway, a network of Macs that serve requests through it, and a marketplace
                where unused inference credits are sold. It is run by a single operator (“we”, “us”). You use it by connecting a wallet, creating API
                keys and sending requests, by buying or selling credits on the marketplace, or by running the node agent on a Mac you control.
              </p>
            </Clause>
            <Clause n="2" title="Who may use it">
              <p>You must be at least 18 and able to enter a contract where you live{TOKENOMICS.geoBlock.length ? ', and not in a restricted region' : ''}.</p>
              {GEO}
            </Clause>
            <Clause n="3" title="Your wallet is your account">
              <p>
                Signing in is a wallet signature. There is no password to reset and no email on file. If you lose control of the wallet you lose
                access to its credits and keys; we cannot move them for you. Keep API keys secret: anyone with a key can spend from your balance
                until you revoke it under App → Keys.
              </p>
            </Clause>
          </div>
        </div>
      </section>

      <section id="credits">
        <div className="sec-head">
          <p className="eyebrow">Credits</p>
          <div className="stack">
            <Clause n="4" title="Credits are a share of fees, not a promise">
              <p>
                A {TOKENOMICS.tradeFeeBps / 100}% fee on ${TOKENOMICS.ticker} trades is swept every {TOKENOMICS.epochSeconds / 60} minutes.{' '}
                {TOKENOMICS.holderShareBps / 100}% of what was collected is split, pro rata, across wallets holding at least{' '}
                {fmtInt(TOKENOMICS.minHoldTokens)} ${TOKENOMICS.ticker} through that hour, as US-dollar-denominated inference credits.
              </p>
              <p>
                A second source may pay into the same pool: when the usage-revenue share is switched on, a configured share of the margin we make on
                paid requests and marketplace fees is added to the next distribution. It is built and may be switched on, off or re-tuned by us; the
                gateway reports its state publicly and the docs say when it changes. Half of every marketplace fee is paid into the pool whenever a
                sale happens.
              </p>
              <ul>
                <li>No amount of credits is promised, projected or guaranteed. An {epochWord} with no trades and no sales distributes nothing.</li>
                <li>Credits are not money, not a deposit, not a security and not a claim on us or on future fees.</li>
                <li>
                  Credits are a licence to use the gateway. They are not redeemable for cash or tokens and cannot be withdrawn; the only way they move
                  between wallets is a sale on the marketplace (clause 6). They have no value outside the gateway.
                </li>
                <li>Credits can only be spent on inference through the gateway, at the prices shown in the catalogue and in each reply.</li>
                <li>We may change the fee split, the eligibility threshold, the epoch length or the usage share. Changes are published in the docs before they apply.</li>
              </ul>
            </Clause>
            <Clause n="5" title="Pricing and billing">
              <p>
                Requests served by a Mesh node are billed at the flat network price, {fmtCost(TOKENOMICS.networkPricePerMTokens)} per million total
                tokens. Requests served by the upstream provider are billed at that provider’s list price less the discount, or plus the markup,
                published in the catalogue (<code>GET /v1/models</code>); both are zero today, so you pay exactly list. The cost of each request is
                shown in the reply and deducted from your balance. Failed requests are never charged. Spend limits you set on a key are enforced per
                key. The first sign-in of a wallet may receive a small starter grant while that programme runs; it is a gift under the same terms as
                every other credit and may be paused at any time.
              </p>
            </Clause>
            <Clause n="6" title="The credit marketplace">
              <p>
                Holders may list credits for sale at a discount and anyone with an account may buy them. Mesh keeps {marketFee} of the price on every
                sale, paid by the seller; half of that fee goes to the next distribution and half to the treasury. The fee is not refunded, including
                when a buyer later disputes a purchase or the service changes.
              </p>
              <ul>
                <li>Listed credit is held in escrow and cannot be spent until the listing fills, is cancelled or expires. Fills are final.</li>
                <li>
                  Buyers pay, and sellers are paid, in a prepaid US-dollar balance kept by the gateway. During the beta that balance is topped up by us
                  after an off-chain payment you arrange with us, and withdrawals are processed by us by hand: the amount leaves your balance when you
                  request it and is sent to your wallet in a stablecoin when we mark it paid. We aim to process withdrawals promptly but do not promise
                  a time. On-chain checkout will replace this and we will say so in the docs.
                </li>
                <li>
                  The prepaid balance is a record of what you have paid in or earned from sales, held so that you can buy credits or withdraw it. It is
                  not a deposit account, earns nothing, and is subject to the same limited liability as the rest of the service.
                </li>
                <li>We may reject or cancel listings and fills that abuse the market, and may change the fee, the discount range or the listing lifetime with notice in the docs.</li>
              </ul>
            </Clause>
          </div>
        </div>
      </section>

      <section id="nodes">
        <div className="sec-head">
          <p className="eyebrow">Node operators</p>
          <div className="stack">
            <Clause n="7" title="Your Mac, your electricity, your choice">
              <p>
                Running a node means installing the <code>mesh-node</code> agent on a Mac you own or are allowed to use, with Ollama. You pay for
                the hardware, the power and the bandwidth. You can pause or uninstall at any time; nothing we do depends on you staying online.
              </p>
            </Clause>
            <Clause n="8" title="No guarantee of jobs or earnings">
              <p>
                Jobs are routed to online, idle nodes that advertise the requested model and meet the reputation threshold. We do not guarantee
                that your node receives any job, any number of jobs, or any amount of rewards. Rewards accrue as a US-dollar balance per completed
                job at the published rate and are visible on your Node page. Paying accrued rewards out on-chain is not live yet; it starts after the
                token is deployed by the team, on the chain decided then. Until it is, the balance is a counter, not a payment, and we may change the
                rate or the mechanism with notice in the docs. A sample of node answers is re-run elsewhere and compared; a job whose answer does not
                hold up earns no reward.
              </p>
            </Clause>
            <Clause n="9" title="What you agree to as an operator">
              <ul>
                <li>Run the agent as shipped, with prompt and reply logging off, and do not keep, inspect or share the content of jobs.</li>
                <li>Do not fake hardware, uptime, models or results. Nodes that fail or cheat are excluded by reputation and may be removed.</li>
                <li>Keep your node token secret. Anyone with it can act as your node.</li>
                <li>You are responsible for complying with the law where the Mac is, including any tax on rewards.</li>
              </ul>
            </Clause>
          </div>
        </div>
      </section>

      <section id="conduct">
        <div className="sec-head">
          <p className="eyebrow">Use and limits</p>
          <div className="stack">
            <Clause n="10" title="Acceptable use">
              <p>
                Do not use the service to break the law, to harm people, to attack the gateway or nodes, to manipulate the marketplace, or to bypass
                rate limits, spend limits{TOKENOMICS.geoBlock.length ? ' or geo-blocking' : ' or the starter-grant limits'}. Requests to third-party providers are also subject to those providers’ terms. We may block models, keys or wallets
                that we believe are being abused.
              </p>
            </Clause>
            <Clause n="11" title="The service may change or stop">
              <p>
                This is early software run by one operator on one server. It may be interrupted, rate-limited, changed or discontinued. The docs
                say what is live and what is not. We will say when something important changes, but we cannot promise notice for everything.
              </p>
            </Clause>
            <Clause n="12" title="No warranty, limited liability">
              <p>
                The service is provided as is, without warranty of any kind. To the extent the law allows, we are not liable for lost credits,
                lost tokens, lost profits, or any indirect or consequential loss arising from the service, the token, a node, or a third-party
                provider. Nothing here limits liability that cannot be limited by law.
              </p>
            </Clause>
            <Clause n="13" title="Beta">
              <p>
                Mesh is in open public beta: any wallet may connect.{' '}
                {TOKENOMICS.beta.inviteRequired
                  ? 'Access is currently limited to invited wallets and opened in batches from a waitlist; an invite code admits one wallet and is not transferable once used. '
                  : 'We may limit sign-ups or pace them from a waitlist if the network needs it. '}
                The token is not deployed yet: until the team deploys it on launch day, the fee feed is a test harness and the credits it mints are
                beta credits. During the beta we may reset, rate-limit or pause parts of the service, change prices, fees and reward rates, and remove
                nodes whose work fails our spot checks (a node whose answers do not hold up loses the reward for that job and, if it repeats, is
                quarantined). Credits, marketplace balances and node rewards earned in the beta are real inside the gateway but carry the same "not a
                promise" terms as everything else here. We will say in the docs when the beta ends.
              </p>
            </Clause>
            <Clause n="14" title="Changes to these terms">
              <p>
                We may update these terms. The date at the top changes when we do. Continuing to use the service after a change means you accept
                it. Related pages: <Link to="/privacy">Privacy</Link>, <Link to="/risk">Risk</Link>, <Link to="/docs">Docs</Link>.
              </p>
            </Clause>
          </div>
        </div>
      </section>
    </LegalPage>
  );
}

export function Privacy() {
  return (
    <LegalPage eyebrow="Privacy" title={<>What we keep.</>} lede="No prompt is stored. Here is exactly what is logged, why, and for how long.">
      <section id="prompts">
        <div className="sec-head">
          <p className="eyebrow">Prompts</p>
          <div className="stack">
            <Clause n="1" title="Prompts and replies are not stored">
              <p>
                The gateway relays your request to a Mesh node or to the upstream provider and relays the reply back. It does not write the prompt
                or the reply to disk, to a database or to a log. Before a node sees a job the gateway removes everything but the model, the
                messages (role and text only) and sampling settings: no wallet, API key, IP address, user agent or request id. The node agent
                writes only job ids, token counts and timings to its log and discards the text once the reply is sent.
              </p>
              <p>
                What we cannot change: the machine that runs the model must hold your prompt in plaintext while it generates the reply, and a
                determined operator of that machine could inspect its memory. That is why requests carry a privacy tier. <b>Trusted</b> nodes
                have staked and signed the operator pledge not to log, store, forward or inspect job content; <b>network</b> means any online
                node; <b>upstream (ZDR)</b> sends the request to OpenRouter restricted to zero-data-retention providers. The default is trusted,
                and a trusted request that no trusted node can take goes to the ZDR upstream, never to another node. See docs/PRIVACY.md in the
                repository for the full threat model.
              </p>
            </Clause>
            <Clause n="2" title="What is logged per request">
              <p>So that we can bill you and keep the network honest, each request to the gateway records:</p>
              <ul>
                <li>which API key and wallet made it, the model, and whether it was streamed</li>
                <li>prompt and completion token counts, the cost charged, the list price it replaced, and latency</li>
                <li>which route served it: a node id or the upstream name</li>
              </ul>
              <p>These rows are what you see in your ledger and key usage pages, and what the public stats and report are computed from.</p>
            </Clause>
          </div>
        </div>
      </section>

      <section id="data">
        <div className="sec-head">
          <p className="eyebrow">Other data</p>
          <div className="stack">
            <Clause n="3" title="Wallets and sessions">
              <p>
                We store your wallet address, the chain it is on, when it last signed in, its credit ledger, its marketplace listings, fills, prepaid
                balance and withdrawal requests, and its API keys (a prefix and a hash; the secret is shown once and not kept). The first sign-in also
                records a hash of your network address for a day, to limit starter grants. A session is a signed token that lives in your browser for 7 days. We do not collect an
                email, a name or a password.
              </p>
            </Clause>
            <Clause n="4" title="Nodes">
              <p>
                For each node we store its id, the reward wallet, the chip and RAM it reports, the models it advertises, heartbeats (kept 48 hours
                for uptime), job outcomes (success, failure, timing, token counts) and accrued rewards. Job content is not stored.
              </p>
            </Clause>
            <Clause n="5" title="Server logs and IP addresses">
              <p>
                The web server and the gateway keep short-lived operational logs with IP address, path, status and timing so we can rate-limit,
                detect abuse and debug. Authorization headers are redacted before they reach a log. {TOKENOMICS.geoBlock.length ? 'Country is derived from the IP to enforce the regional restriction; the IP itself is not stored with your account.' : 'No regional restriction is enforced today, and the IP itself is not stored with your account.'}
              </p>
            </Clause>
            <Clause n="6" title="Third parties">
              <p>
                Requests for models not served by the Mesh network, and requests on the upstream (ZDR) tier, go to OpenRouter under its own
                terms and privacy policy, which apply to the content of those requests; on the trusted and upstream (ZDR) tiers we ask OpenRouter
                to use only providers that do not retain data. The response headers and the reply tell you which path served you. Wallet connections go through the
                wallet software you choose. We do not use analytics scripts, advertising trackers or third-party fonts on this site.
              </p>
            </Clause>
          </div>
        </div>
      </section>

      <section id="rights">
        <div className="sec-head">
          <p className="eyebrow">Your choices</p>
          <div className="stack">
            <Clause n="7" title="Retention and deletion">
              <p>
                Billing rows and ledgers are kept while the service runs, because the public report is derived from them. Heartbeats expire after
                48 hours, sign-in nonces after 5 minutes, link codes after 15 minutes. Revoking a key stops its use immediately. If you want a
                wallet’s record removed, contact the operator through the channels linked in the footer; we can remove the account but the
                aggregate stats it contributed to stay.
              </p>
            </Clause>
            <Clause n="8" title="Public by design">
              <p>
                Epoch history, network totals, the treasury report and the marketplace book are public at <code>{PUBLIC_API_URL}/stats</code>,{' '}
                <code>/epochs</code>, <code>/report</code> and <code>/market/*</code>, and on the numbers page. They contain counts and dollar totals,
                never wallets, keys or prompts; open listings are shown without the seller's address.
              </p>
            </Clause>
            <Clause n="9" title="Changes">
              <p>
                We may update this page. The date at the top changes when we do. Related pages: <Link to="/terms">Terms</Link>,{' '}
                <Link to="/risk">Risk</Link>.
              </p>
            </Clause>
          </div>
        </div>
      </section>
    </LegalPage>
  );
}

export function Risk() {
  return (
    <LegalPage eyebrow="Risk disclosure" title={<>Read before you hold.</>} lede="Credits are a share of fees, not a return. The token can go to zero. Here is the full list.">
      <section id="risks">
        <div className="sec-head">
          <p className="eyebrow">The risks</p>
          <div className="stack">
            <Clause n="1" title="Credits are not a yield, income or return">
              <p>
                {TOKENOMICS.name} credits are a share of trading fees already collected, converted to US-dollar-denominated inference credits, plus,
                when it is switched on, a share of the margin on paid usage. They are not a return, a yield or income, and no amount is promised or
                guaranteed. An {epochWord} with little or no trading distributes little or nothing from fees; the usage share is off today and may be
                switched on, off or re-tuned. The numbers page shows every epoch, including the empty ones.
              </p>
            </Clause>
            <Clause n="2" title="The token can lose all its value">
              <p>
                ${TOKENOMICS.ticker} is a crypto token. Its price can fall to zero and may never recover. Holding it to receive credits exposes you
                to that loss, which can far exceed the value of any credits you receive. Only hold what you can afford to lose entirely.
              </p>
            </Clause>
            <Clause n="3" title="Credits have no cash value">
              <p>
                Credits are denominated in US dollars inside the gateway only. They are a licence to use the gateway, not money: they cannot be
                withdrawn and move between wallets only through the marketplace, where a buyer may or may not exist at the discount you want. They
                depend on the gateway continuing to operate; if the service stops, credits stop with it.
              </p>
            </Clause>
            <Clause n="4" title="Marketplace balances and withdrawals">
              <p>
                Prepaid balances on the marketplace are a record held by the gateway, not a bank deposit. During the beta they are topped up and paid out
                by the team by hand, so a withdrawal depends on the operator acting; it is not instant and not guaranteed. The {marketFee} fee on a sale is
                not refunded. Listed credit is locked in escrow until the listing closes.
              </p>
            </Clause>
            <Clause n="5" title="One operator, one server">
              <p>
                The service is run by a single operator on a single server with a single database. It may be interrupted, changed or
                discontinued. Sessions live in the browser. The token is not deployed yet, the chain is not final, and on-chain node payouts are not
                live; the docs and the roadmap list what is.
              </p>
            </Clause>
            <Clause n="6" title="Node rewards are a counter, not a paycheck">
              <p>
                Node rewards accrue as a balance and are not yet paid on-chain. There is no guarantee your Mac receives jobs, and the rate may
                change. Treat the balance as something you can watch, not something you can spend, until payout ships.
              </p>
            </Clause>
            <Clause n="7" title="Third-party providers and open models">
              <p>
                Requests may be served by third-party providers under their own terms, or by open models on Macs run by other people. Outputs can
                be wrong, incomplete or inappropriate. Do not rely on them for medical, legal, financial or safety decisions without checking.
              </p>
            </Clause>
            {GEO ? <Clause n="8" title="Regional restriction">{GEO}</Clause> : null}
            <Clause n="9" title="Smart contract, chain and wallet risk">
              <p>
                The token will be deployed by the team on launch day on a chain decided then. Chains halt, contracts have bugs, wallets get phished. We do not control the chain, your wallet,
                or any exchange where the token trades. A signature you make with your wallet is yours; check what you sign.
              </p>
            </Clause>
            <Clause n="10" title="Not advice">
              <p>
                Nothing on this site is investment, legal or tax advice. Read the <Link to="/terms">Terms</Link>, the{' '}
                <Link to="/privacy">Privacy</Link> page and the current status of what is live and what is not in the <Link to="/docs">Docs</Link>{' '}
                before you buy, hold or use anything.
              </p>
            </Clause>
          </div>
        </div>
      </section>
    </LegalPage>
  );
}
