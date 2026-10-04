# Mesh gateway security review (session 5, 2026-10-03; session 6 follow-up the same day)

Scope: everything under `apps/gateway/src`, the node protocol (`docs/NODE_PROTOCOL.md`), the deploy
path (`scripts/deploy-vps.md`, `docker-compose.yml`) and `.env.example`. Findings are listed by
severity. "Fixed" means the change is in this tree with a test in
`apps/gateway/test/security.test.ts` (28 tests) or `apps/gateway/test/session-hardening.test.ts`
(15 tests, session 6); "Open" means it needs work outside this session's scope or a product decision,
with a recommendation.

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
| 14 | Session JWT in `localStorage` (XSS → token theft) | Medium | **Fixed** (HttpOnly cookie + CSRF double submit, session 6) |
| 15 | Single-instance rate limits and relays | Low | Open (by design, one VPS) |
| 16 | Node-agent / web cannot yet produce the registration signature | Medium | **Fixed** (link codes) |
| 17 | `/admin/*` exposure relies on the reverse proxy | Medium | **Fixed** (`ADMIN_IP_ALLOWLIST` in-gateway, admin cookie, full audit, session 6) |
| 18 | API-key hash lookup is unsalted SHA-256 | Low | **Fixed** (HMAC with `KEY_PEPPER`, lazy rehash, session 6) |
| 19 | Geo-block trusts `CF-IPCountry`/`X-Country` headers | Medium | **Fixed** (headers believed only from `TRUSTED_PROXY_CIDRS`, session 6) |
| 20 | `trustProxy: true` believed `X-Forwarded-For` from anyone | Medium | **Fixed** (`TRUSTED_PROXY_CIDRS`, session 6) |
| 21 | No request id on responses / in error bodies | Low | **Fixed** (`x-request-id` echoed or minted, session 6) |

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

### 14. Session JWT in `localStorage` — Medium — Fixed (session 6)

`apps/web/src/lib/auth.tsx` stored the 7-day session in `localStorage`; any XSS in the web app (or a
malicious browser extension) could read it and spend credits via `POST /keys`.

Fix (gateway `auth.ts`, `context.ts`, `routes/auth.ts`, `server.ts`; web `lib/api.ts`, `lib/auth.tsx`):

- `POST /auth/verify`, `/auth/refresh` (and dev-only `/admin/dev-login`) set `mesh_session=<jwt>` as
  `HttpOnly; SameSite=Lax; Path=/; Max-Age=7d`, `Secure` when `COOKIE_SECURE` (default: production),
  plus a readable `mesh_csrf` cookie (random 192-bit, same attributes minus HttpOnly). The JSON body
  still carries `token` so CLI / SDK clients keep using `Authorization: Bearer`. Bearer wins over the
  cookie when both are present, so a stale cookie never confuses an API client.
- `requireSession` accepts either. `GET /auth/session` answers who the cookie says you are (the web
  app's boot check); `POST /auth/logout` clears both cookies (stateless JWT: bearer clients just
  drop the token).
- CSRF (`server.ts:csrfApplies`): every non-GET/HEAD/OPTIONS request that is **cookie**-authenticated
  (carries `mesh_session` or `mesh_admin` and no `Authorization` / `x-admin-token` header) must send
  `X-Mesh-CSRF` equal to the `mesh_csrf` cookie, else `403 csrf_mismatch` before any handler runs.
  Exempt: `/auth/nonce`, `/auth/verify`, `/admin/login`, `/nodes/register*` (signature / token
  auth) and `/v1/*` (API-key bearer). Because the rule is "any state change with a cookie", new
  session routes (`/stake`, `/points`, `/referrals`, …) are covered without opting in (the points
  routes answer 404 while `points.enabled` is false; see `docs/POINTS.md`). Header-
  authenticated clients are immune by construction and skip the check.
- CORS now sends `Access-Control-Allow-Credentials: true`; the browser requires an explicit origin
  for that, so `CORS_ORIGINS` must list the web app (it had to anyway). `SameSite=Lax` means the web
  app and the API must be same-site (`app.example.com` + `api.example.com`); the runbook says so.
