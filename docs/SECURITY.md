# Mesh gateway security review (session 5, 2026-10-03)

Scope: everything under `apps/gateway/src`, the node protocol (`docs/NODE_PROTOCOL.md`), the deploy
path (`scripts/deploy-vps.md`, `docker-compose.yml`) and `.env.example`. Findings are listed by
severity. "Fixed" means the change is in this tree with a test in
`apps/gateway/test/security.test.ts` (28 tests); "Open" means it needs work outside this session's
scope or a product decision, with a recommendation.

Severity: **High** = a remote party can take money, credentials or someone else's rewards;
**Medium** = abuse, denial of service or weakening of a control; **Low** = hygiene.

## Summary

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| 1 | Node reward wallet self-declared at registration | High | **Fixed** (signed registration, default on) |
| 2 | Default JWT secret / admin token accepted in production | High | **Fixed** (boot refuses) |
| 3 | `/admin/dev-login` reachable with the admin token in production | High | **Fixed** (404 unless `ALLOW_DEV_LOGIN`) |
| 4 | CORS `origin: true` reflects any origin | Medium | **Fixed** (`CORS_ORIGINS` allowlist, none by default in prod) |
| 5 | No rate limit on `/nodes/register` (spam identities) | Medium | **Fixed** (per-IP hourly + per-wallet cap) |
| 6 | 2 MB body limit on every route | Medium | **Fixed** (16 KB on auth + node routes, 256 KB chunks) |
| 7 | Admin token / node token compared with `!==` | Low | **Fixed** (`safeEqual`, hashed `timingSafeEqual`) |
| 8 | No JWT secret rotation path | Medium | **Fixed** (`JWT_SECRET_PREVIOUS`) |
| 9 | No security headers | Low | **Fixed** (`@fastify/helmet`) |
| 10 | Bearer / admin headers could reach logs | Low | **Fixed** (pino redaction) |
| 11 | Node job kept alive after client disconnect until timeout | Low | **Fixed** (relay closed on `close`) |
| 12 | Epoch cron failure only logged | Medium | **Fixed** (`errors_log` + alert) |
| 13 | `.env.example` missing the new knobs | Low | **Fixed** |
| 14 | Session JWT in `localStorage` (XSS → token theft) | Medium | Open (cookie sessions) |
| 15 | Single-instance rate limits and relays | Low | Open (by design, one VPS) |
| 16 | Node-agent / web cannot yet produce the registration signature | Medium | Open (next agent release) |
| 17 | `/admin/*` exposure relies on the reverse proxy | Medium | Open (keep the Caddy rule; add IP allowlist) |
| 18 | API-key hash lookup is unsalted SHA-256 | Low | Accepted (keys are 192-bit random) |
| 19 | Geo-block trusts `CF-IPCountry`/`X-Country` headers | Medium | Open (proxy must strip client copies; documented) |

Checked and found sound (no change): nonce replay, SQL injection surface, job claim races, upstream
error handling never charging, model policy enforcement, API key revocation.

## Findings in detail

### 1. Node reward wallet was self-declared — High — Fixed

`POST /nodes/register {wallet}` accepted any string, so anyone could register a node that earns
rewards into a wallet they do not control, or more importantly point a stolen/leaked node token at
their own wallet (re-registration rotated the token but also overwrote `wallet`). Rewards are real
money once payouts are wired.

Fix (`apps/gateway/src/routes/nodes.ts`, `auth.ts:registerMessage`, `packages/config` →
`nodes.requireSignature` default `true`):

- `POST /nodes/register/challenge {wallet, nodeId?}` issues a single-use 5-minute nonce under a
  registration-specific domain tag (`<domain>#node-register`) and returns a SIWE-style message whose
  first line differs from the sign-in message, so a `/auth` signature can never be replayed here and
  a registration signature can never log someone in (`parseLoginMessage` rejects it).
