# Privacy on Mesh: what each party sees, the three tiers, and what we cannot promise

Mesh serves chat completions in two ways: through Macs run by third parties (the node network,
`docs/NODE_PROTOCOL.md`) or through OpenRouter. Both ways, the machine that runs the model has to hold
the prompt in plaintext while it generates the reply. **Nothing in this document changes that.** What
Mesh does is let the caller choose *which* machines may be that machine, strip everything else from
the job, and never keep the text anywhere. This page is the honest version of that: the threat model,
the tiers, what is implemented, what is not possible, the pledge operators sign, and where confidential
compute would fit.

Code: `apps/gateway/src/routing.ts` (tier resolution and route decision), `network.ts`
(`sanitizeMessages`, trusted-only claims), `routes/nodes.ts` (`jobView`, pledge endpoints),
`upstream.ts` (`upstreamBody`, ZDR flag), `apps/node-agent/src/runner.ts` (`scrubJob`, logging).
Tests: `apps/gateway/test/privacy.test.ts`, `apps/node-agent/test/privacy.test.ts`.

## 1. Threat model: who sees what

| | Prompt + reply text | Wallet / API key | IP, user agent | Model, token counts, timing |
| --- | --- | --- | --- | --- |
| **Gateway** (our server) | In memory while relaying; **never written** to disk, DB or logs | Yes (billing) | Yes, in short-lived server logs; not stored with the account | Yes, stored (`requests_log`, `jobs`) |
| **A node** (someone's Mac) | **Yes, in plaintext** while it runs the model; agent keeps nothing after the reply | **No** | **No** | Job id, Ollama tag, token counts, timing |
| **OpenRouter** and its provider | **Yes, in plaintext**; under their terms. On ZDR tiers we ask for providers that do not retain data | No (our OpenRouter key is used) | No (the gateway connects) | Yes |
| **Another client / the public** | No | No | No | Aggregates only (`/stats`, `/nodes`) |

What the gateway sends a node is exactly:

```json
{ "jobId": "job_Qm3…", "model": "llama3.1:8b", "messages": [{ "role": "user", "content": "…" }],
  "params": { "temperature": 0.2 }, "maxTokens": 1024, "deadlineMs": 1727950000000, "attempt": 1 }
```

- `messages` are reduced to `role` + `content`; `content` is a string or text parts only. OpenAI's
  `name`, `tool_call_id`, `tool_calls`, image/audio parts and any vendor extras are dropped
  (`network.ts:sanitizeMessages`).
- `params` is a whitelist of sampling parameters (`routes/v1.ts:NODE_PARAM_KEYS`). The OpenAI `user`
  field, `metadata`, our own `mesh` block and anything else never reach a node.
- `model` is the Ollama tag, not the client-facing model name. There is no wallet, API key id, request
  id, IP, user agent, or client identifier anywhere in the payload, and the stored `jobs.payload` row is
  the same sanitised JSON. `privacy.test.ts` asserts the key set is exactly
  `JOB_VIEW_FIELDS` and that none of a set of planted identifiers survive.
- What a node *can* infer: the gateway's IP (not yours), the time of day, the model, and of course
  whatever you wrote in the prompt. If the prompt says who you are, the node knows who you are.

What the gateway sends OpenRouter is the client body minus `mesh`, plus `usage.include` and, on ZDR
tiers, `provider.data_collection: "deny"`. A client-supplied `user` field is passed through to
OpenRouter unchanged (it is the standard OpenAI abuse-tracking id; leave it out if you do not want the
provider to see it).

## 2. The three tiers

A request is served under one of three tiers. Pick one per request with the `X-Mesh-Privacy` header or
`mesh.privacy` in the body, per API key with `PATCH /keys/:id {"privacy": …}`, or leave the gateway
default. Precedence: **header > body > key default > `config.privacy.default`** (default `trusted`).
An unknown or disabled value is `400 invalid_privacy_tier`, never a guess.

| Tier | Who runs the model | Cost | When no such machine is available |
| --- | --- | --- | --- |
| `trusted` (default) | **Your own nodes** (reward wallet = the wallet behind the API key making the request), **or** nodes whose reward wallet is in `config.privacy.trustedWallets`, **or** whose wallet holds at least the `trustedMinStakeTier` stake tier (`gold`) **and** whose operator signed the pledge (§4) | Network price | `config.privacy.fallback` (default `upstream_zdr`). `fallback: "network"` is only honoured when nobody asked for trusted explicitly; an explicit trusted request (header, body or key) goes to the ZDR upstream and **never silently to another node** |
| `network` | Any online, idle, reputable node advertising the model | Network price | Plain upstream |
| `upstream_zdr` | OpenRouter with `provider: {data_collection: "deny"}` (zero-data-retention providers only) | List price plus the upstream markup (`requestPricing.upstreamMarkupBps`, 6 % as shipped) | n/a (an upstream error is surfaced; fewer providers qualify, so a model can be unavailable under ZDR) |

Models that are not network models (`config/model-policy.json → networkModels`) go upstream under any
tier; the ZDR flag is set unless the caller explicitly picked `network`.

Every reply says how it was served: headers `x-mesh-privacy` (`trusted | network | upstream_zdr`) and
`x-mesh-served-by`, and in the final SSE chunk (and non-stream JSON):

```json
"mesh": { "route": "node", "nodeId": "node_3f9a…", "privacy": "trusted", "servedBy": "trusted node", … }
"mesh": { "route": "openrouter", "privacy": "upstream_zdr", "servedBy": "upstream (ZDR)" }
```

`servedBy` is one of `your node`, `trusted node`, `network node`, `upstream (ZDR)`, `upstream`.
`your node` means a `trusted` request was served by a Mac whose reward wallet is your own. After a
trusted node fails before producing output, the retry only considers trusted nodes and the final
fallback keeps ZDR (`x-mesh-fallback` carries the reason). A `trusted` job is marked as such in the
queue and the claim is enforced in SQL (`UPDATE … WHERE privacy != 'trusted' OR <node is trusted> OR
<node wallet = job requester wallet>`), so a race between a trusted and an untrusted poller can never
hand plaintext to the wrong machine.

**The owner rule.** Your own Macs are trusted for your own requests: a node whose reward wallet equals
the wallet behind the API key may serve that wallet's `trusted` requests without being allowlisted or
staked + pledged (`trustedVia` reports `owner`). The request's wallet is kept in an internal
`jobs.requester_wallet` column for the claim check only; it is **not** part of the job view a node
receives (`JOB_VIEW_FIELDS` is unchanged, and `privacy.test.ts` asserts it is absent). The rule is
one-directional: owning a node grants nothing for other wallets' requests, and when your node is
offline the usual fallback applies (another trusted node, else the ZDR upstream).

## 3. What we do technically

Gateway

- Anonymised jobs (§1): sanitised messages, whitelisted params, fixed field set, Ollama tag only.
- Trusted-only claims for `trusted` jobs; explicit trusted never degrades to `network`.
- ZDR provider preference on every upstream call unless the caller chose `network`.
- No prompt or reply ever written to disk: `requests_log` and `jobs` hold ids, counts, cost and timing.
  Pino redacts `Authorization`; request bodies are not logged at any level we run.
- `x-mesh-privacy` / `x-mesh-served-by` / `mesh.*` so the client can verify the path on every reply.
- **Spot checks reveal nothing new** (`docs/NODE_PROTOCOL.md` §10). A sampled job is re-run on a
  second node from the *same* stored, anonymised payload — the seven fields of §1, `temperature: 0`,
  no marker that it is a check — and under the *same* tier: a `trusted` job is only re-checked by
  another trusted node (or the ZDR upstream), a `network` job by any eligible node (or the upstream),
  and a `trusted` job served by your own Mac is never re-checked anywhere. So the set of machines
  that can see a prompt is exactly the set the tier already allowed; a check adds one more member of
  that set for one more generation, not a new kind of party. The gateway compares the two outputs in
  memory (token counts, garbage heuristics, a word-overlap score) and stores only the job ids, the
  score, the verdict and short reason codes in `verifications`; neither output is written anywhere.

Node agent (`apps/node-agent`)

- **Nothing to disk.** The log (`~/.mesh/logs/node.log`) receives job id, Ollama tag, token counts,
  chunk count, character count and durations; failure lines carry the error reason. There is no
  code path that logs message or reply text, and `test/privacy.test.ts` plants secrets in a job and
  asserts they are absent from every log line and from the log file.
- **Ollama flags.** `/api/chat` is called with `stream: true` and `keep_alive: "5m"`: weights stay
  warm for the next job, while Ollama drops the request's KV cache when the request ends. When the
  agent starts `ollama serve` itself (`mesh-node setup`) and in the launchd service it sets
  `OLLAMA_NOHISTORY=1` (no `~/.ollama/history` file; only relevant to the interactive CLI, set for
  completeness) and `OLLAMA_DEBUG=0` (the server log stays at request metadata: method, path, status,
  timing). Ollama's own log never contains prompt bodies without debug logging. If you run your own
  `ollama serve`, keep `OLLAMA_DEBUG` unset.
- **Buffers dropped.** When a job finishes (success or failure) the agent empties every message
  object it holds, truncates the arrays and clears its delta buffer (`runner.ts:scrubJob`). JavaScript
  strings cannot be overwritten in place, so this releases the references for garbage collection rather
  than zeroing bytes; we say so rather than claim otherwise.
- **Counts only in every operator surface.** `mesh-node status`, the web Node page and the menu bar
  app (`docs/MENUBAR.md`) show status, uptime, jobs, tokens, earnings and models. None of them has
  access to job content; there is no "recent prompts" view anywhere.

## 4. What we cannot do

- **Plaintext on the serving machine.** The model needs the tokens. A node operator who modifies the
  agent, runs a proxy in front of Ollama, or attaches a debugger to the Ollama process can read every
  prompt that machine serves. The agent is open source and unsigned; we cannot attest that the code
  running on a Mac is ours.
- **Memory inspection.** Even an unmodified agent and Ollama hold the prompt, the KV cache and the
  reply in RAM for the duration of the job. A determined operator with root on their own Mac can dump
  that memory. `scrubJob` shortens the window; it does not close it.
- **Provider behaviour upstream.** `data_collection: "deny"` is a routing preference OpenRouter
  enforces against providers' stated policies. We rely on those statements; we cannot verify them.
- **Inference from the prompt itself.** If the prompt contains your name, your code or your customer
  data, whoever runs the model has it. Anonymised transport does not anonymise content.
- **Traffic analysis.** A node learns when jobs arrive and how long they are. With few clients on a
  model this is correlatable.

The trusted tier is therefore a **policy** control backed by three things: the operator signed a
pledge (§5) with the wallet that receives rewards, that wallet has a gold stake at risk, and the
gateway can revoke trusted status and stop routing to the node. It is not a cryptographic guarantee.
Spot checks (§3) add a fourth, weaker thing: a node that returns garbage or unrelated answers loses
rewards and is quarantined. That protects *quality*, not confidentiality — a node that reads prompts
and still answers correctly passes every check.
Use `upstream_zdr` when a contractual zero-retention commitment from a large provider is the better
trade-off for you, and do not send to any tier what you would not send to a third party.

## 5. The operator pledge

`POST /nodes/:id/pledge {signature, chain?}` (owning wallet session; a node token cannot pledge).
`GET /nodes/:id/pledge` returns the exact text and the node's current status. The text is bound to
the wallet and the node id, has no nonce (so it is stable and reviewable), and its first line differs
from the sign-in and registration messages so no signature can be replayed as another:

```
<domain> asks the operator of Mesh node <nodeId> to pledge:
<wallet>

1. I will not log, store, forward or inspect the prompts or replies this node processes.
2. I will run the unmodified Mesh node agent and Ollama, with debug logging off.
3. I will not run memory-inspection, packet-capture or similar tooling against the node process while it serves jobs.
4. I understand that breaking this pledge forfeits trusted status and accrued rewards for this node.

URI: <uri>
Version: 1
Node ID: <nodeId>
```

The gateway verifies the signature (ed25519 for Solana, EIP-191 for EVM) against the node's reward
wallet and stores `nodes.pledge_at`, `pledge_signature`, `pledge_chain`. A node is trusted when
`trustedVia(node, requesterWallet)` is `owner` (the node's reward wallet is the requesting wallet,
§2), `allowlist` (wallet in `config.privacy.trustedWallets`) or `stake+pledge` (pledge signed **and**
the wallet's stake tier ≥ `config.privacy.trustedMinStakeTier`, read from the per-epoch stake cache). Stake dropping below gold removes trusted status at the next epoch without any
action on our side; an allowlist entry or a config change takes effect immediately.
`GET /nodes/:id` and `GET /me/nodes` include `pledge: {signed, signedAt, trusted, trustedVia,
allowlisted, requiredStakeTier, stakeTier, stakeOk}` so the web Node page can show the card.

Config (`config/tokenomics.json → privacy`, all optional):

```json
"privacy": {
  "default": "trusted",
  "fallback": "upstream_zdr",
  "trustedWallets": [],
  "trustedMinStakeTier": "gold",
  "tiers": { "trusted": true, "network": true, "upstream_zdr": true }
}
```

## 6. Roadmap: confidential compute

The gap in §4 closes only when the serving machine can prove what it runs and keep memory encrypted
from its own operator. Options we are tracking, none of which ships today on consumer Macs:

- **Attested agent builds.** Signed, reproducible `mesh-node` releases plus a remote-attestation
  handshake at registration would let the gateway refuse modified agents. It raises the bar but does
  not stop a root user on the same machine.
- **Confidential VMs / TEEs** (AMD SEV-SNP, Intel TDX, NVIDIA confidential computing on H100-class
  GPUs). A `confidential` tier would route only to attested enclaves, making the plaintext invisible to
  the host operator. This means data-center nodes, not Macs, and a new attestation path in
  `/nodes/register`.
- **Apple Private Cloud Compute-style attestation** for Apple Silicon is not available to third
  parties. If it becomes so, trusted Macs could attest their software stack.

Until one of these lands, the tiers above are the whole story, and the UI copy, this document and the
legal privacy page are kept to it: no "fully private", no "end-to-end encrypted inference".
