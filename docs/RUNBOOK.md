# Mesh launch runbook

One operator, one VPS, one afternoon. Every command is meant to be pasted in order. Where the chain
matters there are two clearly marked variants, **[Solana]** and **[EVM]**; `config/tokenomics.json →
chain` decides which one you follow. (`scripts/chain/` does not exist yet; when the chain adapters
land, their helper scripts go there and the variant blocks below reference them by name.)

Conventions: `$A`/`$J` are the admin and JSON headers set in step 3; `api.example.com` is your API
host; `app.example.com` is the web app's origin. Times are UTC on the box, 09:00 Asia/Dubai for the
daily digest.

---

## 0. T-1 day: what must already be true

- VPS exists (Ubuntu 24.04, ≥1 vCPU / 1 GB / 20 GB), DNS **A record** for `api.example.com` points at
  it, the web app is deployed at `app.example.com` with `VITE_API_URL=https://api.example.com`.
- OpenRouter key created **with a monthly spend limit** on openrouter.ai.
- Telegram bot created with @BotFather, added to your ops group, chat id noted
  (`https://api.telegram.org/bot<TOKEN>/getUpdates` after posting in the group).
- Repo at the launch tag: `git tag launch-$(date +%F)` on the commit you tested.
- Local gates green on that commit:

```sh
pnpm install && pnpm -r typecheck && pnpm -r build && pnpm test && pnpm --filter web e2e
```

- **[Solana]** token mint + fee vault deployed, `config/tokenomics.json → meta.contractAddress`,
  `meta.totalSupply`, `chain: "solana"` filled; Helius/RPC URL and the sweep signer keypair ready.
- **[EVM]** token + fee receiver deployed, same `meta` fields with `chain: "evm"`; RPC URL and the
  sweep signer private key ready.
- If the chain adapter is **not** wired yet, you launch with `MESH_ADAPTER=mock` and feed fees by
  hand (`/admin/fake-fees`); say so in the launch thread (see `docs/LAUNCH_COPY.md`, risk paragraph).

---

## 1. Base system (from `scripts/deploy-vps.md` §1)

```sh
ssh root@YOUR_VPS_IP
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw sqlite3 jq
timedatectl set-timezone UTC
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
adduser --disabled-password --gecos "" mesh
usermod -aG sudo mesh
rsync -a ~/.ssh/ /home/mesh/.ssh/ && chown -R mesh:mesh /home/mesh/.ssh
```

