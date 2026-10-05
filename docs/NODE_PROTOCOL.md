# Mesh node protocol (gateway ⇄ node agent)

This is the contract `apps/node-agent` implements against `apps/gateway`. Nodes are Macs running
Ollama; they never accept inbound connections. Everything is outbound HTTPS from the node to the
gateway: register once, heartbeat every 20 s, long-poll for jobs, POST chunks back.

All bodies are JSON. Errors are `{error, message, statusCode, requestId}`. Timestamps: `*Ms` are
unix **milliseconds**, everything else unix seconds.

```
node                                        gateway                                   client
 │ POST /nodes/register ──────────────────────►│
 │◄──────────────── {nodeId, nodeToken} ───────│
 │ POST /nodes/:id/heartbeat (every 20s) ─────►│
 │ GET  /nodes/:id/jobs/next (long-poll 25s) ─►│◄──── POST /v1/chat/completions ────────│
 │◄──────────── 200 {jobId, model, messages…} ─│  (job queued → claimed atomically)      │
 │ POST .../jobs/:jobId/chunk {seq, delta} ───►│───── SSE data: {delta} ────────────────►│
 │ POST .../jobs/:jobId/done {tokens…} ───────►│───── SSE final chunk {usage, mesh} ────►│
 │                                             │  bill user $0.02/M · credit node $0.06/M│
```

## 1. Registration

`POST /nodes/register` (no auth). Two ways to prove who gets paid:

> **Public beta** (`config.beta.inviteRequired`, `docs/RUNBOOK.md` "Public beta rollout"): the reward
> wallet must already be *admitted* — it signed in to the web app with an invite code, or an admin
> admitted it from the waitlist — else registration answers `403 invite_required`. The link-code flow
> (A) satisfies this by construction, since the wallet signed in first.

**A. Link code (default; what the installer and `mesh-node setup --link` do).** The wallet signs in the
browser; the Mac only ever sees a short one-time code.

```json
{ "linkCode": "K7QM2XDA", "chip": "M3 Max", "ramGb": 64, "models": ["llama3.1:8b", "qwen2.5:7b"], "agentVersion": "0.3.0", "maxParallel": 2, "nodeId": "optional-stable-id" }
```

**B. Signed (direct).** The caller signs the challenge itself (web app, a script with a key, or an
operator pasting a signature):

```json
{ "wallet": "7xKq…", "nonce": "…", "signature": "…", "chain": "solana", "chip": "M3 Max", "ramGb": 64, "models": ["llama3.1:8b"], "agentVersion": "0.3.0" }
```

→ `200 { "nodeId": "node_3f9a…", "nodeToken": "mesh_nt_…", "wallet": "7xKq…", "walletVerified": true, "linked": true, "maxParallel": 2, "heartbeatEverySec": 20, "offlineAfterSec": 90, "pollMaxWaitMs": 25000 }`

- `nodeToken` is shown **once**; the gateway stores only its sha256. Keep it on disk (`~/.mesh/config.json`).
  It is the bearer for every `/nodes/:id/*` call: `Authorization: Bearer mesh_nt_…`.
- `wallet` in the response is the reward wallet the node is bound to (from the link code in flow A).
  The agent stores it; it never needs to be typed on the Mac.
- `models` are **Ollama tags** exactly as `ollama list` prints them (`llama3.1:8b`). The gateway maps
  client-facing names to tags via `config/model-policy.json → networkModels`
  (`{"llama-3.1-8b": "llama3.1:8b", …}`); a node is only offered jobs for tags it advertises.
- `maxParallel` (optional, default 1) is how many jobs the node can run **at once** — the agent sets it
  from `mesh-node config set maxParallel N` and mirrors it into `OLLAMA_NUM_PARALLEL` for the
  `ollama serve` it launches. The gateway caps it at `config.routing.maxParallelPerNode` (4) and echoes
  the accepted value back as `maxParallel`; it routes at most that many concurrent jobs to the node and
  lets it park that many long-polls (§3). Each extra slot needs RAM for another copy of the model's
  context, so the default stays 1.