- `POST /nodes/register` must carry `{nonce, signature, chain?}`; the gateway rebuilds the exact text
  (including `Node ID:` when given, so a signature for `mac-1` cannot register `mac-2`) and verifies
  it with `adapter.verifyWalletSignature` or `verifierFor(chain)` (ed25519 for Solana, EIP-191 for
  EVM). Unsigned → `401 signature_required`. A signature is verified whenever it is sent, even when
  the requirement is off.
- Re-registering an existing `nodeId` needs the signature **and** the node token.
- Link codes (`POST /nodes/link`, session JWT + signature over the same challenge): the wallet signs in
  the browser and gets an 8-char one-time code (15 min, sha256 stored, at most 5 live per wallet,
  shares the `/nodes/register` per-IP budget). `POST /nodes/register {linkCode}` binds the node to the
  code's wallet and consumes it atomically; the Mac never holds a key. Codes are 40 bits from a
  32-char alphabet: brute force at 10 tries/hour/IP is not a concern inside the 15-minute window.
- `nodes.maxPerWallet` (20) caps identities per wallet.
- Back-compat: `NODES_REQUIRE_SIGNATURE=false` (env) or `nodes.requireSignature=false` (config)
  restores the unsigned flow. The test helpers and `scripts/demo.sh` use it; production does not.

Tests: challenge→sign→register, replayed nonce, foreign signer, swapped nodeId, sign-in nonce
cross-use, token+signature on re-register, per-wallet cap, real EIP-191 signature via viem,
back-compat mode. See also #16.

### 2. Default secrets accepted in production — High — Fixed

`JWT_SECRET` defaulted to `dev-only-insecure-jwt-secret-change-me` and `ADMIN_TOKEN` to
`dev-admin-token`; with `NODE_ENV=production` the process started happily. A forgotten `.env` line
would have meant anyone can mint sessions for any wallet and call every admin endpoint.

Fix: `env.ts:productionProblems()` runs in `createContext`; in production the process refuses to
start when `JWT_SECRET` is the default or shorter than 32 chars, `ADMIN_TOKEN` is the default or
shorter than 24, `AUTH_DOMAIN` still starts with `localhost`, or `CORS_ORIGINS` is `*`. The message
lists every problem at once.

### 3. `/admin/dev-login` in production — High — Fixed

It mints a 7-day session for **any** wallet with only the admin token, and `scripts/deploy-vps.md`
relied on Caddy to hide `/admin/*`. One misconfigured proxy (or a leaked admin token) = every
holder's credits spendable. Fix: `ALLOW_DEV_LOGIN` defaults to `NODE_ENV !== 'production'`; when
false an `onRequest` hook in `server.ts` answers 404 before the admin routes run. The Caddy rule
stays as defence in depth (#17).

### 4. CORS reflected any origin — Medium — Fixed

`@fastify/cors` with `origin: true` echoes whatever `Origin` arrives. Sessions are bearer tokens (not
cookies) so this is not CSRF, but it let any website drive the API with a token obtained via XSS on
any other site and read the responses. Fix: `CORS_ORIGINS` (comma-separated). Dev default: any
origin. Production default: **no** browser origin, so the web app's origin must be listed (the
runbook says so). Exposed headers now include `x-mesh-fallback` and the rate-limit headers.

### 5. Registration spam — Medium — Fixed

`/nodes/register` had no limit: a loop could create millions of `nodes`/`heartbeats` rows and inflate
`/nodes.total`. Fix: shared per-IP fixed window for `/nodes/register` and `/challenge`
(`NODE_REGISTER_RATE_LIMIT`, 10/hour) plus `nodes.maxPerWallet`. `/auth/*` already shared one
20/min bucket; `/v1` keeps the per-key 120/min limit from `@fastify/rate-limit`.

### 6. Body limits — Medium — Fixed

Every route accepted 2 MB. Auth and node control bodies are a few hundred bytes. Fix: route-level
`bodyLimit` of 16 KB on `/auth/*`, `/nodes/register*`, heartbeat, done, fail; 256 KB on chunk; `/v1`
keeps `BODY_LIMIT_BYTES` (2 MB default). 413 answers use the existing `payload_too_large` shape.