## 2. Docker (§2)

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker mesh
systemctl enable --now docker
exit
ssh mesh@YOUR_VPS_IP
docker ps        # empty table, no permission error
```

## 3. Clone and configure (§3 + session-5 settings)

```sh
git clone https://github.com/YOUR_ORG/mesh.git ~/mesh
cd ~/mesh && git checkout launch-$(date +%F)     # the tag you tested
cp .env.example .env
chmod 600 .env
{
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "ADMIN_TOKEN=$(openssl rand -hex 24)"
  echo "KEY_PEPPER=$(openssl rand -hex 32)"
} >> .env
nano .env
```

Make sure these lines are set (later lines win over earlier ones in `.env`):

```ini
NODE_ENV=production
AUTH_DOMAIN=api.example.com
AUTH_URI=https://api.example.com
CORS_ORIGINS=https://app.example.com          # the web app's origin; the browser cannot sign in without it
KEY_PEPPER=<openssl rand -hex 32>             # API-key hash pepper (session 6); rotating it invalidates every key
TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128        # peers whose X-Forwarded-For / CF-IPCountry we believe (Caddy on this host); add CDN ranges if it connects directly
ADMIN_IP_ALLOWLIST=127.0.0.1/32,<your office or VPN /32>   # /admin/* and /health/alerts answer 403 from anywhere else (optional, recommended)
# COOKIE_DOMAIN=.example.com                   # only if the web app and the API are on different subdomains AND you want one cookie for both; host-only by default
OPENROUTER_API_KEY=sk-or-v1-...
EPOCH_CRON=0 * * * *
V1_RATE_LIMIT=120
AUTH_RATE_LIMIT=20
NODE_REGISTER_RATE_LIMIT=10
LOG_LEVEL=info
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-100...
ALERTS_ENABLED=true
# never in production: ALLOW_DEV_LOGIN, NODES_REQUIRE_SIGNATURE=false
```

The gateway **refuses to start** in production with the default secrets (`JWT_SECRET`, `ADMIN_TOKEN`,
`KEY_PEPPER`), `AUTH_DOMAIN=localhost…`, `CORS_ORIGINS=*` or `TRUSTED_PROXY_CIDRS=*` (it prints every
problem; fix and `docker compose up -d` again).

Cookie sessions (session 6): the browser holds the session as an `HttpOnly; Secure; SameSite=Lax`
cookie set by the API host, so the web app and the API must be **same-site** (`app.example.com` +
`api.example.com` is fine; `app.vercel.app` + `api.example.com` is not: the browser would drop the
cookie). `CORS_ORIGINS` must name the exact web origin because credentialed CORS cannot use `*`.
Upgrading from a build that kept the JWT in `localStorage` is seamless: the first page load trades
the stored token for the cookie through `POST /auth/refresh` and forgets it.

Chain settings:

```ini
# [Solana]
MESH_ADAPTER=chain
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_SWEEP_KEYPAIR=/data/sweep.json        # mount it into the volume; chmod 600
# [EVM]
MESH_ADAPTER=chain
EVM_RPC_URL=https://...
EVM_SWEEP_PRIVATE_KEY=0x...
# [not wired yet]
MESH_ADAPTER=mock
```

(The exact variable names are declared by the chain adapter when it lands; `apps/gateway/src/env.ts`
is the source of truth. With `MESH_ADAPTER=chain` and no adapter, boot fails with `NotWiredError`;
that is your signal to use `mock`.)

Load the admin helpers you will use for the rest of the day:

```sh
cd ~/mesh && set -a && . ./.env && set +a
A="x-admin-token: $ADMIN_TOKEN"; J='content-type: application/json'; G=http://127.0.0.1:8787
```

## 4. Build and run (§4)

```sh
docker compose up -d --build
docker compose logs -f gateway          # wait for "mesh gateway up" with alerts: telegram; Ctrl-C
curl -s $G/health | jq
```

Expected `ok: true`, `db: ok`, `upstream: openrouter`, `upstreamMode: live`. The first boot sends
nothing to Telegram; verify delivery in pre-flight.

## 5. Caddy (§5)

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
api.example.com {
    encode zstd gzip
    request_header -CF-IPCountry
    request_header -X-Country
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
        transport http {
            read_timeout 10m
        }
    }
    @admin path /admin/*
    respond @admin 404
}
EOF
# The gateway also enforces ADMIN_IP_ALLOWLIST itself (session 6), so a proxy slip no longer exposes /admin/*.
# To use the web Admin page remotely, replace the 404 rule with an IP matcher
# (`@admin { path /admin/* not remote_ip <your /32> }`) and keep ADMIN_IP_ALLOWLIST as the second gate.
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy && sudo systemctl reload caddy
```

Behind Cloudflare (orange cloud): SSL mode **Full (strict)** and delete the two `request_header -…`
lines so Cloudflare's `CF-IPCountry` passes through. Without Cloudflare and with geo-blocking
required, add the MaxMind plugin per `scripts/deploy-vps.md` §5.

## 6. Pre-flight checks (all must pass)

```sh
# public surface
curl -s https://api.example.com/health | jq '.ok, .upstream, .geoBlock'
curl -s https://api.example.com/stats  | jq '.token, .epochsRun, .nodesOnline'
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/admin/overview        # 404 via Caddy
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/admin/dev-login # 404
curl -sI https://api.example.com/health | grep -i -E 'strict-transport|x-content-type|x-frame'
# geo header spoof is stripped (expect 200, not 451)
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Country: US' https://api.example.com/v1/models
# CORS: your origin is allowed, a stranger is not (no access-control-allow-origin on the second)
curl -sI -H 'Origin: https://app.example.com' https://api.example.com/stats | grep -i access-control-allow-origin
curl -sI -H 'Origin: https://evil.example'    https://api.example.com/stats | grep -i access-control-allow-origin || echo "stranger blocked"
# admin works locally
curl -s $G/admin/overview -H "$A" | jq .totals
# alerts: monitor is live and talks to Telegram (send a test message through the bot)
curl -s $G/health/alerts -H "$A" | jq '.sender, .lastCheckAt, [.alerts[] | select(.firing)]'
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id="$TELEGRAM_CHAT_ID" -d text="[mesh] pre-flight: ops channel wired" | jq .ok
# wallet sign-in from a real wallet: open https://app.example.com, connect, sign, create a key, send one chat message.
# the backup path works
docker run --rm -v mesh_mesh-data:/data -v "$PWD":/out alpine cp /data/mesh.db /out/mesh-preflight.db && ls -la mesh-preflight.db
```

Chain pre-flight:

```sh
# [Solana] vault holds fees, sweep signer has SOL for fees, holders snapshot returns > 0 wallets
#   solana balance <VAULT>            ; solana balance <SWEEP_SIGNER>
#   (scripts/chain/solana-snapshot.sh when present)
# [EVM] fee receiver balance, signer has gas, holders indexer reachable
#   cast balance <FEE_RECEIVER> --rpc-url $EVM_RPC_URL ; cast balance <SIGNER> --rpc-url $EVM_RPC_URL
#   (scripts/chain/evm-snapshot.sh when present)
# [mock] seed something so the first epoch is not empty
curl -s -X POST $G/admin/fake-fees -H "$A" -H "$J" -d '{"amountUsd":50}' | jq
```

Dry-run one epoch **before** announcing (idempotent per hour; a second call returns `skipped`):

```sh
curl -s -X POST $G/admin/run-epoch -H "$A" -H "$J" -d '{}' | jq '.status, .feesUsd, .eligibleHolders, .holderPoolUsd'
curl -s $G/epochs?limit=3 | jq .epochs
```

## 7. Go / no-go

Go only if **all** are true:

| Check | Go |
| --- | --- |
| `/health.ok` true over HTTPS, `upstream: openrouter` | ☐ |
| `/admin/*` → 404 publicly, works on `127.0.0.1` | ☐ |
| Real wallet signed in, key created, one completion billed (balance moved) | ☐ |
| Dry-run epoch `complete` (or `empty` with a known reason) | ☐ |
| Telegram test message arrived; `/health/alerts` shows `sender: telegram`, nothing firing | ☐ |
| Backup file copied off the box (scp it to your laptop) | ☐ |
| OpenRouter spend cap set; `.env` is `chmod 600`; secrets are random | ☐ |
| Geo spoof test returned 200 (header stripped) or you are behind Cloudflare | ☐ |
| **[Solana]/[EVM]** sweep signer funded, vault/receiver readable, snapshot non-empty | ☐ |

Any ☐ left → **no-go**; post "launch moved to <time>" rather than launching half-ready.

## 8. Launch (T0)

```sh
# starter credits for the friends list (one audited batch)
curl -s -X POST $G/admin/starter-credits -H "$A" -H "$J" \
  -d '{"note":"launch","items":[{"wallet":"<w1>","amountUsd":2},{"wallet":"<w2>","amountUsd":2}]}' | jq '.count, .totalUsd'
# post the thread (docs/LAUNCH_COPY.md), send the node operator invite
# watch the first real epoch land at the top of the hour
watch -n 30 "curl -s $G/epochs?limit=1 | jq -c '.epochs[0]'"
```

## 9. First 24 hours: what to watch

Every hour (set a timer for :05):

```sh
curl -s $G/epochs?limit=1 | jq -c '.epochs[0] | {epochStart, status, feesUsd, eligibleHolders}'
curl -s $G/admin/overview -H "$A" | jq -c '.totals, (.recentErrors[:5] | map({code, created_at}))'
curl -s $G/health/alerts -H "$A" | jq -c '[.alerts[] | select(.firing) | .key]'
docker compose logs --since 1h gateway | grep -c -E '"level":(50|60)'      # error lines
df -h /var/lib/docker | tail -1
```

Expect: one new epoch per hour (`complete`, or `empty` if no trades), `requests24h` rising,
`recentErrors` mostly `upstream_*` at a low rate, no alert firing, disk flat. The daily digest
arrives at 09:00 Dubai with fees, credits, requests, nodes and errors for the last 24 h.

Alert → playbook map: `missed_epoch`/`failed_sweep` → §11a; `upstream_error_rate` → §11b;
`fleet_drop` → §11c; `db_size`/`disk_low` → §11e (grow the disk or prune `heartbeats`/`requests_log`).

Backup at T+2h and T+24h (then daily via cron):

```sh
docker run --rm -v mesh_mesh-data:/data -v "$PWD":/out alpine sh -c 'cp /data/mesh.db /out/mesh-$(date +%F-%H%M).db'
scp mesh@YOUR_VPS_IP:~/mesh/mesh-*.db ~/backups/     # from your laptop
```

## 9b. Public beta rollout

The launch above is a **public beta**: anyone can see the site, nobody signs in or runs a node until
their wallet is admitted (`config/tokenomics.json → beta`, `apps/gateway/src/beta.ts`). The web app
shows the `Beta` pill, the landing CTA is "Join the waitlist" (wallet or e-mail → `POST /waitlist`),
and `POST /auth/verify` answers `403 invite_required` until the wallet presents a code once.

```json
"beta": { "enabled": true, "label": "Beta", "inviteRequired": true, "batchSize": 200 }
```

**Day 0: seed.** Mint codes for the friends list and the node operators you already know (one code
per person, or one shared code with N uses for a group chat), then send them yourself:

```sh
curl -s -X POST $G/admin/invites -H "$A" -H "$J" -d '{"count":10,"uses":1}' | jq -r '.codes[]'
curl -s -X POST $G/admin/invites -H "$A" -H "$J" -d '{"count":1,"uses":25}' | jq -r '.codes[0]'   # one code for the ops chat
curl -s -X POST $G/admin/admit -H "$A" -H "$J" -d '{"wallet":"<wallet>"}'                        # admit one wallet by hand
```

A wallet that signs in with a code is admitted for good (`admissions` table); the code loses one use.
Node registration checks the same table, so an operator signs in on the web first, then links the Mac.

**Batches.** Admit from the waitlist oldest-first, `batchSize` (200) at a time, from the Admin page
("Admit next 200") or:

```sh
curl -s -X POST $G/admin/waitlist/admit -H "$A" -H "$J" -d '{"n":200}' | jq -r '.entries[] | "\(.email // .wallet)\t\(.code)"'
curl -s "$G/admin/waitlist?status=waiting&limit=5" -H "$A" | jq '.counts'
```

Each e-mail entry gets a **one-use code** you send by hand (mail-merge the two columns; there is no
mailer in the gateway); wallet entries are admitted directly and sign in without typing anything.
The call is idempotent in the sense that an entry is admitted once; running it again takes the next
oldest. Suggested cadence: one batch per day for the first week, then two, as long as the signals
below stay green. Space batches at least a few hours apart so a bad batch is attributable.

**What to watch between batches** (all in `GET /admin/overview`, the Admin page, or `/health/alerts`):

| Signal | Green | Act when |
| --- | --- | --- |
| `recentErrors` rate (5xx, `upstream_*`, `node_stream_failed`) | flat per request | rises with the batch → hold the next one, read §11b/§11c |
| `totals.requests24h` ÷ admitted wallets | > 1 (people actually use it) | ≪ 1 for two batches → the onboarding is broken, not the capacity; check the sign-in funnel before admitting more |
| OpenRouter spend vs. cap (`/report`, provider dashboard) | within the daily budget | > 70 % of the cap → smaller batch or raise the cap |
| `nodesOnline`, `servedByNetworkPercent` | both rising with the operator invites | share falls while requests rise → you admitted users faster than operators; send the operator invite (LAUNCH_COPY §4) before the next user batch |
| `verification` (`mismatch`, `quarantinedNodes`, `docs/NODE_PROTOCOL.md` §10) | mismatches rare, quarantines explainable | a quarantine per batch → look at the nodes before inviting more operators; clear only after you understand why |
| Credits: `creditsOutstandingUsd` vs. fees | outstanding grows slower than fees | starter credits dwarf earned ones → stop handing out starters |
| Waitlist `waiting` | shrinking | growing faster than you admit for a week → bigger batches, or open fully |
| Disk, DB size | flat | §11e |

Between batches also read the last 20 `admin_actions` (you are the only admin; anything you did not do
is an incident, §11d) and spot-check one admitted wallet's `/me` for a sane ledger.

**When to open fully.** Flip `beta.inviteRequired` to `false` (rebuild, `config/*.json` is baked in)
when all of these have held for a week: no batch caused an error spike, the network share is where
you want it with headroom (idle nodes online at the daily peak), OpenRouter spend is predictable and
under the cap, the waitlist is being admitted faster than it grows, and the spot-check mismatch rate
is near zero with no unexplained quarantine. Keep `beta.enabled: true` (the pill and the Terms "Beta"
clause stay) until you are also happy to drop the "we may reset or pause" language; then set
`enabled: false`, which hides the pill, closes the waitlist (`POST /waitlist` → 404) and changes
nothing else. Admissions stay in the table; they are harmless once the gate is off.

**Closing again.** Set `inviteRequired: true` and rebuild: already-admitted wallets keep working,
new wallets see the waitlist. No data changes, so this is the fastest brake you have short of
stopping the gateway.

## 10. Rollback

```sh
cd ~/mesh
git checkout <previous-tag-or-sha>
docker compose up -d --build
docker compose logs --tail=50 gateway && curl -s $G/health | jq .ok
```

Migrations are additive (`schema_migrations`), so an older image runs against a newer DB. Rolling
back **config** (`config/*.json`) needs a rebuild too; rolling back `.env` does not. If the rollback
is because of bad ledger writes, see §11e (DB restore) **first**, then roll the code back.

## 11. Incident playbooks

### 11a. Sweep failed / epoch missed (`failed_sweep`, `missed_epoch`)

1. What happened: `curl -s $G/admin/overview -H "$A" | jq '.recentErrors | map(select(.code=="epoch_failed"))[:3]'`
   and `docker compose logs --since 2h gateway | grep 'epoch run failed'`.
2. Nothing was written for that hour (`runEpoch` writes ledger + epoch row in one transaction), so
   holders simply have not been credited yet. Nothing to undo.
3. Fix the cause:
   - RPC/indexer down → wait or switch `*_RPC_URL`, `docker compose up -d`.
   - **[Solana]** signer out of SOL / **[EVM]** signer out of gas → fund it (`solana transfer` /
     `cast send`), then re-run.
   - Price source failure (USD valuation) → same; do not guess a price.
   - Cron silently not firing (`missed_epoch` without `failed_sweep`) → `docker compose restart gateway`,
     check `EPOCH_CRON` in `.env` and the container clock (`docker compose exec gateway date`).
4. Re-run the missed hour explicitly (idempotent; `epochStart` = unix seconds of that hour):
   `curl -s -X POST $G/admin/run-epoch -H "$A" -H "$J" -d '{"epochStart": 1759500000}' | jq .status`
5. If the sweep already moved funds on-chain but the write failed, **do not** re-run blindly: check the
   vault/receiver balance first; re-run only if the fees are still unswept, otherwise record the epoch
   with the tx id by hand and credit with `/admin/starter-credits` (note: `ref` is `admin:batch:<id>`).
6. Tell holders in the channel: "epoch HH:00 delayed, credits land at the next run".

### 11b. Upstream down (`upstream_error_rate`, OpenRouter 5xx/timeouts)

1. Confirm: `curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" -o /dev/null -w '%{http_code}\n'`
   and `jq '.recentErrors[:10]'` on the overview (`upstream_timeout`, `upstream_network`, `upstream_error`).
2. Users are **not charged** for failed requests (every 502 says so). Network-model requests still
   work while nodes are online.
3. If it is a key problem (401/402 from OpenRouter): rotate the key on openrouter.ai, put it in
   `.env`, `docker compose up -d`. If it is their outage: post status, optionally raise
   `UPSTREAM_TIMEOUT_MS`, and let the alert resolve itself (it re-notifies every 6 h while firing).
4. Afterwards, the digest's `errors:` line shows the blast radius.

### 11c. Node fleet down (`fleet_drop`, `nodesOnline` → 0)

1. Confirm: `curl -s $G/nodes | jq '{online,total,models}'` and `jq '.nodes | map({nodeId, online, lastSeen})'` on the overview.
2. Requests fall back to OpenRouter automatically (`x-mesh-route: openrouter`, `x-mesh-fallback`);
   cost per request rises from `$0.02/M` to passthrough. No action needed for users.
3. If **all** nodes dropped at once the gateway side is the suspect: a deploy that changed the node
   token hashing, `NODES_REQUIRE_SIGNATURE` flipped, or Caddy rejecting long-polls (`read_timeout`).
   Check `docker compose logs --since 30m gateway | grep -E 'unauthorized|node'`.
4. If one operator dropped: ping them with the agent restart (`mesh-node status`, `mesh-node start`).
   A `401` on heartbeat means the DB lost their token (e.g. restore): they re-register
   (`mesh-node setup` with a fresh signed challenge; see `docs/NODE_PROTOCOL.md §1`).

### 11d. Key leak (an API key or admin token ends up public)

API key:
1. Find it: `sqlite3 /path/mesh.db "SELECT id, wallet, key_prefix, spent_usd_micros FROM api_keys WHERE key_prefix = 'mesh_sk_XXXXXX';"`
   (prefix = first 14 chars of the leaked key). From inside the container: `docker compose exec gateway sh -c 'sqlite3 /data/mesh.db ...'`
   (if `sqlite3` is missing in the image, copy the DB out as in §9 and query the copy, then apply the
   UPDATE via a one-off `docker compose exec gateway node -e` or ask the holder to revoke in the app).
2. Revoke: the holder clicks Revoke in the app (immediate), or you run
   `UPDATE api_keys SET revoked = 1 WHERE id = <id>;`. Requests using it fail with 401 at once.
3. Damage: `SELECT COUNT(*), SUM(cost_usd_micros) FROM requests_log WHERE api_key_id = <id> AND created_at > <leak_ts>;`
   Refund abused spend with `/admin/starter-credit` if it was not the holder's fault.

Admin token:
1. `sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 24)/" .env && docker compose up -d`
   (admin cookies from `POST /admin/login` are JWTs signed with `JWT_SECRET`, 12 h; rotate `JWT_SECRET`
   too if a browser session may have been stolen, otherwise they simply expire).
2. Audit what it did: `jq '.recentAdminActions'` on the overview, especially `dev-login` (should not
   exist in production: `ALLOW_DEV_LOGIN` is off), `starter-credit(s)`, `admin-login` and the
   `admin-denied` / `admin-denied-ip` rows (every failed admin call is recorded with its IP and request id).
3. Reverse unauthorized credits with negative `adjustment` rows if any (ledger `kind='adjustment'`).

JWT secret (someone can mint sessions):
1. `JWT_SECRET_PREVIOUS=` leave **empty** (do not honour the leaked one), set a new `JWT_SECRET`,
   `docker compose up -d`. Everyone signs in again; keys are unaffected.

Key pepper (`KEY_PEPPER` leaked together with a DB dump): rotating it invalidates **every** API key
(the stored HMACs no longer match), so only do it if the dump is confirmed: set the new value, restart,
tell holders to create new keys. Without the pepper a dump of `api_keys.key_hash` is useless anyway.

Node token: re-register that `nodeId` with the token + a fresh signed challenge (rotates), or
`UPDATE nodes SET token_hash = NULL WHERE node_id = '<id>';` to force a new identity.

### 11e. DB restore / corruption / disk full

1. Stop writes: `docker compose stop gateway` (users see 502 from Caddy; nothing is billed).
2. Check: `docker run --rm -v mesh_mesh-data:/data alpine sh -c 'apk add -q sqlite && sqlite3 /data/mesh.db "PRAGMA integrity_check;"'`
3. Disk full: `df -h`, `docker system prune -f`, truncate old logs, then
   `sqlite3 mesh.db "DELETE FROM heartbeats WHERE ts < strftime('%s','now') - 172800; VACUUM;"` on a copy first.
4. Restore from the newest backup (the volume is `mesh_mesh-data`):

```sh
docker run --rm -v mesh_mesh-data:/data -v "$PWD":/in alpine sh -c \
  'cp /data/mesh.db /data/mesh.db.corrupt-$(date +%s); rm -f /data/mesh.db-wal /data/mesh.db-shm; cp /in/mesh-2026-10-03-1200.db /data/mesh.db; chown 1000:1000 /data/mesh.db'
docker compose start gateway && curl -s $G/health | jq .ok
```

5. Consequences of restoring to time T: credits/usage after T are gone (holders may be re-credited by
   re-running epochs after T, §11a step 4; usage after T is their gain), API keys created after T are
   invalid (they recreate), node tokens issued after T are unknown (nodes get 401 and re-register),
   nonces after T are gone (harmless). Announce the restore point.
6. Then fix backups: add a daily cron on the box:
   `(crontab -l; echo "17 3 * * * cd ~/mesh && docker run --rm -v mesh_mesh-data:/data -v \$PWD/backups:/out alpine cp /data/mesh.db /out/mesh-\$(date +\%F).db") | crontab -`

### 11f. Gateway refuses to boot

`docker compose logs gateway` says `refusing to start in production:` followed by the list: fix each
`.env` line (`JWT_SECRET` ≥ 32 chars, `ADMIN_TOKEN` ≥ 24, `AUTH_DOMAIN`, `CORS_ORIGINS` not `*`) and
`docker compose up -d`. `invalid EPOCH_CRON` → fix the expression. `NotWiredError` → the adapter for
`MESH_ADAPTER=chain` is not implemented in this build; use `mock` or deploy the build that has it.

---

## Appendix: endpoints an operator uses

| Purpose | Call |
| --- | --- |
| Liveness | `GET /health` |
| Alert state | `GET /health/alerts` (admin) |
| Everything on one screen | `GET /admin/overview` (admin) |
| Force / replay an epoch | `POST /admin/run-epoch {epochStart?}` (admin) |
| Credits for friends | `POST /admin/starter-credits {items:[{wallet, amountUsd}], note}` (admin) |
| Beta: mint invite codes | `POST /admin/invites {count, uses}` (admin) → `codes[]` |
| Beta: admit next waitlist batch | `POST /admin/waitlist/admit {n?}` (admin) → `entries[] {email|wallet, code}` |
| Beta: waitlist + counters | `GET /admin/waitlist?status=waiting|invited|all` (admin) |
| Beta: admit one wallet | `POST /admin/admit {wallet}` (admin) |
| Spot checks: clear / set a quarantine | `POST /admin/nodes/:id/quarantine/clear`, `POST /admin/nodes/:id/quarantine {reason}` (admin) |
| Public telemetry | `GET /stats`, `GET /epochs?limit=48`, `GET /nodes` |
