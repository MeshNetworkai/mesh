# Switch in a minute

For developers who already use an OpenAI-compatible endpoint (OpenRouter, or a gateway that resells it). You hold an OpenAI-style key and a base URL. Switching to Mesh is two string edits; every line of code you have keeps working. The same content, with a live model table, is at the top of the `/api` page.

## The two edits

| | Before | After |
| --- | --- | --- |
| Base URL | `https://openrouter.ai/api/v1` (or your gateway's) | `https://api.mesh-network.ai/v1` |
| Key | `sk-or-…` / your gateway's key | `mesh_sk_…` from **App → Keys** |

Same paths (`/chat/completions`, `/models`), same `Authorization: Bearer` header, same request body. Model ids do not change (see below).

Connecting a wallet for the first time credits it with starter credits (`config/tokenomics.json → starterCredits.amountUsd`, $2 as shipped), so you can create a key and send real requests before holding or buying anything.

## Snippets

### curl

```bash
export OPENAI_BASE_URL=https://api.mesh-network.ai/v1
export OPENAI_API_KEY=mesh_sk_...

curl $OPENAI_BASE_URL/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Hello from Mesh"}],
    "stream": false
  }'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.mesh-network.ai/v1",  # was: your old base_url
    api_key="mesh_sk_...",                      # was: your old key
)

r = client.chat.completions.create(
    model="anthropic/claude-sonnet-4.5",        # OpenRouter-style ids work unchanged
    messages=[{"role": "user", "content": "Hello from Mesh"}],
    extra_headers={"X-Mesh-Privacy": "upstream_zdr"},  # optional, see "The one difference"
)
print(r.choices[0].message.content)
print(r.usage)  # prompt_tokens, completion_tokens, total_tokens, cost
```

### Node (openai SDK)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.mesh-network.ai/v1",
  apiKey: process.env.MESH_API_KEY, // mesh_sk_...
  defaultHeaders: { "X-Mesh-Privacy": "trusted" }, // optional
});

const r = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4.5",
  messages: [{ role: "user", content: "Hello from Mesh" }],
});
console.log(r.choices[0].message.content, r.usage);
```

### LangChain

```python
# Python (langchain-openai)
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="anthropic/claude-sonnet-4.5",
    base_url="https://api.mesh-network.ai/v1",
    api_key="mesh_sk_...",
    default_headers={"X-Mesh-Privacy": "upstream_zdr"},  # optional
)
print(llm.invoke("Hello from Mesh").content)
```

```js
// JavaScript (@langchain/openai)
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  model: "anthropic/claude-sonnet-4.5",
  apiKey: process.env.MESH_API_KEY,
  configuration: { baseURL: "https://api.mesh-network.ai/v1" },
});
```

### Vercel AI SDK

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";

const mesh = createOpenAICompatible({
  name: "mesh",
  baseURL: "https://api.mesh-network.ai/v1",
  apiKey: process.env.MESH_API_KEY,
  headers: { "X-Mesh-Privacy": "trusted" }, // optional
});

const { text, usage } = await generateText({ model: mesh("anthropic/claude-sonnet-4.5"), prompt: "Hello from Mesh" });
const stream = streamText({ model: mesh("llama-3.1-8b"), prompt: "..." }); // same SSE as your current provider
```

### Cursor

Settings → Models:

* **OpenAI API Key**: `mesh_sk_...`
* **Override OpenAI Base URL**: `https://api.mesh-network.ai/v1`
* **Add model**: `anthropic/claude-sonnet-4.5` (any id from `GET /v1/models`). Untick the stock OpenAI models you no longer want so Cursor only sends to Mesh.

### Continue

`~/.continue/config.yaml`:

```yaml
models:
  - name: Claude Sonnet 4.5 via Mesh
    provider: openai
    model: anthropic/claude-sonnet-4.5
    apiBase: https://api.mesh-network.ai/v1
    apiKey: mesh_sk_...
    requestOptions:
      headers:
        X-Mesh-Privacy: upstream_zdr   # optional
  - name: Llama 3.1 8B on the Mesh network
    provider: openai
    model: llama-3.1-8b
    apiBase: https://api.mesh-network.ai/v1
    apiKey: mesh_sk_...
```

## Model names: theirs → ours

Nothing to rename. Mesh accepts OpenRouter-style ids (`vendor/model`) unchanged, and the open models Mesh nodes serve also answer to a short alias. `GET https://api.mesh-network.ai/v1/models` is the source of truth; each row carries `served` (`network` | `upstream` | `both`), `listPrice`, `meshPrice` and `privacy`. The short aliases come from `config/model-policy.json → networkModels`; the curated upstream list from `config/model-prices.json`.