### 7. Timing-safe compares — Low — Fixed

`requireAdmin` compared `token !== ctx.env.ADMIN_TOKEN` and node tokens compared hex hashes with
`!==`. JavaScript string comparison short-circuits, so in theory the admin token leaks byte by byte
over many requests. Fix: `auth.ts:safeEqual` hashes both sides with SHA-256 and uses
`crypto.timingSafeEqual`, so lengths do not leak either. API keys and node tokens are looked up by
SHA-256 hash (`WHERE key_hash = ?`); the hash of a 192-bit random secret cannot be guessed from
timing, so that path is fine as is (#18).

### 8. JWT rotation — Medium — Fixed

Rotating `JWT_SECRET` logged everyone out at once and there was no way to do it gradually. Fix:
`JWT_SECRET_PREVIOUS` is accepted for **verification only**; `/auth/refresh` re-signs with the current
secret; remove the previous one after 7 days (session TTL). `verifySession` also pins
`algorithms: ['HS256']` (jose already rejected `alg: none`; the test proves it).

### 9. Security headers — Low — Fixed

`@fastify/helmet` registered globally: `X-Content-Type-Options: nosniff`, `X-Frame-Options`,
`Referrer-Policy`, no `X-Powered-By`; HSTS only in production; CSP off (JSON/SSE API, no HTML);
`Cross-Origin-Resource-Policy: cross-origin` because the web app lives on another origin.

### 10. Secrets in logs — Low — Fixed

Grepped every `log.*(`: no API key, node token, JWT or admin token is logged by our code
(`node registered` logs the wallet, not the token; upstream errors log the message, not the request).
Fastify's own request logging can include headers at `debug`/`trace`, so pino redaction is set for
`req.headers.authorization` and `req.headers["x-admin-token"]`.

### 11. SSE / long-poll resource leaks — Low — Fixed

`/v1` upstream streaming already cancels the upstream reader on `req.raw 'close'` and closes the
response. For node-served jobs the handler only noticed a disconnected client after the current
relay wait (up to 8 s first-token / 6 s stall). Fix: the `close` handler now calls
`relay.close()` on the live relay so the loop wakes immediately, the job is abandoned and the node's
next chunk gets 409 (stop generating). Node long-polls are bounded at 25 s and one per node (a new
pull replaces the previous waiter). Relays are deleted on `release`/`abandon`; `reapExpired` at boot
fails jobs left from a previous process.

### 12. Failed sweeps were only logged — Medium — Fixed

`index.ts` caught `runEpoch` errors and logged them; nothing persisted and nobody was told. Fix: the
catch now writes `errors_log` row `code='epoch_failed'`; `alerts.ts` raises `failed_sweep` on it (and
on `epochs.status='failed'` rows if the distribute job starts writing them) and `missed_epoch` when
no complete/empty epoch lands within 1.5 × `epochSeconds`.

### 13. `.env.example` — Low — Fixed

Added `CORS_ORIGINS`, `JWT_SECRET_PREVIOUS`, `ALLOW_DEV_LOGIN`, `NODES_REQUIRE_SIGNATURE`,
`NODE_REGISTER_RATE_LIMIT`, `BODY_LIMIT_BYTES`, alert and Telegram variables, with one-line
explanations.

### 14. Session JWT in `localStorage` — Medium — Open

`apps/web/src/lib/auth.tsx` stores the 7-day session in `localStorage`; any XSS in the web app (or a
malicious browser extension) can read it and spend credits via `POST /keys`. Mitigations in place:
no `dangerouslySetInnerHTML`, CSP is the web host's job, keys created in the browser are also kept
in `localStorage` (`keystore.ts`) so the exposure is the same class. Recommendation: `httpOnly`
`SameSite=Strict` cookie sessions with a CSRF token for state-changing routes, and shorten the
session to 24 h with refresh. Tracked for the cookie-sessions item in `docs/STATUS.md`.

### 15. Single-instance limits — Low — Open (by design)

Rate limits, nonces (SQLite, fine), relays and alert state are per process. One VPS is the launch
plan; a second instance needs a shared store for limits and relays. Not a vulnerability.

### 16. Agent cannot produce the registration signature — Medium — Fixed (link codes)

`apps/node-agent` never holds a private key, so with `requireSignature=true` the agent cannot sign the
challenge itself. Fixed with the link-code flow: the web node page ("Link a Mac") signs the challenge
with the connected wallet and `POST /nodes/link` returns a one-time code; the installer / `mesh-node
setup --link <code>` registers with it (`docs/NODE_PROTOCOL.md §1`). `--wallet` remains only for
gateways with `NODES_REQUIRE_SIGNATURE=false` (dev/demo). Do **not** set that in production: it
reopens #1.

### 17. `/admin/*` exposure — Medium — Open

Admin routes live on the same listener as the public API; the Caddyfile returns 404 for
`/admin/*` and the compose file binds the gateway to `127.0.0.1`. Keep both. Recommendation: in
addition, allow `/admin/*` only from `127.0.0.1` inside the gateway (one `onRequest` check on
`req.ip`) once the admin web page (`apps/web/src/pages/Admin.tsx`, in progress) has decided how it
reaches the API (SSH tunnel vs. authenticated route).

### 18. Unsalted SHA-256 for API keys / node tokens — Low — Accepted

Keys are `mesh_sk_` + 24 random bytes (192 bits) and tokens `mesh_nt_` + 24 random bytes. A dump of
`api_keys.key_hash` cannot be brute-forced; salting adds nothing for high-entropy secrets and would
break the O(1) lookup. Keep.

### 19. Geo-block header trust — Medium — Open (documented)

`geoblock.ts` trusts `CF-IPCountry` / `X-Country`. Behind Cloudflare that header is authoritative;
without Cloudflare the Caddyfile strips client-sent copies and may set `X-Country` from MaxMind.
If the proxy is misconfigured a client can send `X-Country: FR` and bypass the block. The runbook's
pre-flight includes a curl that proves the header is stripped.

## Checked and sound

- **Nonce replay** (`auth.ts:NonceStore`): single use via `UPDATE … WHERE used_at IS NULL` with
  `changes === 1`, 5-minute expiry, wallet-bound, domain-bound; a tampered message consumes the nonce
  and is rejected (`message_mismatch`). Registration nonces use a separate domain tag.
- **SQL**: every query uses `?` placeholders; the only dynamic SQL is `SET` lists built from constant
  column names (`updateApiKey`, heartbeat) and `IN (?,?,…)` placeholders. No string interpolation of
  user data anywhere under `src/`.
- **Job claims** (`network.ts:tryClaim`): `UPDATE jobs SET status='running' … WHERE status='queued'`
  inside a transaction; exactly one node wins; chunks/done/fail are checked against `node_id`.
- **Billing on failure**: upstream 4xx/5xx, timeouts, mid-stream upstream errors and node failures
  before output never call `record()`; after partial node output the client is told and not charged.
- **Model policy** is enforced on `/v1/chat/completions` and filtered in `/v1/models`.
- **Key revocation** is immediate (`revoked = 0` in the lookup).

## Operating guidance

- Rotate `ADMIN_TOKEN` by editing `.env` and `docker compose up -d`; nothing else holds it.
- Rotate `JWT_SECRET`: set `JWT_SECRET_PREVIOUS=<old>`, `JWT_SECRET=<new>`, restart; remove the
  previous after 7 days.
- A leaked API key: the holder revokes it (`DELETE /keys/:id`) or you do it in SQL
  (`UPDATE api_keys SET revoked=1 WHERE key_prefix=?`); see the runbook's "key leak" playbook.
- A leaked node token: re-register the `nodeId` with the token + a fresh signature (rotates it), or
  `UPDATE nodes SET token_hash=NULL WHERE node_id=?` to force a new identity.
- `GET /health/alerts` (admin) shows what the monitor sees; `GET /admin/overview.recentErrors` the
  last 50 errors.