- `nodeId` is optional. Omit it and the gateway generates one. Pass your stored id to re-register
  after a reinstall; re-registering an existing id **requires its current token** (else `409 node_exists`)
  and rotates the token. A `409` does not consume a link code.
- Wallet ownership must be **proven** (`config/tokenomics.json → nodes.requireSignature`, default `true`;
  `NODES_REQUIRE_SIGNATURE=false` on the gateway re-enables the legacy unsigned `{wallet, …}` body for
  dev/demo, which is what `mesh-node setup --wallet <addr>` sends). The agent never holds a key, so on a
  signed gateway it uses flow A.

### 1a. Link codes (`POST /nodes/link`)

```
browser (wallet connected, session JWT)              gateway                          Mac
 │ POST /nodes/register/challenge {wallet} ───────────►│
 │◄──────────────────── {nonce, message} ──────────────│
 │ wallet.signMessage(message)                         │
 │ POST /nodes/link {nonce, signature, chain} ────────►│  (Authorization: Bearer <session JWT>)
 │◄──────────── {code: "K7QM2XDA", expiresAt} ─────────│
 │   show code + `install-node.sh … --link K7QM2XDA`   │
 │                                                     │◄── POST /nodes/register {linkCode, chip, …} ──│
 │                                                     │─── {nodeId, nodeToken, wallet} ──────────────►│
```

1. `POST /nodes/register/challenge {wallet}` → `{nonce, message, expiresAt, requireSignature}`.
   `message` is a SIWE-style text whose first line is `<domain> wants to register a Mesh node paid to:`
   (deliberately different from the `/auth` sign-in text so neither signature can be replayed as the
   other). The nonce is single use, 5 minutes, and bound to `wallet`.
2. The wallet signs `message` (Phantom/Solflare `signMessage` → base58 ed25519; MetaMask `personal_sign`
   → EIP-191 hex). `POST /nodes/link {nonce, signature, chain?}` with the **session JWT** of that same
   wallet (`Authorization: Bearer <jwt>`, from `/auth/verify`). The gateway verifies the signature over
   the challenge for the session wallet and returns
   `200 { "code": "K7QM2XDA", "wallet", "chain", "expiresAt", "expiresInSec": 900 }`.
   Errors: no/invalid session `401 unauthorized`; nonce missing, expired, reused, or issued to another
   wallet / for `/auth` → `400 nonce_missing`; wrong signer → `401 bad_signature`; more than 5 live codes
   for the wallet → `429 too_many_link_codes`.
3. The code is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), valid **15 minutes**,
   **single use**, bound to the signing wallet. Case and separators are ignored on input (`k7qm-2xda`
   works). The gateway stores only its sha256 (`node_link_codes`).
4. On the Mac: `mesh-node setup --link K7QM2XDA` (or the installer with `--link`). The agent sends
   `{linkCode, chip, ramGb, models, agentVersion}` to `/nodes/register`; the gateway binds the node to the
   code's wallet, consumes the code atomically, and answers with `wallet` and `walletVerified: true`.
   Errors: `400 link_code_invalid` (unknown), `400 link_code_expired`, `400 link_code_used`,
   `400 link_code_wallet_mismatch` (a `wallet` was also sent and differs from the code's).
5. `/nodes/register`, `/nodes/register/challenge` and `/nodes/link` share a per-IP budget of
   `NODE_REGISTER_RATE_LIMIT` (10) calls per hour. A wallet may own at most `nodes.maxPerWallet` (20)
   nodes (`429 too_many_nodes`).

### 1b. Signed registration (direct)

Same challenge as above, optionally with `nodeId` (then `message` includes `Node ID: <nodeId>` and the
signature only registers that id). Sign it and call `POST /nodes/register {wallet, nonce, signature,
chain?, ...}`. Unsigned on a signed gateway → `401 signature_required`; wrong signer / changed `nodeId`
→ `401 bad_signature`; reused or expired nonce → `400 nonce_missing`. Re-registering an existing
`nodeId` needs **both** the signature (or a link code) and the current node token.

### 1c. Operator pledge (`GET` / `POST /nodes/:id/pledge`)

To serve `trusted` jobs a node needs its reward wallet allowlisted (`config.privacy.trustedWallets`)
**or** a stake at the `config.privacy.trustedMinStakeTier` tier (`gold`) **and** a signed operator
pledge. Both calls take the **owning wallet's session JWT** (the node token is not accepted: the Mac
never holds a key, so pledging happens in the web app, Node page → "Sign the operator pledge").

