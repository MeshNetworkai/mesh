# Contributing to Mesh

Read `docs/ARCHITECTURE.md` first if you have not; this file is about working in the repo.

## Dev setup

Requirements: Node ≥ 20 (CI runs 20), pnpm 10 (`corepack enable` picks the version from
`package.json → packageManager`), and for the contracts only, Foundry (`bash
scripts/chain/evm-setup.sh` installs forge/anvil/cast + solc from npm, no network to
foundry.paradigm.xyz needed).

```sh
pnpm install
pnpm --filter @mesh/config --filter @mesh/chain-adapter build   # the gateway imports these from dist/
pnpm dev            # gateway :8787 (mock chain adapter + offline mock upstream) and web :5173
```

Everything works offline with no keys: the mock adapter has four holders (`mockwallet_alice` 60k,
`mockwallet_bob` 30k, `mockwallet_carol` 10k, `mockwallet_dust` 500) and the mock upstream streams a
canned reply ($0.001 at list, billed $0.00106 with the shipped 6 % markup). On the mock adapter the
credit reserve reads `source: "mock"`: there is no pool wallet. `cp .env.example .env` only when you want to change a default; the README's quick
start seeds fees, runs an epoch, mints a dev JWT and an API key with curl, and `pnpm demo` does the
whole thing scripted (including a curl-simulated node).

The `packages/*` → `apps/*` dependency goes through `dist/`, so after editing `packages/config` or
`packages/chain-adapter` rebuild them (or run their `build` in watch mode) before the gateway sees
the change. Tests in the gateway import the packages the same way.

## Scripts

Root (`package.json`):

| Command | What |
| --- | --- |
| `pnpm dev` | gateway + web together (concurrently) |
| `pnpm dev:gateway` / `pnpm dev:web` / `pnpm dev:mock` | one side only; `dev:mock` is the web app on fake data, no gateway |
| `pnpm build` | every workspace (`pnpm -r build`) |
| `pnpm typecheck` | `pnpm -r typecheck` (tsc `--noEmit` everywhere, incl. test tsconfigs) |
| `pnpm test` | gateway vitest suite |
| `pnpm test:all` | chain-adapter + gateway + node-agent suites |
| `pnpm e2e` | Playwright against the real gateway + Vite dev server (chromium) |
| `pnpm loadtest` | `scripts/loadtest/relay.mjs` with N=20 nodes, M=200 requests (`docs/LOADTEST.md`) |
| `pnpm demo` | `scripts/demo.sh` end-to-end walk-through on a throwaway DB |
| `pnpm screenshots` | regenerate `docs/screens/*.png` from mock mode |
| `pnpm web:build` | production web bundle |

Per workspace (`pnpm --filter <name> <script>`): `@mesh/gateway` (`dev`, `start`, `build`,
`typecheck`, `test`), `@mesh/node-agent` (`dev`, `build` → single-file `dist/mesh-node.js`,
`typecheck`, `test`), `web` (`dev`, `build`, `preview`, `e2e`, `e2e:ui`, `screenshots`),
`@mesh/chain-adapter` (`build`, `typecheck`, `test`, `test:anvil`, `solana:create-mint`,
`solana:smoke`, `evm:deploy`), `@mesh/config` (`build`, `typecheck`). Contracts:
`cd contracts/evm && FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test -vv` (drop `FOUNDRY_SOLC`
when solc downloads work on your machine).

## Tests

```sh
pnpm test                                     # gateway: ledger math, epochs, auth, keys, /v1, node protocol, security
pnpm --filter @mesh/chain-adapter test        # time-weighting, Solana/EVM adapters against fixtures
pnpm --filter @mesh/chain-adapter test:anvil  # live EVM adapter against a local anvil (MESH_ANVIL=1)
pnpm --filter @mesh/node-agent test           # agent loop/runner against a fake gateway + fake Ollama
pnpm e2e                                      # browser flows at 1440px and 390px (apps/web/e2e)
pnpm loadtest                                 # exit 1 if any request fails
```

- Gateway tests use `test/helpers.ts → testServer()`: an in-memory SQLite, the `MockAdapter`, the
  `MockUpstream`, `TEST_ENV` (rate limits lifted, signatures off unless the test turns them on) and
  `app.inject` instead of a socket. Add new tests next to the route or module they cover
  (`apps/gateway/test/<area>.test.ts`); one `describe` per behaviour cluster.
- `testConfig` is the shipped `config/tokenomics.json` with a few switches turned for exact
  arithmetic: the upstream leg runs at list (`upstreamMarkupBps: 0`, `upstreamFeeBps: 0`, because the
  mock upstream costs a round $0.001), starter credits and verification are off. Tests of the shipped
  markup and upstream fee use `SHIPPED_PRICING` (`catalogue.test.ts`, `usage-share.test.ts`).
- To give a wallet credit it can sell, use `grantCredit(db, wallet, usd)` from `test/helpers.ts`.
  `POST /admin/starter-credit` grants starter credit, which the shipped config does not let a wallet
  list on the marketplace.
- `test/economics.test.ts` holds the rules that keep a credit from costing more than it is worth:
  credit expiry, non-transferable starter credit, direct sales, the published reserve, the
  `reserve_short` alert and a skipped sweep raising `failed_sweep`. The sweep and price-feed rules
  are in `packages/chain-adapter/test/pons.test.ts`; `test/migration19.test.ts` runs the ledger
  rebuild against a database that already holds rows.