| You send today | Mesh accepts | Served by |
| --- | --- | --- |
| `meta-llama/llama-3.1-8b-instruct` | the same, or `llama-3.1-8b` | Mesh nodes first, upstream fallback |
| `qwen/qwen-2.5-7b-instruct` | the same, or `qwen-2.5-7b` | Mesh nodes first, upstream fallback |
| `anthropic/claude-sonnet-4.5` | the same | upstream (ZDR providers only) |
| `anthropic/claude-opus-4.1` | the same | upstream (ZDR) |
| `openai/gpt-5`, `openai/gpt-5-mini`, `openai/gpt-4.1` | the same | upstream (ZDR) |
| `google/gemini-2.5-pro`, `google/gemini-2.5-flash` | the same | upstream (ZDR) |
| anything else | forwarded unchanged if the model policy allows it | upstream (ZDR) |

## What is identical

* Request body, including `stream`, `stream_options`, `temperature`, `max_tokens`, tools.
* Streaming: the same SSE chunks and the final `data: [DONE]`. With `stream_options: {"include_usage": true}` the last chunk carries `usage`.
* The `usage` object: `prompt_tokens`, `completion_tokens`, `total_tokens`, plus `usage.cost` in USD exactly as OpenRouter reports it.
* Errors are OpenAI-shaped. `402 insufficient_quota` means your credit balance is zero; `429` is the per-key rate limit.

## What Mesh adds (response headers)

| Header | Meaning |
| --- | --- |
| `x-mesh-route` | Who answered: `node:<id>` when a Mesh node served it, else the upstream name (`openrouter`). |
| `x-mesh-privacy` | The privacy tier the request ended up under: `trusted`, `network` or `upstream_zdr`. |
| `x-mesh-served-by` | Human label: `your node`, `trusted node`, `network node` or `upstream (ZDR)`. |
| `x-mesh-cost-usd`, `x-mesh-balance-usd` | Cost of this request and your balance after it (non-streamed replies; streamed replies carry `usage.cost`). |

Node-served replies also add `mesh.listCostUsd` and `mesh.savedUsd` next to `usage`. Ignore all of it or log it; nothing in your client has to change.

## The one difference

An optional request header, `X-Mesh-Privacy: trusted | network | upstream_zdr`, picks which machines may see the prompt (also accepted as `mesh.privacy` in the body, or set per key). Leave it out and the key's default applies (`trusted`: your own nodes, allowlisted or gold-staked pledged operators, else the zero-data-retention upstream). Full model in [PRIVACY.md](PRIVACY.md).

## What changes on your bill

Two prices, both read from config and reported per model by `GET /v1/models`:

* **Network models** (the open models Mesh nodes run) bill a flat `requestPricing.networkPricePerMTokens` per million tokens, prompt and reply together, whatever the model: $0.02/M as shipped. The reply says what list would have cost and what you saved.
* **Frontier and fast models** go to the upstream and bill OpenRouter list × (1 − `requestPricing.upstreamDiscountBps` / 10000), or × (1 + `upstreamMarkupBps` / 10000); exactly one of the two may be set, and both are 0 as shipped, so you pay exactly list with no markup. The discount gap, when configured, is treasury-funded ([PRICING.md](PRICING.md)).

Credits are US dollars: one credit dollar buys one dollar of inference. They arrive hourly from trading fees if you hold `minHoldTokens` $MESH, from the credit marketplace, or from the starter grant on first connect.

## Starter credits (operator notes)

Config block in `config/tokenomics.json`:

```json
"starterCredits": { "enabled": true, "amountUsd": 2, "maxWallets": 500, "requireMinHold": false }
```

* `amountUsd`: credited once to each wallet on its first-ever successful `POST /auth/verify` (ledger kind `starter`, ref `starter:auto`; the same kind the admin batch grant uses, so `/report` and the admin overview already count it).
* `maxWallets`: total wallets that may ever receive it (0 = unlimited). `GET /stats → starterGrants { enabled, amountUsd, granted, remaining }` shows progress.
* `requireMinHold`: when true the wallet must also hold `minHoldTokens`.
* `maxPerIpPerDay` (default 3): grants per peppered client-IP hash per rolling day, against sybil farming.
* Runtime pause/resume without a redeploy: `POST /admin/starter/toggle` with `{ "enabled": false }`, `{ "enabled": true }`, `{ "enabled": null }` (follow config again) or an empty body (flip). `GET /admin/starter` lists status and recent grants. Both are on the Admin page ("Starter credits · first connect") and audited as `starter-toggle`.
* Tables: `starter_grants` (wallet UNIQUE, amount_micros, granted_at, ip_hash) and `starter_settings` (migration 16). Code: `apps/gateway/src/starter.ts`, hook in `apps/gateway/src/routes/auth.ts`.
