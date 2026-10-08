# Relay load test (gateway ⇄ fake nodes ⇄ concurrent clients)

`scripts/loadtest/relay.mjs` boots the gateway in mock mode (mock chain adapter, offline mock
upstream, `NODES_REQUIRE_SIGNATURE=false`), registers **N** fake nodes that answer every job with a
fake stream of **T** chunks (`POST …/chunk` per token, then `POST …/done`), fires **M** chat requests
at `POST /v1/chat/completions` (`stream: true`, model `mesh/mock`) and reports first-token latency,
total latency, route split, throughput and failures. Nothing in `apps/` is modified or mocked; the
only non-default gateway settings are the rate limits (`V1_RATE_LIMIT`, `NODE_REGISTER_RATE_LIMIT`)
lifted so the burst is not throttled, and `EPOCH_CRON=off`, `ALERTS_ENABLED=false`.

```sh
pnpm --filter @mesh/config --filter @mesh/chain-adapter build   # once
pnpm loadtest                                   # N=20 nodes, M=200 requests, 300 tokens/job
node scripts/loadtest/relay.mjs --nodes 20 --requests 200 --concurrency 20 --json out.json
node scripts/loadtest/relay.mjs --gateway http://127.0.0.1:8787 --admin-token dev-admin-token   # against pnpm dev
```

Exit code is 1 if any request failed (so it can gate CI), 2 on a setup error.

> **Run it with `VERIFICATION_ENABLED=false`** (the gateway child inherits the environment). The fake nodes
> answer every job with `tok tok tok …`, which the spot-check heuristics (`verification.ts`,
> `repeated_words`) rightly flag as garbage: with verification on, sampled nodes lose reputation after
> their first check, drop out of routing and get quarantined, so the fleet shrinks to the few nodes not yet
> sampled and the route split says nothing about the relay. `scripts/loadtest/relay.mjs` does not set it
> itself (the script is outside the gateway tree); the 2026-10-04 runs below were made with it set.

## Results, 2026-10-03

Host: 2 vCPU Intel Xeon 2.1 GHz, 8 GB RAM, Linux; Node 22. Gateway, fake nodes and clients all
share these two cores, so absolute numbers are a floor, not what a dedicated VPS does. The mock
upstream streams its canned reply at 15 ms per word, which is why "upstream" totals sit at ~0.5–1 s.
Every run: **0 failed requests, 0 node-side errors, no 5xx, no 429.**

### Run 1 — N=20 nodes, M=200 requests, all 200 in flight at once (the requested scenario)

| metric | value |
| --- | --- |
| wall time | 3.77 s |
| throughput | 53.1 req/s · 2,594 tokens/s delivered to clients |
| route split | **20 node-served, 180 upstream** (`x-mesh-route: mock`) |
| first token p50 / p95 / p99 / max (all) | 439 / 686 / 790 / 794 ms |
| first token p50 / p95 (node route) | 234 / 794 ms |
| first token p50 / p95 (upstream) | 481 / 686 ms |
| total p50 / p95 (node route, 300 chunks) | 3,737 / 3,768 ms |
| total p50 / p95 (upstream) | 903 / 1,155 ms |
| node → gateway `POST /chunk` p50 / p95 / p99 | 7.9 / 27.5 / 38.6 ms (6,000 posts) |
| jobs per node | exactly 1 each |

### Run 2 — N=20, M=200, concurrency 20 (never more clients than idle nodes: pure node path)

| metric | value |
| --- | --- |
| wall time | 20.9 s |
| throughput | 9.6 req/s · **2,872 tokens/s** relayed |
| route split | **200 node-served, 0 upstream** (`servedByNetworkPercent: 100`) |
| first token p50 / p95 / p99 / max | **19 / 93 / 119 / 121 ms** |
| total p50 / p95 / p99 (300 chunks) | 1,897 / 3,618 / 3,672 ms |
| node → gateway `POST /chunk` p50 / p95 / p99 / max | 4.8 / 17.1 / 26.4 / 60.9 ms (60,000 posts) |
| jobs per node | exactly 10 each (fair: oldest-queued-first + one job per node) |

### Run 3 — N=20, M=200, concurrency 40

| metric | value |
| --- | --- |
| wall time | 4.33 s |
| throughput | 46.1 req/s · 2,257 tokens/s |
| route split | 20 node-served, 180 upstream |
| first token p50 / p95 (all) | 51 / 176 ms |
| total p50 (upstream) / total p50 (node) | 469 ms / 4,316 ms |
| node → gateway `POST /chunk` p50 / p95 | 11.4 / 33.6 ms |

Raw JSON for each run (every sample) is produced with `--json`; the three above were written to the
scratch directory and are summarised here rather than committed.

## What the numbers say