- Web: `request()` always uses `credentials: 'include'`, adds `X-Mesh-CSRF` from the cookie on
  state changes, and sends no bearer for the session (the `COOKIE_SESSION` sentinel replaces the
  JWT in the existing `(token, …)` call signatures so pages did not change). `localStorage` keeps
  only `{wallet, chain}` (a render hint; `GET /auth/session` confirms it on boot and a 401 clears
  it). A legacy entry that still contains a JWT is traded for the cookie once via `/auth/refresh`
  and then dropped. "Sign out" calls `/auth/logout`. The session is still 7 days: shortening it is
  a product call (`SESSION_TTL_SEC` is a constant in `auth.ts`, not an env var), the refresh path
  already exists.

Residual: `keystore.ts` keeps API keys the user created in the browser in `localStorage`; those
are per-key spend-limited and revocable, and the user chose to store them. Tests: cookie flags,
GET-with-cookie, POST without / with wrong / with matching CSRF on `/keys` (POST, PATCH, DELETE),
`/nodes/link`, refresh and logout, bearer + stale cookie, exempt routes, CORS preflight with
credentials, Playwright: reload without the hint, HttpOnly invisible to `document.cookie`, sign out
clears the cookie (`apps/web/e2e/app.spec.ts`).

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

### 17. `/admin/*` exposure — Medium — Fixed (session 6)

Admin routes live on the same listener as the public API; the Caddyfile returns 404 for
`/admin/*` and the compose file binds the gateway to `127.0.0.1`. Both stay as defence in depth.
Added in the gateway:

- `ADMIN_IP_ALLOWLIST` (CIDRs): an `onRequest` hook answers `403 forbidden` for `/admin/*` and
  `/health/alerts` from any other client IP, before auth runs, and writes an `admin-denied-ip`
  audit row with the IP, path and request id. Unset = not enforced (dev). `req.ip` honours
  `X-Forwarded-For` only from `TRUSTED_PROXY_CIDRS` (#20), so a client cannot spoof its way in.
- `POST /admin/login` (admin token in `x-admin-token`, bearer or `{token}` body) sets `mesh_admin`,
  an `HttpOnly` cookie holding a 12-hour JWT with `aud: mesh-admin` (never the token itself), plus
  the `mesh_csrf` cookie; `requireAdmin` accepts the header or that cookie; `GET /admin/session`
  checks it; `POST /admin/logout` clears it. `verifySession` rejects any JWT with an audience and
  `verifyAdminSession` requires it, so neither cookie can impersonate the other. The web Admin page
  now sends the token exactly once and holds nothing afterwards (reload keeps you signed in).
- Audit: handlers keep their payload rows (`run-epoch`, `starter-credits`, …); an `onResponse` hook
  on the admin plugin records every other call as `admin-call` (2xx mutations such as login/logout)
  or `admin-denied` (any non-2xx: wrong token, 404, 400, CSRF failure) with method, path, status,
  IP, auth method and request id. Successful `GET`s (the overview polls every 30 s) are logged, not
  persisted, so the "recent actions" list stays readable.

Tests: cookie login / forged cookie / wallet cookie on admin, CSRF on admin mutations, allowlist
403 + audit, forwarded-for from trusted vs untrusted peers, Playwright admin page flow.

### 18. Unsalted SHA-256 for API keys / node tokens — Low — Fixed for API keys (session 6)

Keys are `mesh_sk_` + 24 random bytes (192 bits), so a dump of `api_keys.key_hash` was never
brute-forceable; the remaining concern was a dump **plus** a partially known key (logs, screenshots)
being confirmable offline. `hashApiKey(key, pepper)` is now `h1$` + HMAC-SHA256(`KEY_PEPPER`, key):
without the server-side pepper the column is inert, and the lookup stays O(1) (no per-row salt).
Migration is lazy: `lookupApiKey` tries the peppered hash, then the legacy sha256; a legacy hit is
rewritten to the peppered form in the same call (`UPDATE … WHERE key_hash = <old>`), so the table
converts itself as keys are used, with no downtime and no plaintext ever needed. Revoked legacy
rows are not resurrected. `KEY_PEPPER` is required (≥ 32 chars, non-default) in production; rotating
it invalidates every key, so the runbook treats it like `JWT_SECRET`.

Node tokens (`mesh_nt_`, `nodes.token_hash`) keep plain sha256 for now: `routes/nodes.ts` is owned by
the node-protocol work; the same `hashApiKey`-style pepper can be applied there with the same lazy
rehash (open, Low).

### 19. Geo-block header trust — Medium — Fixed (session 6)

`geoblock.ts` trusted `CF-IPCountry` / `X-Country` from anyone. Now `geoBlockHook` takes
`trustedPeer(ip)` and ignores the headers unless the **TCP peer** (`req.socket.remoteAddress`, never
a forwarded value) is in `TRUSTED_PROXY_CIDRS`. A direct client claiming `X-Country: FR` is neither
trusted nor blocked by its own header; a blocked country reported by the proxy is still 451. The
Caddy `request_header -…` lines and the pre-flight curl stay as the second layer (a proxy that
forwards a client's copy would still be believed, because the proxy is trusted).

### 20. `trustProxy: true` — Medium — Fixed (session 6)

Fastify was configured to believe `X-Forwarded-For` from any peer, so `req.ip` (rate-limit keys,
the new admin allowlist, audit rows) could be set by the client. `trustProxy` is now the
`TRUSTED_PROXY_CIDRS` list (default: loopback + RFC 1918 + ULA, i.e. Caddy on the same host or docker
network; `*` restores trust-everyone and is refused in production). Add your CDN's ranges if it
connects to the gateway directly.

### 21. Request ids — Low — Fixed (session 6)

Every response carries `x-request-id` (CORS-exposed): the proxy's `x-request-id` when present,
otherwise a UUID. Error bodies outside `/v1` already included `requestId`; the 403s from the CSRF
and allowlist hooks do too, and `req.log` lines carry `reqId`, so a user report can be matched to
a log line and an `admin_actions` / `errors_log` row.

## Session 6: cookie sessions and admin hardening (what landed, verified against the tree)

| Item | Where in the code | Status |
| --- | --- | --- |
| Session JWT moved from `localStorage` to an `HttpOnly` `mesh_session` cookie + `mesh_csrf` double submit (#14) | `apps/gateway/src/context.ts:setSessionCookies`, `server.ts:csrfApplies`, `apps/web/src/lib/auth.tsx` (keeps only `{wallet, chain}` as a hint) | Done |
| `ADMIN_IP_ALLOWLIST` enforced in-gateway, denials audited (#17) | `server.ts` `onRequest` hook, `env.ts:adminIpAllowlist`, `db.ts:recordAdminAction('admin-denied-ip')` | Done |
| Admin cookie session (`mesh_admin`, 12 h, `aud: mesh-admin`) + full admin audit (#17) | `auth.ts:ADMIN_SESSION_TTL_SEC`, `routes/admin.ts` (`/admin/login`, `/admin/session`, `/admin/logout`, `onResponse` audit) | Done |
| Peppered API-key hashes `h1$HMAC-SHA256(KEY_PEPPER, key)` with lazy rehash of legacy sha256 rows (#18) | `auth.ts:hashApiKey`, `auth.ts:lookupApiKey`, `env.ts` (`KEY_PEPPER` required ≥ 32 chars in production) | Done for API keys; node tokens still plain sha256 (open, Low) |
| Proxy trust: `trustProxy` = `TRUSTED_PROXY_CIDRS`, geo headers believed only from trusted peers (#19, #20) | `server.ts`, `env.ts:trustedProxyCidrs`, `netaddr.ts:cidrMatcher`, `geoblock.ts` | Done |
| `x-request-id` on every response and in error bodies (#21) | `server.ts` (`requestIdHeader`, `genReqId`, `onSend`) | Done |
| `.env.example` documents `KEY_PEPPER`, `TRUSTED_PROXY_CIDRS`, `ADMIN_IP_ALLOWLIST`, `COOKIE_SECURE`, `COOKIE_DOMAIN` | `.env.example` | Done |

Tests: `apps/gateway/test/session-hardening.test.ts` (15) and `security.test.ts` (28), plus the
Playwright flows in `apps/web/e2e/app.spec.ts` (reload without the hint, `HttpOnly` invisible to
`document.cookie`, sign out clears the cookie, admin page login).

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
- `ADMIN_IP_ALLOWLIST` is the in-gateway gate for `/admin/*`; when you need the web Admin page from
  a new network, add that /32 (restart) rather than loosening the Caddy rule.
- Rotate `KEY_PEPPER` only on a confirmed DB-dump + pepper leak: it invalidates every API key.
- Session cookies are `SameSite=Lax`, host-only to the API hostname: keep the web app and the API
  on the same registrable domain, or set `COOKIE_DOMAIN` deliberately.

## Still open after session 6

- #15 single-instance limits (by design).
- Node-token pepper (see #18).
- Session TTL is still 7 days with refresh; shortening to 24 h is a one-constant product decision.
- Web `keystore.ts` keeps user-created API keys in `localStorage` by the user's choice.

## Session 8: pre-beta hardening pass (2026-10-04)

Scope: a second read of every file under `apps/gateway/src` for crashes on malformed input, races, money
bugs, auth holes, SSE/relay resource issues, privacy leaks and SQLite pitfalls, plus the load-test
bottlenecks in `docs/LOADTEST.md`. Tests: `apps/gateway/test/hardening.test.ts` (20), existing suites
updated where semantics changed (272 gateway tests in all).

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| H1 | Node-reported token counts were unbounded: a node could bill the client (and earn) any number of tokens | **High** | **Fixed** (`DoneBody` bounds, broker clamps completion ≤ `max_tokens`, prompt ≤ 4 × payload bytes + 1024; the clamped usage is what is billed/rewarded) |
| H2 | `done` with no delivered chunk was a paid reply | **High** | **Fixed** (`409 empty_output`, job failed with node fault, retry/fallback, nothing charged) |
| H3 | Heartbeat `busy: false` reset a node's busy flag mid-job → double booking; re-registration did the same | Medium | **Fixed** (busy is the broker's running count; heartbeat `busy` only pins/unpins; register keeps the count) |
| H4 | Node `/fail` error text reached `x-mesh-fallback` unsanitised: a CR/LF made the fallback response throw (500 instead of the upstream answer) | Medium | **Fixed** (`FailBody` strips control chars; `headerSafe` on the header) |
| H5 | Upstream SSE: a client disconnect mid-stream left the handler awaiting a `drain` that never fires (`raw.write` on a destroyed socket) → leaked handler, request never recorded | Medium | **Fixed** (`sseWriter` waits for `drain` or `close`; node path got the same writer and so backpressure) |
| H6 | Concurrent `runEpoch` (cron + admin) both swept fees; the loser's sweep was never booked | Medium | **Fixed** (per-DB promise lock; second call returns `skipped`) |
| H7 | `JobRelay` gap buffer unbounded: a node could park megabytes per job with sparse `seq`s | Medium | **Fixed** (`RELAY_MAX_PENDING` 2048, `RELAY_MAX_BUFFERED_BYTES` 4 MB, `seq` ≤ 1e6, chunks refused after done) |
| H8 | Registration limiter keyed on IP only (10/h) blocked legitimate multi-Mac operators; no per-wallet bound | Low | **Fixed** (strict budget per proven wallet, per IP otherwise; `NODE_REGISTER_IP_RATE_LIMIT` backstop) |
| H9 | Malformed upstream `usage` / `model` (non-numeric tokens, object model) could throw after the upstream had answered | Low | **Fixed** (`normalizeUsage`, `tokenCount`; model coerced) |
| H10 | Link-code consumption, node insert and first heartbeat were not atomic | Low | **Fixed** (one transaction) |
| H11 | Surplus long-polls from one node lingered until their timer | Low | **Fixed** (released with 204 at once; up to `maxParallel` parked) |
| H12 | `nodeStatsView` reputation ignored `verification.mismatchPenalty` | Low | **Fixed** (`reputationConfig`) |

Checked again and found sound: CSRF coverage of every cookie-authenticated mutation (new routes included),
admin routes all behind `requireAdmin` + allowlist, `jobView` still exactly `JOB_VIEW_FIELDS`, claim
atomicity under the new concurrency model (`tryClaim` unchanged), guest quota consume/refund, ledger
writes under transactions, no requester identity in node-facing payloads or alerts.

Still open (noted, not fixed):

- A key revoked or a wallet exhausted mid-stream keeps streaming until the reply ends; the request is
  then charged. Bounded by `max_tokens`; a per-chunk re-check is a product call.
- Spend limit / balance are checked before the request, so N concurrent requests on one key can
  overshoot by N × one request's cost (bounded by H1).
- An upstream stream the client aborts before the final usage chunk is recorded with 0 tokens (the
  upstream still bills the operator). Estimating from bytes relayed is possible but was not done.
- Node tokens still use plain sha256 (see #18).

## Privacy (session 7, 2026-10-03)

Scope: requests served by third-party Macs. Full write-up in `docs/PRIVACY.md`; this section records
what changed in the gateway and the node agent and what remains open. Tests:
`apps/gateway/test/privacy.test.ts` (20) and `apps/node-agent/test/privacy.test.ts` (6).

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| P1 | Node job payload carried the client-facing model name; messages forwarded verbatim (OpenAI `name`, tool ids, image parts) | Medium | **Fixed** (`jobView` is exactly `JOB_VIEW_FIELDS`; `sanitizeMessages` keeps role + text only; params whitelisted; test plants identifiers and asserts none survive) |
| P2 | Any eligible node could serve any request | Medium | **Fixed** (privacy tiers: `trusted` jobs are claimable only by trusted nodes, enforced in the claim `UPDATE`; explicit trusted never degrades to `network`; fallback is the ZDR upstream) |
| P3 | Upstream calls made no data-retention request | Low | **Fixed** (`provider.data_collection: "deny"` on every upstream call unless the caller chose `network`; `mesh` block stripped from the upstream body) |
| P4 | Node agent could in principle log job content | Low | **Fixed** (log lines carry ids/counts/timings only, asserted; buffers scrubbed after each job; `keep_alive`, `OLLAMA_NOHISTORY=1`, `OLLAMA_DEBUG=0`) |
| P5 | Trusted status had no operator commitment | Medium | **Fixed** (`POST /nodes/:id/pledge`: wallet-signed pledge bound to node id; `pledge_at`/`pledge_signature`/`pledge_chain` stored; trusted = allowlist, or gold stake + pledge) |
| P6 | Plaintext visible to the serving machine; memory inspection by its operator | High | **Open by nature** (documented in PRIVACY.md §4; policy control via pledge + stake + revocation; confidential compute on the roadmap, §6) |
| P7 | Client `user` field passes through to OpenRouter | Low | Open (standard OpenAI field; documented; callers can omit it) |

Details:

- **Tier resolution** (`routing.ts:resolvePrivacy`): header `X-Mesh-Privacy` > body `mesh.privacy` >
  API key default (`api_keys.privacy`, `PATCH /keys/:id`) > `config.privacy.default` (`trusted`). An
  unknown or disabled value is `400 invalid_privacy_tier`; nothing is coerced. `config.privacy.fallback
  = "network"` is honoured only for the implicit default, never for an explicit trusted request.
- **Claim enforcement** (`network.ts`): `jobs.privacy` is stored; `tryClaim` and `pull` add
  `AND (privacy != 'trusted' OR <trusted> = 1)`; long-poll waiters record their trust at wait time and
  a trusted job skips untrusted waiters. The broker's trust callback is `routing.ts:isTrustedNode`,
  reading the per-epoch stake cache, so a wallet that unstakes loses trusted status at the next epoch.
- **Pledge** (`auth.ts:pledgeMessage`): nonce-free by design (stable, reviewable text identical to the
  docs), bound to wallet + node id, first line distinct from sign-in and registration so
  `parseLoginMessage` rejects it and a pledge signature cannot register or log in. Only the owning
  wallet's session may read or sign it; a node token is refused.
- **Response transparency**: `x-mesh-privacy`, `x-mesh-served-by`, `x-mesh-fallback: no_trusted_node`,
  and `mesh.privacy` / `mesh.servedBy` in the final chunk for node- and upstream-served replies alike.
- **Honesty in copy**: landing privacy block, Docs "Privacy tiers", the legal privacy page and the
  Node page say that the serving machine sees plaintext and that trusted is a policy tier; "fully
  private" does not appear.

Operating guidance:

- Allowlist a wallet (`config.privacy.trustedWallets`) only for machines you control; it bypasses stake
  and pledge.
- To drop a node from the trusted tier immediately: `UPDATE nodes SET pledge_at = NULL WHERE node_id = ?`
  (stake-based trust) or remove it from the allowlist and restart. Re-pledging is one signature.
- Keep `OLLAMA_DEBUG` unset on any `ollama serve` you run yourself; with it the server log contains
  request bodies.