- The e2e suite boots the real gateway with a throwaway DB (`apps/web/e2e/.tmp`, deleted first) and
  seeds it in `global-setup.ts`. Chromium comes from `/opt/pw-browsers` when present, otherwise
  Playwright's own install (`pnpm --filter web exec playwright install --with-deps chromium`).
- CI (`.github/workflows/ci.yml`) runs typecheck, the three vitest suites, the web build, the e2e
  suite and `forge test` on every push to `main` and every pull request. `docker.yml` builds the
  gateway image on `v*` tags. Keep all of it green; do not skip tests to get there.

## Conventions

**Money is integer micro-USD.** Every stored or computed amount is an integer number of
micro-dollars (`*_usd_micros`, `*Micros`), converted at the API edge with
`apps/gateway/src/money.ts` (`usdToMicros`, `microsToUsd`, `bpsOf`, `splitProRata`). Never do
arithmetic on floating USD; pro-rata splits assign the remainder deterministically so a sum of
shares equals the pool exactly. Shares and fees are expressed in basis points (`*Bps`).

**Migrations are append-only.** `apps/gateway/src/db.ts → MIGRATIONS` is an array of `{id, sql}`;
add a new entry with the next id, never edit or reorder an existing one (deployed databases have
already applied it). Use `ALTER TABLE … ADD COLUMN` with defaults, `CREATE TABLE/INDEX IF NOT
EXISTS`, and put every idempotency rule in the schema as a `UNIQUE` index (as `credits_ledger
(wallet, ref)`, `node_rewards (job_id)`, `treasury_ledger (kind, ref)` do) rather than in
application code only. SQLite cannot alter a `CHECK`, so a new ledger `kind` means rebuilding the
table in place: create `<table>_vN`, copy the rows, drop, rename, recreate the indexes (migrations
14 and 19 are the pattern; 19 added `purchase` / `expiry` to `credits_ledger` and
`credit_purchase` to `prepaid_ledger`).

**No literals in tests for config values.** Prices, shares, thresholds and timeouts come from
`config/*.json` through `test/helpers.ts` (`testConfig`, `SHIPPED_PRICING`, `NETWORK_PRICE_PER_M`,
`NODE_REWARD_PER_M`, `networkMicros()`, `rewardMicros()`) or from the module constants that define
them (`NODE_ONLINE_SEC`, `HEARTBEAT_EVERY_SEC`, `MAX_POLL_WAIT_MS`, `LINK_CODE_TTL_SEC`, …). A
test that asserts `0.02` or `90` breaks the next time someone tunes `tokenomics.json`; a test that
asserts `networkMicros(tokens)` does not. Tests that need different numbers build their own config
object from `testConfig` (see `fastConfig` in `test/network.test.ts`) and pass it to
`testServer({config})`.

**Economics live in JSON, behaviour in code.** Anything a token holder would want to audit
(fee split, min hold, prices, rewards, routing timeouts, geo-block list, model allow/deny) goes in
`config/*.json` behind a zod schema in `packages/config`. Env vars are for deployment facts
(ports, secrets, URLs, rate limits) and dev switches; the only env overrides of config are
`NODES_REQUIRE_SIGNATURE` and `GEO_BLOCK_ENFORCE`, and both are refused or defaulted safely in
production (`productionProblems()` in `env.ts`).

**Nothing is charged on failure.** Upstream errors, timeouts, node failures before output and
client disconnects before output must not write a `usage` ledger row; the charge happens in one
transaction with `requests_log` after a successful completion. Keep that invariant when touching
`routes/v1.ts`, and add a test for any new failure path.

**Errors have one shape.** `{error, message, statusCode, requestId}` everywhere, OpenAI's
`{error: {message, type, code, param}}` under `/v1`. 5xx and upstream failures also go to
`errors_log` via `recordError` so `/admin/overview` and the alert monitor see them. Never let a
bearer, node token or admin token reach a log line (pino redaction is configured in `server.ts`).

**Protocol changes are documented in the same change.** The node protocol is the contract between
`apps/gateway` and `apps/node-agent`, specified in `docs/NODE_PROTOCOL.md`; a gateway change to
`/nodes/*` updates the doc, the agent and `test/network.test.ts` together and stays backward
compatible with agents already in the field (nodes self-update slowly).

**Secrets are hashed at rest.** API keys, node tokens and link codes are stored as sha256 and
shown once; sign-in and registration nonces are single use with a domain tag so they cannot be
replayed across purposes. Follow the same pattern for any new credential.

**Style.** TypeScript strict, ES modules (`.js` suffix on relative imports), 2-space indent,
single quotes, trailing commas, long lines are fine when they are one statement. No formatter or
linter is enforced yet; match the surrounding file. Comments explain *why* (a protocol rule, an
invariant, a security consideration), not what the next line does.

## Pull requests

- Keep `pnpm typecheck`, `pnpm test:all`, `pnpm e2e` and `forge test` green; CI runs them.
- One behaviour per PR where possible; include the test, the doc update (`README.md` endpoint
  table, `docs/NODE_PROTOCOL.md`, `.env.example` for a new env var, `docs/ARCHITECTURE.md` for a
  new table or component, `docs/PRICING.md` for anything that changes a price, a margin, the
  reserve, expiry or direct sales) and, for anything touching `/nodes/*` or `/v1`, a note on
  backward compatibility.
- Code comments cite `docs/PRICING.md` by section (§5 the credit reserve, §6 credit expiry, §7
  buying credits directly). Keep those numbers stable, or update the comments in the same change.
- Do not commit `data/*.db`, `.env`, `contracts/evm/out|cache|lib`, Playwright output or `dist/`
  (all ignored); `config/deploy.<network>.json` files *are* committed once a network is live.