- **The claim/relay machinery is correct under contention.** 60,000 chunk POSTs, 200 atomic claims
  across 20 long-polling nodes, zero duplicate or lost chunks (every stream ended with
  `finish_reason: stop` and exactly 300 content deltas), zero `409 job_not_running`, no fallbacks.
- **First-token latency on the node path is excellent** when a node is idle: 19 ms p50, <120 ms p99
  (run 2). The 234–794 ms seen in run 1 is the client burst itself (200 connections opened in the
  same tick on 2 cores), not the relay.
- **Per-token relay cost is the ceiling.** Every token is one HTTP round trip plus a SQLite read; the
  gateway sustains ~2,600–2,900 tokens/s on this box regardless of N. A real 8B model on an M-series
  Mac emits ~30–80 tokens/s, so 20 nodes ≈ 600–1,600 tokens/s: fine. Around **40–60 busy nodes** on a
  2-core gateway the relay, not the Macs, becomes the limit. With chunk POSTs serialised per node at
  ~5–11 ms each, a 300-token reply takes 1.9–4.3 s end to end even though a node "generates" it
  instantly.
- **Burst traffic is mostly not served by the network.** In runs 1 and 3 only 20 of 200 requests
  reached a node even though 20 healthy nodes were online; see bottleneck 1.

## Bottlenecks found (2026-10-03; status updated 2026-10-04, see "Results, 2026-10-04 (after fixes)")

| # | Bottleneck | Status 2026-10-04 |
| --- | --- | --- |
| 1 | No queueing when every node is busy | **Fixed** — `routing.queueWaitMs` (6 s) bounded wait, `routing.maxQueueDepthPerNode` (3) |
| 2 | One job per node | **Fixed** — `maxParallel` on register/heartbeat, `busy` is a count, cap `routing.maxParallelPerNode` (4) |
| 3 | One SQLite read per token | **Fixed** — `JobBroker.chunk` answers from the relay; DB only when the relay is missing |
| 4 | O(online nodes) queries per request | **Fixed** — reputation cache (60 s, invalidated on done/fail/mismatch) + 1 s online-node snapshot with live running counts |
| 5 | Heartbeat write amplification | **Fixed** — prune on the broker's 60 s maintenance timer, queued count cached 2 s |
| 6 | Single-process relay | Open (by design, one VPS) |
| 7 | SQLite on the event loop | Open (3 and 5 removed the per-token and per-heartbeat work; Postgres not warranted yet) |
| 8 | Default rate limits break the scenario | **Fixed** for registration (per-wallet strict + per-IP backstop); `V1_RATE_LIMIT` documented in the OpenAPI description |
| 9 | Uncached `GET /nodes` | **Fixed** — same `STATS_CACHE_MS` cache as `/stats` |
| 10 | Relay observability | Open — `/health.network` now has `liveRelays` / `waitingNodes` / `queuedJobs` gauges, but no queued-job age, relay depth or chunk-latency alert yet |

1. **No queueing when every node is busy — straight to OpenRouter.** `decideRoute`
   (`apps/gateway/src/routing.ts`) only returns `target: 'node'` when an *idle* (`busy = 0`) node
   advertises the tag at the instant the request arrives; otherwise `reason: 'no_online_node'` and
   the request is served upstream at the upstream price (list plus the markup, `docs/PRICING.md` §2). Under a burst 90 % of requests bypass the network
   that exists to serve them (runs 1 and 3: 180/200 upstream, `servedByNetworkPercent` 10). The
   `JobBroker` already supports queued jobs with `firstTokenTimeoutMs` (8 s) and `unclaimed`
   fallback, so the fix is routing policy: when nodes advertising the tag are *online* (busy or not),
   queue the job and let the fallback timer decide, or add a bounded wait (e.g. queue depth ≤ online
   nodes × k). Related: `eligibleNodes` is also what gates the one retry.
2. **One job per node (`nodes.busy`).** `tryClaim` sets `busy = 1`, `freeNode` clears it only when no
   job is running on the node (`apps/gateway/src/network.ts`). Ollama can run several requests
   concurrently (`OLLAMA_NUM_PARALLEL`); there is no per-node concurrency advertised in
   `/nodes/register` or `/heartbeat` and no knob in `config/tokenomics.json → routing`. This multiplies
   bottleneck 1.
