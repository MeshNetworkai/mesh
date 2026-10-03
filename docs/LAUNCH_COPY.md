# Mesh launch copy

House rules from `docs/design-system.html`: short sentences, plain words, say where it runs and what
it costs, never promise a return. Never say "guaranteed yield", "passive income", "APY", "better
than ChatGPT", "fully private", anything with an exclamation mark, rockets, emojis, "to the moon".
Numbers in copy come from `config/tokenomics.json` (1.5 % trade fee, 50 % of fees to holders,
1,000 $MESH minimum, hourly epochs) and `docs/NODE_PROTOCOL.md` ($0.02/M to use the network,
$0.06/M to the node). Replace `app.example.com` and `api.example.com` before posting.

---

## 1. Landing hero + subcopy (three variants)

**A. Current (plain statement)**

> Trading pays for private AI.
>
> Hold 1,000 $MESH and AI credits arrive every hour, paid for by trading fees. One API key for any model. Your requests run on Macs in the Mesh network, never on a provider's logs.

**B. The mechanism up front**

> Half of every trade becomes AI, every hour.
>
> A 1.5 % fee on $MESH trades is swept each hour. Half of it is split across every wallet holding 1,000 tokens or more, as credits you spend through an OpenAI-compatible endpoint. The other half runs the network.

**C. For the person who just wants the API**

> An API key your trading fees keep topping up.
>
> Use it anywhere an OpenAI key works. Credits are a share of fees, not a promise: when people trade, holders get inference. Served by Macs in the network at $0.02 per million tokens, or by OpenRouter at cost.

---

## 2. Launch thread (9 posts)

1. Mesh is live. Trading fees become AI inference credits, every hour, for everyone holding the token. Here is how it works and what it is not.

2. The mechanism. Every $MESH trade carries a 1.5 % fee. At the top of each hour the gateway sweeps the fees, keeps half for the network treasury, and splits the other half across every wallet holding at least 1,000 $MESH, pro rata, as USD-denominated credits.

3. Credits are spent through an OpenAI-compatible API. Create a key at app.example.com, point any client at api.example.com/v1, pick a model. Streaming works. Spend limits per key work. Your balance and every debit are in the dashboard.

4. Where it runs. Requests for the network models go to Macs run by people like you, through the gateway. Nothing is stored on the node after the reply. Other models go to OpenRouter at cost, and the response headers tell you which path served you.

5. What it costs. Network-served requests are $0.02 per million tokens. The node that did the work earns $0.06 per million tokens, topped up from the treasury share of trading fees. OpenRouter-served requests are billed at whatever OpenRouter charges. Failed requests are never charged.

6. Running a node. One command installs the agent on a Mac with Ollama. It registers with a wallet signature, heartbeats, pulls jobs, streams tokens back. Earnings accrue per job and are visible under app.example.com/app/node. Reputation decides who gets routed to.

7. What this is not. It is not yield, not income, and the credits are not a promise. If nobody trades, no fees are collected and no credits are distributed that hour. The stats page shows every epoch, including the empty ones.

8. Where it is still rough. One gateway, one SQLite file, one operator. The chain adapter and node payouts are the next steps and are listed in the docs as such. We will say when these change.

9. Everything is open: the gateway, the node agent, the tokenomics file, the epoch history. Read the docs at app.example.com/docs, check the numbers at api.example.com/stats, and tell us what breaks.

---

## 3. What Mesh is (one paragraph for the docs)

Mesh is a token whose trading fees buy AI inference for the people holding it. A 1.5 % fee on every $MESH trade is swept once an hour; half goes to the network treasury and half is split, pro rata, across every wallet holding at least 1,000 tokens as credits denominated in US dollars. Holders spend those credits through an OpenAI-compatible gateway with their own API keys. Requests for the supported open models are served by Macs running Ollama inside the Mesh network, which earn a share of the price per token; everything else is routed to OpenRouter at cost. Credits are a share of fees, not a promise: an hour with no trades distributes nothing, and the full epoch history is public.

---

## 4. Node operator invite (message to friends)

> I am launching Mesh this week and could use a few Macs in the network.
>
> What it is: an inference network behind an OpenAI-compatible API. Holders of the token get hourly credits from trading fees and spend them through the gateway. When they ask for one of the open models, the request goes to a Mac in the network running Ollama. Yours, if you join.
>
> What you do: keep a Mac open with Ollama and run one command from app.example.com/app/node. It registers your machine (you sign a short message with your wallet so rewards go to you), pulls jobs, streams the answer back. It never accepts inbound connections.
>
> What you get: $0.06 per million tokens your machine serves, tracked per job on your node page. Payout of accrued rewards is the next step on the roadmap, so for now treat it as a counter you can watch, not a paycheck.
>
> What it costs you: electricity and some RAM while a job runs. Prompts are not stored on your machine after the reply. You can stop any time.
>
> If you are in, send me the wallet you want paid to and the chip and RAM of the Mac, and I will add you to the first batch.

---

## 5. Risk disclosure (one paragraph)

Mesh credits are a share of trading fees, not a return, a yield or income, and no amount is promised or guaranteed. An hour with little or no trading distributes little or nothing. The value of $MESH can fall to zero; holding it to receive credits exposes you to that loss. Credits are denominated in US dollars inside the gateway, are not redeemable for cash or tokens, and depend on the gateway continuing to operate; the service is run by a single operator on a single server and may be interrupted, changed or discontinued. Node rewards accrue as a balance and are not yet paid on-chain. Requests may be served by third-party providers under their own terms. The service is not available in some regions, and nothing here is investment, legal or tax advice. Read the full terms and the current status of what is live and what is not at app.example.com/docs before you buy, hold or use anything.
