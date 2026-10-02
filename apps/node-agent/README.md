# @mesh/node-agent — `mesh-node`

Run a Mesh inference node on a Mac (Apple Silicon first; Linux works too). The agent talks to a
local [Ollama](https://ollama.com), pulls jobs from the gateway over plain HTTPS (no inbound ports),
streams the reply back and gets paid per token served to the wallet you registered.

Everything ships as one file, `dist/mesh-node.js`, so friends only need Node 20+.

## Install (one line)

1. In the web app, open **Run a node** and click **Link a Mac**. Your wallet signs once in the browser and
   you get a one-time code (8 chars, valid 15 minutes). The Mac never holds a key.
2. Paste the command the page shows into Terminal on the Mac:

```sh
curl -fsSL https://<web-host>/install-node.sh | sh -s -- --link <code> --gateway https://<gateway-host>
```

That runs [`scripts/install-node.sh`](../../scripts/install-node.sh): checks macOS/arm64, installs Node 20
with Homebrew if needed, downloads `mesh-node.js` from the gateway (`GET /install/mesh-node.js`, with
fallbacks: `MESH_BUNDLE_URL`, `--from-local <path>`, `--web <origin>/mesh-node.js`), installs it at
`~/.mesh/bin/mesh-node`, then runs `mesh-node setup --link <code>` and `mesh-node service install`.
Re-running is safe (a re-run needs a fresh code only if the stored node identity cannot be re-claimed).

`--wallet <addr>` instead of `--link` is the legacy unsigned flow; it only works on gateways started with
`NODES_REQUIRE_SIGNATURE=false` (dev/demo) and gets `401 signature_required` elsewhere.

## Commands

```
mesh-node setup --link <code> [--gateway <url>] [--models a,b] [--with-70b] [--ollama <url>] [--skip-pull]
mesh-node setup --wallet <addr> ...   legacy: unsigned registration (gateway with NODES_REQUIRE_SIGNATURE=false only)
mesh-node start                 heartbeat, take jobs, stream replies (Ctrl-C / SIGTERM to stop)
mesh-node status [--json]       node stats from the gateway (online, uptime 24h, jobs, earned 24h/total, models)
mesh-node service install       launchd agent at ~/Library/LaunchAgents/xyz.mesh.node.plist (RunAtLoad, KeepAlive)
mesh-node service uninstall     unload and remove it
mesh-node pause | resume        stop / resume taking jobs (keeps heartbeating with busy=true)
mesh-node logs [-n 200]         tail ~/.mesh/logs/node.log
```

`setup` does, in order:

1. Finds Ollama (`PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, Ollama.app). Missing + Homebrew present
   → `brew install ollama`. Missing + no Homebrew → prints https://ollama.com/download and exits 1.
2. Makes sure `ollama serve` answers at `http://127.0.0.1:11434`, launching it detached if not
   (log: `~/.mesh/logs/ollama.log`).
3. Picks models by RAM (`sysctl -n hw.memsize`): `llama3.1:8b` always; `qwen2.5:14b` at 32 GB+;
   `llama3.1:70b` (Q4_0) at 64 GB+ only with `--with-70b`. `--models a,b` overrides. Pulls what is missing.
4. Detects the chip (`sysctl -n machdep.cpu.brand_string`) and `POST /nodes/register` with
   `{linkCode, chip, ramGb, models, agentVersion}` (or `{wallet, …}` for `--wallet`). The gateway binds the
   node to the wallet that created the code and returns it; setup writes `~/.mesh/config.json`
   (`gateway, nodeId, nodeToken, wallet, models, ollama, chip, ramGb`) with mode 0600.
   A re-run against the same gateway re-registers the stored `nodeId` with its token (the gateway rotates
   the token); if that is refused (`409 node_exists`, database reset) it registers a fresh identity. A code
   is consumed only by a successful registration; expired/used/unknown codes fail with a one-line hint
   (`link_code_expired` / `link_code_used` / `link_code_invalid`).

`start`:

- `POST /nodes/:id/heartbeat {models, busy, loadAvg}` every 20 s.
- `GET /nodes/:id/jobs/next?wait=25000` long-poll (gateway holds up to 25 s, 204 when idle).
- Each job runs against Ollama `/api/chat` with `stream: true`; deltas are batched every ~40 ms (or 2 KB)
  into ordered `POST .../chunk {seq, delta}` calls; then `POST .../done {promptTokens, completionTokens,
  finishReason}` from Ollama's `prompt_eval_count` / `eval_count`, or `POST .../fail {error}`. A transient
  chunk failure (network, 5xx) is retried once with the same `seq`; `409 job_not_running` stops generation
  without a `fail` (the gateway already gave up on the job).
- One job at a time (`busy: true` while running). `deadlineMs` is honoured (absolute unix-ms or a budget in
  ms); a job that passes it is aborted and reported as failed.
- Exponential backoff (1 s → 60 s, jittered) on gateway errors; a 401/404 re-registers with the saved
  wallet and rewrites the config (on a signed gateway that is refused with `signature_required` and the log
  says to run `mesh-node setup --link <code>` again).
- SIGTERM/SIGINT: finishes the current job, sends a last heartbeat, exits 0.

Env: `GATEWAY_URL` (default for `setup --gateway`), `MESH_LINK_CODE` (default for `setup --link`),
`MESH_HOME` (default `~/.mesh`), `OLLAMA_HOST_URL`, `NO_COLOR`.

## Protocol

See `docs/NODE_PROTOCOL.md`. Field names in `src/gateway.ts` are the wire contract.

## Develop

```sh
pnpm --filter node-agent dev -- --help        # run from source (tsx)
pnpm --filter node-agent test                 # vitest: runner vs fake Ollama + fake gateway, config, model selection
pnpm --filter node-agent typecheck
pnpm --filter node-agent build                # esbuild -> dist/mesh-node.js (node20, ESM, shebang)
```

`test/fakes.ts` has a fake Ollama (`/api/tags`, `/api/pull`, streamed `/api/chat`) and a fake gateway
implementing the node protocol (set `linkCode` to make it behave like a signed gateway); `scripts/install-node.sh --from-local apps/node-agent/dist/mesh-node.js`
installs a local build.

## Later

- Notarised menu-bar app (Swift) wrapping this agent and Ollama.
- Signed request/response digests for verifiable work.
- Linux: `service install` is launchd-only today; run `mesh-node start` under systemd or tmux.