3. **One HTTP request + one SQLite read per token.** `JobBroker.chunk` does `SELECT * FROM jobs`
   (full row including the request payload JSON) for every delta to check `status`/`node_id`, then
   pushes to the in-memory `JobRelay`; the first chunk also issues an `UPDATE jobs SET first_chunk_ms`.
   Measured cost 5–11 ms p50 per chunk under load, i.e. 60,000 requests for 200 replies. The real
   agent (`apps/node-agent/src/runner.ts`) already coalesces tokens into one POST per ~40 ms /
   2 KB and keeps one POST in flight per job, so in production a 50 tok/s node sends ~25 chunk
   POSTs per second, not 50; this test is the worst case (one token per POST) and so a stress test of
   the gateway side. Still worth doing: check the relay (`relays.get(jobId)?.nodeId`) instead of the
   DB on the hot path and read the DB only when the relay is missing; longer term a single streaming
   request body or WebSocket per job.
4. **Routing cost is O(online nodes) SQL queries per chat request.** `eligibleNodes` →
   `onlineNodes` (one query) then `nodeReputation` per node (a `SELECT … LIMIT 100` each) on
   *every* `/v1/chat/completions`, plus again in `pull()` on every long-poll wake-up. At 20 nodes
   that is ~21 queries per request before a job is even created; it grows linearly with the fleet.
   Cache reputation per node (invalidate on `done`/`fail`), or keep an in-memory index of
   online/idle nodes per tag maintained by heartbeat/claim/free.
5. **Heartbeat write amplification.** `recordHeartbeat` runs `DELETE FROM heartbeats WHERE ts < ?`
   on *every* heartbeat and every registration (20 nodes × every 20 s = 1 prune/s today, N/20 per
   second in general), and `/nodes/:id/heartbeat` also runs `SELECT COUNT(*) FROM jobs WHERE
   status='queued'`. Move the prune to a timer (once a minute) and cache the queue depth.
6. **The live relay is single-process.** `JobBroker.relays` / `waiters` are in-memory maps; a job
   created on gateway A can only receive chunks on gateway A. Horizontal scaling needs sticky
   routing per `jobId` (nodes already know the gateway URL they registered with) or an external
   pub/sub (Redis/NATS) for `RelayEvent`s. See `docs/ARCHITECTURE.md → Scaling later`.
7. **SQLite + synchronous `better-sqlite3` on the event loop.** Every claim, chunk read,
   `requests_log` + `credits_ledger` + `node_rewards` write and `/stats` aggregation runs on the one
   Node thread; WAL allows one writer. It held at 60k chunk requests with p99 26 ms, but the
   `POST /chunk` max of 684 ms in run 1 (when 200 clients connected in the same tick and 180 upstream
   streams were being relayed) shows the loop stalling. Keep SQLite, but move per-token work off it
   (bottleneck 3) and batch heartbeat/stat writes (bottleneck 5) before considering Postgres.
8. **Default rate limits would break this scenario in production.** `V1_RATE_LIMIT` is 120 req/min
   *per API key*, so one key sending the 200-request burst gets 429s after the first 120; and
   `NODE_REGISTER_RATE_LIMIT` is **10 registrations per hour per IP** on `/nodes/register` +
   `/challenge` + `/link`, which blocks an operator setting up more than ten Macs behind one NAT in
   an hour (the per-wallet cap is 20). Document both, or key the registration limiter on wallet
   rather than IP once the signature flow proves ownership.
9. **Uncached `GET /nodes`.** It does `SELECT * FROM nodes … LIMIT 500` plus `jobStats24h` and a
   `requests_log` count on every call (no `STATS_CACHE_MS` like `/stats`). The web Network page polls
   it; with public traffic it is the cheapest DoS surface after `/v1`.
10. **Observability gap for the relay.** `jobs.first_chunk_ms`/`claimed_ms` exist, but there is no
    gauge for queued-job age, relay depth (`JobRelay.queue.length`, i.e. a slow client) or chunk
    POST latency; adding them to `/health/alerts` would make bottlenecks 1 and 3 visible in
    production before users notice.

## Results, 2026-10-04 (after fixes)

Same host class as above (2 vCPU, 8 GB, Linux, Node 22; gateway, fake nodes and clients share the two
cores), same script and defaults (300 tokens/job, 0 ms chunk delay), `VERIFICATION_ENABLED=false` (see
the note at the top), gateway defaults otherwise (`queueWaitMs` 6000, `maxQueueDepthPerNode` 3,
`maxParallel` 1 because the fake node does not advertise more). Every run: **0 failed requests, 0 node-side
errors, no 5xx, no 429.** "Before" is the 2026-10-03 table.

### Route split (node-served / upstream)

| scenario | before | after | fallback reasons after |
| --- | --- | --- | --- |
| N=20, M=200, concurrency 200 | 20 / 180 (10 %) | **60 / 140 (30 %)** | `queue_full` 120, `queue_timeout` 20 |
| N=20, M=200, concurrency 40 | 20 / 180 (10 %) | **200 / 0 (100 %)** | none |
| N=20, M=200, concurrency 20 | 200 / 0 (100 %) | 200 / 0 (100 %) | none |