- `GET /nodes/:id/pledge` → `{nodeId, wallet, message, signed, signedAt, chain, trusted, trustedVia,
  allowlisted, requiredStakeTier, stakeTier, stakeOk}`. `message` is the exact text to sign
  (`auth.ts:pledgeMessage`, reproduced in `docs/PRIVACY.md` §5): bound to the wallet and node id, no
  nonce, first line `<domain> asks the operator of Mesh node <nodeId> to pledge:`.
- `POST /nodes/:id/pledge {signature, chain?}` verifies the signature for the node's wallet and stores
  `pledge_at`, `pledge_signature`, `pledge_chain`. Errors: `401 unauthorized` (not the owning wallet /
  node token), `401 bad_signature`, `404 unknown_node`. Response is the same status object.
- `GET /nodes/:id` and `GET /me/nodes` carry the same object under `pledge`.

## 2. Heartbeat

`POST /nodes/:id/heartbeat` (node token), every **20 s**:

```json
{ "models": ["llama3.1:8b"], "busy": false, "loadAvg": 1.7, "maxParallel": 2 }
```

→ `200 { "ok": true, "heartbeatEverySec": 20, "offlineAfterSec": 90, "queuedJobs": 0, "maxParallel": 2 }`

- A node with no heartbeat (or job pull) for 90 s is **offline** and is not routed to.
- `models` replaces the advertised tag list (send it every time; it is cheap). `ramGb`/`chip` may be
  included to update hardware info; `maxParallel` updates the slot count (capped as in §1, the accepted
  value is echoed back).
- **`busy` is a pin, not a count.** The gateway tracks the jobs running on each node itself (claim →
  done/fail), so a heartbeat never has to say "I am on a job". `busy: true` means *route nothing here
  until I say otherwise* — the node is paused, shutting down, or full by its own account — and stays in
  force until a later heartbeat sends `busy: false`, which only lifts the pin and never resets the
  running count. Omitting `busy` leaves the pin as it was. Because the pin persists, a node that pins
  itself when it fills up should heartbeat `busy: false` as soon as a slot frees instead of waiting for
  the next 20 s tick (the reference agent does; otherwise it idles for up to one interval after every
  job). A node with `maxParallel > 1` must **not** pin busy while it still has a free slot.
- Each heartbeat is written to the `heartbeats` table (pruned to 48 h) and drives `uptimePct24h`.

## 3. Pulling jobs

`GET /nodes/:id/jobs/next?wait=25000` (node token). Long-poll: the gateway holds the request up to
`wait` ms (max 25 000, default 25 000) and answers

- `204` — nothing for you; poll again immediately.
- `200` — one job, now **claimed by you** (atomic; no other node will get it):

```json
{
  "jobId": "job_Qm3…",
  "model": "llama3.1:8b",
  "messages": [{ "role": "user", "content": "…" }],
  "params": { "temperature": 0.2, "top_p": 0.9, "stop": ["\n\n"] },
  "maxTokens": 1024,
  "deadlineMs": 1727950000000,
  "attempt": 1
}
```

- **These seven fields are the whole job** (`network.ts:JOB_VIEW_FIELDS`; asserted by
  `test/privacy.test.ts`). A node never receives the wallet, API key, request id, client IP, user
  agent, the client-facing model name, or any client identifier. See `docs/PRIVACY.md` §1.
- `model` is the Ollama tag to run. `messages` are reduced to `role` + `content` (string or
  `{type:"text", text}` parts; OpenAI `name`, tool fields and non-text parts are stripped by the gateway).
  `params` carries only whitelisted OpenAI sampling params (`temperature`, `top_p`, `top_k`, `stop`,
  `seed`, `presence_penalty`, `frequency_penalty`, `repeat_penalty`, `response_format`); map them to
  Ollama `options`. `maxTokens` → `num_predict`.
