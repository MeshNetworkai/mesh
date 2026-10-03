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
mesh-node status [--json]       node stats from the gateway (online, uptime 24h, jobs, earned 24h/total, models; counts only)
mesh-node service install       launchd agent at ~/Library/LaunchAgents/xyz.mesh.node.plist (RunAtLoad, KeepAlive)
mesh-node service uninstall     unload and remove it
mesh-node pause | resume        stop / resume taking jobs (keeps heartbeating with busy=true)
mesh-node logs [-n 200]         tail ~/.mesh/logs/node.log
mesh-node update [--check]      install the latest release (sha256-verified, atomic swap, service restart); --check only reports (exit 2 if newer)
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

`update` (`src/update.ts`, `docs/DISTRIBUTION.md`): reads `latest.json` from `MESH_UPDATE_URL` or
`<gateway>/install/latest.json` (`{version, bundleUrl, bundleSha256, …}`), downloads the bundle to
`~/.mesh/bin/mesh-node.js.update.tmp`, checks the SHA-256 and that it is JavaScript, renames it over
`mesh-node.js` (atomic), then `launchctl kickstart -k`s the service. A failed check leaves everything
untouched. `start` checks 60 s after boot and daily, logs `update available: …` once per version, and
installs only with `MESH_AUTO_UPDATE=1` (`MESH_UPDATE_CHECK=0` disables). Homebrew installs
(`MESH_INSTALL_CHANNEL=brew`, set by the brew wrapper) are told to `brew upgrade` instead. Dev builds
(`0.1.0-dev`) never report an update.

Env: `GATEWAY_URL` (default for `setup --gateway`), `MESH_LINK_CODE` (default for `setup --link`),
`MESH_HOME` (default `~/.mesh`), `OLLAMA_HOST_URL`, `NO_COLOR`, `MESH_UPDATE_URL`, `MESH_AUTO_UPDATE`,
`MESH_UPDATE_CHECK`, `MESH_INSTALL_CHANNEL`.

## Other ways to install

`brew install mesh-network/tap/mesh-node` (formula in `homebrew-tap/Formula/mesh-node.rb`, built from
the release tarball `scripts/release/make-tarball.sh` produces) or the menu-bar app DMG; the web
`/download` page lists all three with checksums. `docs/DISTRIBUTION.md` has the release workflow.

## Privacy

What a job contains and what this machine keeps (`docs/PRIVACY.md`):

- A job is `{jobId, model, messages, params, maxTokens, deadlineMs, attempt}`: no wallet, API key, IP,
  user agent or request id of the person asking. `messages` are role + text only.
- The prompt and the reply exist in this process's memory (and in Ollama's) only while the job runs. The
  agent empties its copies when `done`/`fail` is sent (`runner.ts:scrubJob`). They are never written to
  disk: `~/.mesh/logs/node.log` holds job ids, token counts, chunk counts and timings, and
  `test/privacy.test.ts` plants secrets in a job and asserts they are absent from every log line.
- Ollama is called with `keep_alive: "5m"` (weights stay warm, the request's context is dropped by Ollama
  when the request ends). The `ollama serve` the agent launches and the launchd service run with
  `OLLAMA_NOHISTORY=1` and `OLLAMA_DEBUG=0`; if you run Ollama yourself, leave `OLLAMA_DEBUG` unset or
  its server log will contain request bodies.
- `mesh-node status` and the menu bar app show counts and earnings only.
- Honest limit: the model needs the plaintext, so the machine running it sees every prompt it serves.
  Signing the operator pledge in the web app (Node page) is the commitment not to look; with a gold stake
  it makes the node eligible for `trusted` requests.

## Protocol

See `docs/NODE_PROTOCOL.md`. Field names in `src/gateway.ts` are the wire contract.

## Develop

```sh
pnpm --filter node-agent dev -- --help        # run from source (tsx)
pnpm --filter node-agent test                 # vitest: runner vs fake Ollama + fake gateway, config, model selection, update (fake release server)
pnpm --filter node-agent typecheck
pnpm --filter node-agent build                # esbuild -> dist/mesh-node.js (node20, ESM, shebang); MESH_BUILD_VERSION=x.y.z stamps a release version
VERSION=0.2.0 sh scripts/release/make-tarball.sh   # release tarball + sha256 (what the Homebrew formula installs)
```

`test/fakes.ts` has a fake Ollama (`/api/tags`, `/api/pull`, streamed `/api/chat`) and a fake gateway
implementing the node protocol (set `linkCode` to make it behave like a signed gateway); `scripts/install-node.sh --from-local apps/node-agent/dist/mesh-node.js`
installs a local build.

## Later

- Signed + notarised menu-bar app (unsigned beta DMG ships today, `docs/DISTRIBUTION.md`).
- Signed request/response digests for verifiable work.
- Linux: `service install` is launchd-only today; run `mesh-node start` under systemd or tmux.