Jobs per node: exactly 3 each (c=200), exactly 10 each (c=40 and c=20): the queue is drained
oldest-first by whichever node frees up, so fairness is preserved.

### Latencies

| metric | before (c=200) | after (c=200) | before (c=40) | after (c=40) | before (c=20) | after (c=20) |
| --- | --- | --- | --- | --- | --- | --- |
| wall time | 3.77 s | 7.10 s | 4.33 s | 20.1 s | 20.9 s | 20.6 s |
| throughput | 53.1 req/s · 2,594 tok/s | 28.2 req/s · 2,951 tok/s | 46.1 req/s · 2,257 tok/s | 9.9 req/s · 2,982 tok/s | 9.6 req/s · 2,872 tok/s | 9.7 req/s · 2,911 tok/s |
| first token p50 / p95 (all) | 439 / 686 ms | 587 / 6,173 ms | 51 / 176 ms | 1,870 / 3,654 ms | 19 / 93 ms | **18 / 63 ms** |
| first token p50 / p95 (node route) | 234 / 794 ms | 3,581 / 5,409 ms | – | 1,870 / 3,654 ms | 19 / 93 ms | 18 / 63 ms |
| first token p50 (upstream) | 481 ms | 499 ms (`queue_full`: ~230 ms; `queue_timeout`: ~6.2 s) | – | – | – | – |
| total p50 / p95 (node route) | 3,737 / 3,768 ms | 5,366 / 7,078 ms | 4,316 ms (p50) | 3,646 / 5,596 ms | 1,897 / 3,618 ms | 1,930 / 3,293 ms |
| total p50 (upstream) | 903 ms | 941 ms | 469 ms | – | – | – |
| node → gateway `POST /chunk` p50 / p95 / p99 | 7.9 / 27.5 / 38.6 ms | 5 / 18 / 26 ms | 11.4 / 33.6 ms | 5 / 16 / 25 ms | 4.8 / 17.1 / 26.4 ms | 5 / 16 / 24 ms |

### Reading the numbers

- **The burst now reaches the network.** At concurrency 40 every request is node-served (was 10 %); at
  concurrency 200, 3× as many. The remaining 140 at c=200 are the bounded-wait policy working as
  intended: 60 queue slots (20 nodes × `maxQueueDepthPerNode` 3) fill in the first tick, the other 120
  go upstream at once (`queue_full`, first token ~230 ms), and 20 of the 60 queued could not be served
  within `queueWaitMs` (a 300-token fake job takes ~3.5 s of relay time, so a node clears at most one
  queued job inside 6 s) and fell through as `queue_timeout`. Raising `queueWaitMs`, `maxQueueDepthPerNode`
  or (with real agents) `maxParallel` trades first-token latency for network share; the knobs are in
  `config/tokenomics.json → routing`.
- **The cost is first-token latency for queued requests**, by construction: at c=40 the p50 first token
  is 1.9 s because half the clients wait for a node to finish the previous 300-token job. Before, those
  clients got an upstream answer in 50 ms at the upstream price. Which is right is a product choice; the default
  (wait up to 6 s, then upstream) keeps the worst case at `queueWaitMs` + upstream latency.
- **The pure node path is unchanged or slightly better** (c=20: first token 18/63/148 ms vs 19/93/119,
  chunk POST p50 5 ms vs 4.8 with p95 16 vs 17): bottlenecks 3–5 removed ~60,000 `SELECT * FROM jobs`
  reads, 21 reputation queries per request and 1 heartbeat prune per second from the hot path without
  changing wire behaviour. Throughput at c=200 rose from 2,594 to 2,951 tokens/s delivered.
- **`maxParallel` is not exercised by this script** (the fake node advertises the default 1). With
  `OLLAMA_NUM_PARALLEL=2` real agents would double the slots and halve the queue wait above.

### Still open after this pass

6 (single-process relay), 7 (SQLite on the event loop) and 10 (relay observability beyond the new
`/health.network` gauges) are unchanged; see the table above.

## Not measured here

- Real Ollama token rate and Mac CPU/RAM (the fake node answers instantly; `--chunk-delay 20` gives
  a 50 tok/s node if you want a realistic shape).
- OpenRouter latency (mock upstream only).
- Client disconnects mid-stream, node crashes mid-job, `stall_timeout`/`unclaimed` fallbacks: these
  are covered by `apps/gateway/test/network.test.ts`, not by this script.
- WAN latency between node and gateway; every chunk POST here is loopback. Over the internet each
  chunk POST costs one RTT and the agent keeps one in flight per job, so its 40 ms batching window
  is what keeps a 300-token reply from taking 300 RTTs; raising `batchMs` is the lever if real RTTs
  are high.