- `deadlineMs`: abort generation if you have not finished by then; the gateway has already given up.
- Privacy tiers (`docs/PRIVACY.md` §2): a job queued under the `trusted` tier is only offered to, and
  only claimable by, nodes that are trusted (allowlisted wallet, or gold stake + signed pledge, §1c).
  The job payload itself is identical across tiers; the node is not told which tier it is serving.
- A pull also counts as liveness (updates `last_seen`), but keep heartbeating so `busy`/`models` stay fresh.
- Up to `maxParallel` long-polls per node may be parked at once; an older surplus one is answered `204`
  immediately. The gateway never hands a node more running jobs than its `maxParallel`, so a node may
  either run one poll loop that only polls while it has a free slot (the reference agent) or one
  poller per slot (the load-test nodes).
- Nodes whose reputation is below the threshold (see §6) get `204` even when jobs are queued.

Run at most `maxParallel` jobs at a time (default 1). Start streaming **immediately**: the gateway's
first-chunk timer is `routing.firstTokenTimeoutMs` (8 s) from job creation, which includes your pull latency.

## 4. Streaming the result

`POST /nodes/:id/jobs/:jobId/chunk` (node token) for every piece of text:

```json
{ "seq": 0, "delta": "Hello" }
```

- `seq` starts at 0 and increases by 1 per chunk. The gateway re-orders out-of-order chunks and drops
  duplicates, so retrying a failed POST is safe.
- `200 {ok:true}` → keep going. `409 job_not_running` → **stop generating**: the job timed out, the
  client disconnected, or the job was handed to another node. No further POSTs will be accepted.
- Gaps between chunks longer than `routing.stallTimeoutMs` (6 s) fail the job. Ollama emits tokens
  faster than that; if you batch, flush at least every 2 s.

Finish with exactly one of:

`POST /nodes/:id/jobs/:jobId/done`
```json
{ "promptTokens": 41, "completionTokens": 128, "finishReason": "stop" }
```
→ `200 { "ok": true, "usage": { "promptTokens": 41, "completionTokens": 128, "finishReason": "stop" } }`

- **Token counts**: send `prompt_eval_count` / `eval_count` from Ollama's final message; `finishReason`
  is `stop` | `length`. They are what the client is billed and you are paid for, so the gateway
  **clamps** them to what the job could have produced: `completionTokens ≤ maxTokens` and
  `promptTokens ≤ 4 × payload bytes + 1024` (tokenisers vary; CJK/emoji can be several tokens per
  character). The accepted values come back in `usage`. Each field is an integer 0..10 000 000 (missing
  → 0). If Ollama omitted a count (some versions skip `prompt_eval_count` for a fully cached prompt)
  the reference agent estimates `ceil(chars / 4)` rather than sending 0, so the clamp is a backstop,
  not the normal path.
- **`409 empty_output`**: a `done` for a job on which **no chunk was ever delivered** is not a reply.
  The gateway marks the job failed (`error = empty_output`, node fault), pays nothing, and answers
  `409 {error: "empty_output"}`. Do not follow up with `/fail` (it would get `409 job_not_running`);
  log it and move on. If your model produced an empty reply, POST `/fail` yourself with a reason
  instead of `done`.

`POST /nodes/:id/jobs/:jobId/fail`
```json
{ "error": "ollama: model not found" }
```
`error` is 1–500 characters; control characters are stripped (it ends up in a response header). Never
put prompt or reply text in it.

Both answer `200 {ok:true}` or `409 job_not_running` (`done` also `409 empty_output`). After `done`
the gateway bills the user, credits your wallet, and emits the final SSE chunk to the client. A `409`
on `chunk`, `done` or `fail` means the gateway has already closed the job: stop, and do not report
anything further for it.

## 5. What the client sees

The gateway relays your chunks as standard OpenAI SSE (`chat.completion.chunk` with
`choices[0].delta.content`), under the model name the client asked for. The final chunk carries
`usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`) plus a Mesh extension:

```json
"mesh": { "route": "node", "nodeId": "node_3f9a…", "chip": "M3 Max", "jobId": "job_Qm3…", "attempt": 1,
          "privacy": "trusted", "servedBy": "trusted node" }
```

`privacy` is the tier the reply was served under (`trusted | network | upstream_zdr`) and `servedBy`
the label for it (`trusted node`, `network node`, `upstream (ZDR)`, `upstream`). Upstream-served
replies (fallback or `upstream_zdr`) carry `"mesh": {"route": "openrouter", "privacy": …, "servedBy": …}`
in a final chunk the gateway adds before `[DONE]` (it repeats the upstream's `usage`).

Response headers: `x-mesh-route: node:<nodeId>` (or `openrouter`/`mock`), `x-mesh-privacy`,
`x-mesh-served-by` and, after a fallback, `x-mesh-fallback: <reason>` (`no_trusted_node` when a
trusted request found no trusted node online). Non-stream requests get the same `usage` and `mesh`
fields in the completion JSON. Clients pick the tier with `X-Mesh-Privacy: trusted|network|upstream_zdr`
or `mesh.privacy` in the body; see `docs/PRIVACY.md` §2.

## 6. Timeouts, retries, fallback (gateway side)

| Situation | Gateway does | Job row |
| --- | --- | --- |
| No node claimed within `firstTokenTimeoutMs` | fallback to OpenRouter (same client request, nothing was sent yet) | `fallback`, `error=unclaimed`, no node blamed |
| Claimed, no first chunk within `firstTokenTimeoutMs` | re-queue **once** to another eligible node (excluding yours), else fallback | `failed`/`fallback`, `node_fault=1` |
| Gap between chunks > `stallTimeoutMs`, or `deadlineMs` passed | if **nothing** reached the client yet: re-queue/fallback as above. If partial output was already streamed: **no fallback**; the client gets an in-stream `{"error": {"code": "node_stream_failed"}}` chunk then `[DONE]`, and is **not charged** | `failed`, `node_fault=1` |
| You POST `/fail` | same rule: before any output → re-queue/fallback; after partial output → error surfaced | `failed`/`fallback`, `node_fault=1` |
| Client disconnects | job abandoned; your next POST gets `409` | `failed`, `error=client_disconnected`, `node_fault=0` |

A fallback is invisible to the client (one continuous response, served by OpenRouter, billed at
OpenRouter cost); the final chunk's `mesh.servedBy` says `upstream (ZDR)` / `upstream`. A re-queued
job arrives at the second node with `attempt: 2` and the same payload; for a `trusted` job the second
node must be trusted too, and the fallback keeps the ZDR provider preference.

**Reputation.** Per node, over its last 100 scored jobs (`done` + node-fault failures):
`successRate = done / scored` and `avgFirstTokenMs` (claim → first chunk). A node with at least
`routing.reputationMinJobs` (5) scored jobs and `successRate < routing.minSuccessRate` (0.8) is
excluded from routing and from pulling until newer jobs lift it back. Client-fault failures do not count.
A spot-check `mismatch` (§10) on one of the window's jobs adds `verification.mismatchPenalty` (3)
failures to `scored`; a quarantined node is excluded regardless of its rate.

## 7. Money

- **User price** for a network-served request: `requestPricing.networkPricePerMTokens` ($0.02) per 1M
  total tokens (prompt + completion), debited from the user's credits as `kind='usage'`.
- **Node reward**: `nodeRewards.usdPerMTokens` ($0.06) per 1M total tokens per completed job, written to
  the `node_rewards` ledger (`wallet, node_id, job_id, kind='node_reward', tokens, usd_micros, status`). Rewards
  are USD-denominated accruals; on-chain payout from the treasury share is a later step
  (`kind='payout'` rows will offset them). Failed / fallback jobs earn nothing. A job whose spot check
  (§10) came back `mismatch` has its row set to `status='withheld'` and earns nothing either.

## 8. Stats

- `GET /nodes/:id` — node token **or** a wallet session (JWT) owning the node:
  `{status: idle|busy|offline, online, busy, runningJobs, maxParallel, quarantined, uptimePct24h, jobs24h, jobsDone24h, jobsFailed24h, tokens24h, earnedUsd24h, earnedUsdTotal, reputation: {jobs, successRate, avgFirstTokenMs, mismatches, eligible, window, minSuccessRate}, verification: {…, §10}, models, chip, ramGb, loadAvg, agentVersion, lastSeen, createdAt}`.
  `uptimePct24h` = minute-buckets with ≥1 heartbeat ÷ minutes in the window (24 h, capped at the node's age).
- `GET /me/nodes` (session) — the wallet's nodes with the same view, plus `earnedUsdTotal`.
- `GET /nodes` (public) — `online/total/busy/idle`, `slots` (Σ `maxParallel` over online nodes),
  `runningJobs`, `queuedJobs`, `chips`, `models`, `jobs24h`, `servedByNetwork24h`, `tokens24h`,
  `servedByNetworkPercent`. A node counts as `busy` only when every slot is taken (or it pinned itself). No wallets or tokens.
- Verification counters per node: §10.
- `GET /stats` (public) — `servedByNetworkPercent` (24 h, real), `servedByNetwork24h`, `jobs24h`,
  `networkTokens24h`, `networkPricePerMTokens`, `nodeRewardUsdPerMTokens`.

## 10. Spot-check verification

Strangers run nodes, so the gateway checks a sample of the work (`apps/gateway/src/verification.ts`,
`config/tokenomics.json → verification`, tests in `test/verification.test.ts`). Nothing here changes
what a node does; it only changes what happens to a node that returns bad answers.

```json
"verification": { "enabled": true, "sampleRate": 0.05, "minJobsBeforeTrust": 20, "mismatchPenalty": 3, "quarantineAfterMismatches": 2 }
```

**What is checked.** After a network job completes and the client has its reply, the gateway draws a
random number per job. With probability `sampleRate` (5 %) — or **3×** that for a node with fewer than
`minJobsBeforeTrust` (20) scored jobs — it re-runs the *same* job: identical anonymised payload
(`jobs.payload`, §3), `temperature: 0`, same `maxTokens`, same privacy tier, `excludeNodeId` set to the
primary node. The re-run goes to another eligible node of the same tier (a `trusted` job is only
re-checked by another trusted node), or to the upstream (OpenRouter under ZDR, or the mock) when no
second node is online. **Never checked:** a `trusted` job served by the requester's own node (owner
rule), and check jobs themselves. The check node sees an ordinary job — the seven fields of §3, nothing
marking it as a check — and is paid the normal reward for it; the client is not billed for the check.

**How outputs are compared** (`compareOutputs`): three cheap heuristics, lenient on purpose because
the client's request may have sampled at a high temperature.

| Check | Rule | Effect |
| --- | --- | --- |
| Garbage | primary output empty, > 5 % U+FFFD / control characters, a run of ≥ 40 identical characters, < 8 % distinct words over ≥ 12 words, or < 30 % letters/digits over ≥ 40 chars | `mismatch` on its own |
| Token-count sanity | the two `completionTokens` must agree within 50 % (smaller ≥ half the larger); the primary's claimed count must be within 5× of `chars / 4` | claim implausible → `mismatch`; counts disagree → `suspect` (or `mismatch` with the next row) |
| Similarity | Jaccard over word bigrams (unigrams for texts under 4 words), 0..1 | `< 0.2` → `suspect`; `< 0.05` **and** token counts disagree → `mismatch` |

If the check could not run at all (second node failed and the upstream errored) the row is
`inconclusive` and nothing happens.

**Consequences.** Every check is a row in `verifications` (`job_id, check_job_id, primary_node,
check_node, score, verdict ok|suspect|mismatch|inconclusive, reasons`). A `mismatch`:

1. withholds the primary node's reward for that job — the `node_rewards` row is marked
   `status='withheld'`, its treasury accrual is reversed, and it counts for nothing in `earnedUsd*`,
   `/report` or the admin totals;
2. counts as `mismatchPenalty` (3) node-fault failures in the reputation window (§6), so one mismatch on
   a node with four successes drops it to 4/7 = 57 % and below the 80 % routing threshold;
3. after `quarantineAfterMismatches` (2) mismatches within the window the node is **quarantined**:
   `nodes.quarantined_at` is set, it is excluded from routing, `GET /nodes/:id/jobs/next` returns `204`
   even with jobs queued, and it stays that way until an admin clears it
   (`POST /admin/nodes/:id/quarantine/clear`; `POST /admin/nodes/:id/quarantine {reason}` quarantines
   by hand).

`suspect` has no consequence beyond the row; it is there so a pattern is visible before it becomes
mismatches. Operators see their counters on `GET /nodes/:id` → `verification`
`{checked, ok, suspect, mismatch, inconclusive, lastVerdict, lastAt, quarantined, quarantinedAt,
quarantineReason, enabled, sampleRate}` and on the web Node page; the admin overview carries the
network-wide counts, the latest verdicts and a per-node column, plus a "Clear" button for quarantines.

**What this does and does not catch.** It catches a node that returns nothing, noise, a stuck loop,
inflated token counts or an answer to a different question; it does not prove an answer is *good*,
and two honest nodes running the same weights at temperature 0 can still differ in wording, which is
why `suspect` is the floor for mere disagreement. Spot checks are a sampling control, not a per-job
guarantee: at 5 % a bad node is expected to be caught within its first few dozen jobs (sooner while
it is new, at 15 %).

## 11. Agent loop (reference)

```
token = load() or register({..., maxParallel: P})
every 20s: heartbeat({models, busy: paused || stopping || running >= P, loadAvg, maxParallel: P})
           (also right away when a slot frees after the last heartbeat pinned busy, and on pause/resume)
loop:
  if running >= P: wait for a slot
  r = GET /nodes/:id/jobs/next?wait=25000
  if 204: continue
  job = r.body; spawn:
    seq = 0; chunks = 0
    for part in ollama.chat(model=job.model, messages=job.messages, options=map(job.params, job.maxTokens), stream=true):
       if now > job.deadlineMs: break
       res = POST chunk {seq, delta: part.message.content}; seq++; chunks++
       if res.status == 409: abort generation; stop (do not POST fail)
    if chunks == 0: POST fail {error: "model produced no output"}
    else POST done {promptTokens: part.prompt_eval_count ?? ceil(promptChars/4), completionTokens: part.eval_count ?? ceil(replyChars/4), finishReason}
         (409 empty_output / job_not_running -> log, move on)
    (on exception: POST fail {error})
```

Retry transient network errors (and 5xx / 429, honouring `retry-after`) on `chunk` once with the same
`seq`. Back off with jitter (1 s → 60 s) when the gateway is unreachable or answers 5xx/429 on poll
or heartbeat; never give up, never spin. Store `nodeId` + `nodeToken` locally (0600). If the gateway
answers `401`/`404` on heartbeat or poll the token is gone (database reset): register again without
`nodeId` to get a fresh identity (an existing id cannot be re-claimed without its token) — and if the
very next call is rejected again, back off rather than re-registering in a loop.

**Agent privacy rules** (`docs/PRIVACY.md` §3; the reference agent does all of this and
`apps/node-agent/test/privacy.test.ts` checks it): never write `messages` or deltas to disk or to a
log (log ids, counts and timings only); call Ollama with `keep_alive` set and leave `OLLAMA_DEBUG`
off (`mesh-node` sets `OLLAMA_NOHISTORY=1`, `OLLAMA_DEBUG=0` for the `ollama serve` it launches and in
its launchd plist); drop every reference to the job's text once `done`/`fail` is sent; show operators
counts and earnings only. A trusted node's operator has signed exactly these commitments (§1c).

## Known gaps

- Signed registration is live on the gateway (§1); `apps/node-agent` still needs the `--signature/--nonce`
  flags and the web node page needs the "sign challenge" button (operators can do it by hand until then).
- Live relays are in-process: one gateway instance. Jobs are persisted, so a restart fails them cleanly (`deadline_exceeded`).
- `maxParallel` slots are per node and the gateway trusts the advertised number (capped at 4); it
  does not yet verify that a node really keeps up with that many streams beyond the stall timers.
