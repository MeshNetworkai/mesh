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
- **[Robinhood Chain via Pons]** `PonsFeeVault` deployed and set as the Pons `creatorFeeRecipient`.
  `config/deploy.robinhood.json` ships `sweepMode: "swap"`, so three things must exist **before the
  first live sweep**: the settlement stablecoin (`setStable` on the vault, `stable` in Admin → Token),
  a swap route for every fee asset (`setRoute` on the vault; ETH is `address(0)`), and a Chainlink
  ETH/USD feed (`priceFeed`). The `creditPool` wallet is a separate address from the treasury. See the
  chain pre-flight in §6.
- If the chain adapter is **not** wired yet, you launch with `MESH_ADAPTER=mock` and feed fees by
  hand (`/admin/fake-fees`); say so in the launch thread (see the internal docs repo, risk paragraph).

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
# [Robinhood Chain via Pons] (variable names as read by packages/chain-adapter)
MESH_ADAPTER=evm
MESH_EVM_RPC_URL=https://...
MESH_EVM_PRIVATE_KEY=0x...                   # the vault's sweeper
# MESH_FIXED_ETH_USD is for the testnet rehearsal only: it is ignored whenever a priceFeed is configured
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

**[Robinhood Chain via Pons]** the stablecoin, the route and the price feed, before the first sweep:

```sh
# what the gateway will use (file + Admin → Token overrides); sweepMode must say "swap"
curl -s $G/admin/chain -H "$A" | jq '.adapter.status, (.effective | {creditPool, treasury, stable, priceFeed, sweepMode, fixedEthUsd})'
# the same check as Admin → Token → "Check on chain": anything that is not ok
curl -s -X POST $G/admin/chain/check -H "$A" -H "$J" -d '{}' | jq -r '.ok, (.items[] | select(.status=="fail" or .status=="warn") | "\(.status)\t\(.check)\t\(.detail)")'
# the check does not read the swap route or the age of the feed: look at both on chain
cast call <VAULT> "stable()(address)" --rpc-url $MESH_EVM_RPC_URL
cast call <VAULT> "routeOf(address)((uint8,address,uint24,bytes))" 0x0000000000000000000000000000000000000000 --rpc-url $MESH_EVM_RPC_URL   # kind 0 = no route
cast call <PRICE_FEED> "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $MESH_EVM_RPC_URL                     # 4th value = updatedAt
# the reserve line (after the first epoch on the live adapter: source "chain")
curl -s $G/report | jq '.totals.reserve'
```

Expect from the check: `sweepMode "swap": fees settle in the stablecoin on chain` as `ok`, no
`feeVault.stable` warning (`vault has no stable set` means `sweep()` will revert) and no `priceFeed`
warning. A `sweepMode is "raw"` warning on mainnet is a no-go: raw is for the testnet rehearsal. What
happens if one of the three is missing at the first sweep:

| Missing | What the epoch does | Lost? |
| --- | --- | --- |
| stablecoin or route on the vault | that asset's `sweep()` reverts: it is left in the vault and logged as `sweep_skipped`, which raises `failed_sweep` (§11a); anything else swept in the same epoch is credited | no: the fees stay in the vault and nothing is minted for them |
| price feed (none configured, no `fixedEthUsd`) | ETH fees are left unswept, the epoch records $0 of fees for them | no: a later epoch sweeps them (§11h) |
| price feed stale (answer older than an hour) or unreadable | the same: left unswept; logged as `sweep_skipped`, which raises `failed_sweep` | no (§11h) |
| a quote token with no price source (the NVDA token of an NVDA-paired launch, `docs/LAUNCH-DAY.md`) | swapped without a slippage floor and credited with the USDG the swap returned; Admin → Token → Check shows `quoteToken.price.<address>` as a warning | no: expected until a price source for it is added |

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
| **[Pons]** `sweepMode` is `swap`; stablecoin and route set on the vault; price feed answered within the hour; `creditPool` ≠ treasury | ☐ |

Any ☐ left → **no-go**; post "launch moved to <time>" rather than launching half-ready.

## 8. Launch (T0)

```sh
# starter credits for the friends list (one audited batch). Admin grants skip the holding check, but they are
# starter credit like any other: spendable on requests, not listable on the marketplace, gone after 90 days.
curl -s -X POST $G/admin/starter-credits -H "$A" -H "$J" \
  -d '{"note":"launch","items":[{"wallet":"<w1>","amountUsd":2},{"wallet":"<w2>","amountUsd":2}]}' | jq '.count, .totalUsd'
# post the thread (the internal docs repo), send the node operator invite
# watch the first real epoch land at the top of the hour
watch -n 30 "curl -s $G/epochs?limit=1 | jq -c '.epochs[0]'"
```

## 9. First 24 hours: what to watch

Every hour (set a timer for :05):

```sh
curl -s $G/epochs?limit=1 | jq -c '.epochs[0] | {epochStart, status, feesUsd, eligibleHolders}'
curl -s $G/admin/overview -H "$A" | jq -c '.totals, (.recentErrors[:5] | map({code, created_at}))'
curl -s $G/health/alerts -H "$A" | jq -c '[.alerts[] | select(.firing) | .key]'
curl -s $G/report | jq -c '.totals.reserve | {source, heldUsd, requiredUsd, coverage, surplusUsd, short, asOf}'
docker compose logs --since 1h gateway | grep -c -E '"level":(50|60)'      # error lines
docker compose logs --since 1h gateway | grep '"msg":"housekeeping"' | tail -1   # expiredWallets, expiredUsd, reserve
df -h /var/lib/docker | tail -1
```

Expect: one new epoch per hour (`complete`, or `empty` if no trades), `requests24h` rising,
`recentErrors` mostly `upstream_*` at a low rate, no alert firing, disk flat. The daily digest
arrives at 09:00 Dubai with fees, credits, requests, nodes and errors for the last 24 h.

The reserve line: `source: "chain"` once the live adapter runs, `asOf` within the last hour,
`coverage` ≥ 1 and `short: false`. `source: "mock"` means the gateway is still on the mock adapter
(nothing is held, the alert is silent); `source: "unavailable"` means the last read of the pool
wallet failed (`reserve_read_failed` in `recentErrors`), usually the RPC. While the read fails the
`reserve_short` alert keeps the state it had: it does not report itself resolved. An hour with trades whose
epoch shows `feesUsd: 0` together with a `sweep_skipped` row in `recentErrors` (and a `failed_sweep`
alert) is a stale price feed (§11h).

Alert → playbook map: `missed_epoch`/`failed_sweep` → §11a (when its text says "no fresh price … left
unswept" it is a stale price feed: §11h; "sweep of … failed … left unswept in the vault" is one asset
whose transaction failed: §11a step 3, the Pons line); `upstream_error_rate` → §11b;
`fleet_drop` → §11c; `db_size`/`disk_low` → §11e (grow the disk or prune `heartbeats`/`requests_log`);
`reserve_short` → §11g. A `[mesh] WITHDRAWAL requested #…` message is not an alert that resolves: it is
a payout to make (§11j).

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
| Reserve: `totals.reserve` (`coverage`, `short`) | `coverage` ≥ 1 | `short: true` or `reserve_short` → §11g. Every starter grant and direct sale raises what is owed without adding to the pool |
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

1. What happened: `curl -s $G/admin/overview -H "$A" | jq '.recentErrors | map(select(.code=="epoch_failed" or .code=="sweep_skipped"))[:3]'`
   and `docker compose logs --since 2h gateway | grep -E 'epoch run failed|sweep left fees unswept'`.
   `epoch_failed`: the whole epoch did not run. `sweep_skipped`: the epoch ran and credited what it
   could; the asset named in the message is still in the vault (or the escrow) and the next epoch
   tries it again.
2. Nothing was written for that hour (`runEpoch` writes ledger + epoch row in one transaction), so
   holders simply have not been credited yet. Nothing to undo.
3. Fix the cause:
   - RPC/indexer down → wait or switch `*_RPC_URL`, `docker compose up -d`.
   - **[Solana]** signer out of SOL / **[EVM]** signer out of gas → fund it (`solana transfer` /
     `cast send`), then re-run.
   - **[Pons]** the swap reverted (`sweep_skipped`: "sweep of <asset> failed … left unswept in the
     vault"): no stablecoin or no route on the vault (set them, §6), or the pool could not meet the
     slippage floor (`slippageBps`, 1 % below the feed price). The epoch itself went through and
     credited any other asset; this one's fees stay in the vault and the next epoch retries them, so
     fix the cause and wait for the hour (or re-run).
   - A stale or unreadable price feed does **not** fail the sweep: the fees are left unswept and the
     epoch records nothing for them (§11h). Do not guess a price.
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
   cost per request rises from `$0.08/M` to the upstream price (list plus 6 %). No action needed for users.
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
   Refund abused spend with `/admin/starter-credit` if it was not the holder's fault (the refund is
   starter credit: spendable, not listable on the marketplace, and it lapses after 90 days).

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

### 11g. Reserve short (`reserve_short`), and moving money in and out of the credit pool

The alert means: at the last hourly reading the credit-pool wallet held less stablecoin than
`reserve.minCoverageBps` (10000 = 100 %) of the credits owed. The message carries the numbers, for
example `credit pool holds $60.00 against $100.00 of credits owed (60.0 %, min 100 %)`. It stays
silent while there is nothing to compare (`source` `mock` or `unavailable`). Background:
`docs/PRICING.md` §5.

1. Read the block: `curl -s $G/report | jq .totals.reserve`. `requiredUsd` is every spendable credit
   plus credit escrowed in open listings; `heldUsd` is the stablecoin in the pool wallet and nothing
   else (ETH there is `otherUsd`, not counted); the shortfall is `−surplusUsd`.
2. Find where the gap came from. The pool wallet receives the holder share of each sweep on its own
   and nothing more; the gateway reads it and never moves money into it. Credit from any other
   source raises `requiredUsd` with no stablecoin arriving:
   - direct sales (`jq .totals.directSales`): the buyer's payment reached the deposit receiver
     (`marketplace.deposits.receiver`) or the team off-chain, not the pool;
   - starter credits and admin grants (`curl -s $G/admin/starter -H "$A" | jq '.granted, .grantedUsd'`,
     and `starter-credit(s)` rows in `recentAdminActions`);
   - the usage share and the marketplace fee share that joined an hourly pool
     (`jq '.totals.usageShare.toHoldersUsd, .totals.marketplace'`);
   - stablecoin taken out of the pool beyond the surplus;
   - a `raw` sweep, which delivers the holder share as ETH (mainnet runs `swap`; expect this only in
     the testnet rehearsal).
3. Close it: send the shortfall in the settlement stablecoin to the `creditPool` address, direct-sale
   proceeds from the deposit receiver and the rest from the treasury.
4. Re-read without waiting for the hour: `POST /admin/run-epoch` runs the hourly chores even when
   the epoch itself answers `skipped`; `.housekeeping.reserveHeldUsd` is the new reading. The alert
   resolves at the next check after a covered reading.

Two standing duties, alert or not:

- **Direct-sale proceeds go to the pool.** A direct purchase mints credit against the buyer's prepaid
  balance; the stablecoin behind that balance sits at the deposit receiver (or wherever the team took
  the payment). Move it to the credit pool. `totals.directSales.soldUsd` is the running total that
  must have been moved; reconcile it daily.
- **Only the surplus leaves the pool.** `surplusUsd` is what the pool holds beyond the credits owed:
  the backing of credit that has been spent or has lapsed. That amount, and no more, may be moved
  from the pool to the treasury, and only when `source` is `chain` and `asOf` is recent. Check that
  the next reading still shows `coverage` ≥ 1.

### 11h. Price feed stale or down

What it looks like: the epoch does not fail, it comes up short. `PonsEvmAdapter` takes ETH/USD from
the Chainlink feed in `priceFeed` only; an answer older than an hour (`priceMaxAgeSec`, 3600 s) or a
failed read gives no price, and the sweep leaves ETH fees where they are instead of minting credits
against a guess. The hour's epoch records only what could be priced (usually `feesUsd: 0`, status
`empty`) and there is no `epoch_failed` row. The chores that run after the epoch
(`jobs/housekeeping.ts`) read the adapter's `lastSweep.unswept` and write one `errors_log` row with
code `sweep_skipped` per asset left behind; the `failed_sweep` alert fires on it, the row shows under
recent errors in `/admin/overview`, and `POST /admin/run-epoch` returns the text in
`.housekeeping.sweepWarnings`. The fees keep accumulating in the Pons escrow (or in the vault if an
earlier `pull()` claimed them). Stablecoin fees are swept as usual.

Nothing is lost. The first epoch after the feed is fresh again sweeps the whole balance and mints
credits for it to the holders of that hour, so the fees of the stale hours reach whoever holds then,
not whoever held during them. Say so in the channel if it lasted more than an hour or two.

1. Confirm: the escrow balance is growing while epochs show no fees
   (`curl -s -X POST $G/admin/chain/check -H "$A" -H "$J" -d '{}' | jq -r '.items[] | select(.check=="escrow.balance") | .detail'`),
   and the feed is old:
   `cast call <PRICE_FEED> "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $MESH_EVM_RPC_URL`
   (fourth value is `updatedAt`, unix seconds).
2. If the RPC is the problem (the read fails), fix `MESH_EVM_RPC_URL` and restart.
3. If the feed itself has stopped, point `priceFeed` at a live ETH/USD aggregator in Admin → Token and
   restart. `fixedEthUsd` / `MESH_FIXED_ETH_USD` is not a way out: it is used only when no feed is
   configured at all, and it exists for the testnet rehearsal.
4. Nothing to replay. The empty epochs are recorded as they were; the fees arrive with a later epoch.

### 11i. Credit expiry

Every credit lapses `creditExpiry.days` (90) days after it landed, oldest spent first
(`docs/PRICING.md` §6). The sweep runs after every epoch and writes one `expiry` row per wallet that
had something to lapse; the request path, `GET /me`, `GET /me/market` and `POST /market/listings`
lapse a single wallet on the spot.

- What ran: the `housekeeping` log line each hour (`expiredWallets`, `expiredUsd`), `.housekeeping`
  in the `POST /admin/run-epoch` response, and `curl -s $G/report | jq .totals.creditExpiry`.
- First run after upgrading to this build: the rule applies to credit already in the ledger, so
  anything that landed more than 90 days ago lapses in the first hourly sweep. Check
  `sqlite3 mesh.db "SELECT MIN(created_at) FROM credits_ledger WHERE delta_usd_micros > 0;"` on a
  backup copy before the deploy if the database is that old.
- "My credits are gone": the wallet's `GET /me` ledger shows the `expiry` row (ref
  `expiry:<cutoff timestamp>`), and `expiry.next` shows what lapses next. There is no un-expire. A
  goodwill grant with `/admin/starter-credit` is starter credit with a fresh 90 days.
- Lapsed credit lowers `requiredUsd`, so its backing appears as reserve surplus (§11g).
- Switching it off is `creditExpiry.enabled: false` and a rebuild; credit that already lapsed stays
  lapsed.

### 11j. Paying a withdrawal

Withdrawals of prepaid balances are paid by hand. You hear about one three ways: a
`[mesh] WITHDRAWAL requested #<id>: $<amount> to <wallet>` message on the ops channel the moment it is
requested, the `withdrawals:` line of the daily digest (how many are waiting, the total, the age of
the oldest), and the **Withdrawals** panel at the top of `/admin`. The message only reaches a phone if
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set (§3); otherwise it is a `WARN … ALERT` line in
`docker compose logs gateway` and the panel says so.

1. Open `/admin` → Withdrawals. The queue is oldest first; each row has the wallet, the amount and how
   long it has waited (red after 24 hours). Same data:
   `curl -s $G/admin/market -H "$A" | jq '.withdrawals'`.
2. The amount has already left the user's prepaid balance. Send that amount of USDG to the
   wallet shown, from the wallet that receives deposits (`marketplace.deposits.receiver`, the
   treasury multisig as configured). Check the
   address against the row, not against a chat message.
3. Paste the transaction hash into the row and press **Mark paid**
   (`curl -s -X POST $G/admin/market/withdrawals/<id>/paid -H "$A" -H "$J" -d '{"txRef":"0x…"}'`).
   It is audited as `withdrawal-paid`, and the user's market page shows the request as paid.
4. Marking paid moves no money and cannot be undone from the page. If a request must not be paid
   (fraud, a mistaken top-up), leave it pending and credit the balance back by hand with a note:
   `POST /admin/prepaid { wallet, amountUsd, note, ref: "refund:withdrawal:<id>" }`, then mark the
   request paid with a note saying so.

A request made while Telegram was unreachable is announced on the next alert check (every minute); one
that was paid before anybody was told is never announced.

### 11k. Node payouts

Node rewards are paid as AI credits by the gateway itself: every hour, after the epoch, rewards that
are at least `nodeRewards.payout.holdSeconds` (1 h) old are added to each operator's credit balance
(`docs/NODE_PROTOCOL.md` §7). There is nothing to send, no key and no on-chain step. Operators who want
money list the credits on the marketplace and withdraw USDG, which arrives as an ordinary withdrawal
(§11j).

- What ran: the `housekeeping` log line (`nodePayoutWallets`, `nodePayoutUsd`), `.housekeeping` in the
  `POST /admin/run-epoch` response, the `nodes:` line of the daily digest, and
  `curl -s $G/report | jq .totals.nodePayouts`.
- "I was not paid": `GET /me/nodes → payout.pendingUsd` is what is waiting. It waits when it is less
  than an hour old, below `minUsd` ($0.01), or the node is quarantined (clear it in `/admin` once the
  cause is understood; the next hourly run pays).
- A spot check that fails after the payout takes the credits back (`node_payout` row with a negative
  amount, ref `clawback:job:<id>`); the balance can go below zero if they were already spent or sold.
- The reserve: payouts for paid requests need no funding (the user's spend frees more than the node
  is paid). Payouts for free guest messages do: fund them into the credit pool with the rest of §11g.
- Switching it off is `nodeRewards.payout.enabled: false` and a rebuild; rewards then accrue unpaid
  and are all paid when it is switched back on.

---

## Appendix: endpoints an operator uses

| Purpose | Call |
| --- | --- |
| Liveness | `GET /health` |
| Alert state | `GET /health/alerts` (admin) |
| Everything on one screen | `GET /admin/overview` (admin) |
| Force / replay an epoch (also runs credit expiry and the reserve reading) | `POST /admin/run-epoch {epochStart?}` (admin) → `.housekeeping` |
| Credit reserve, lapsed credit, direct sales | `GET /report` → `totals.reserve`, `totals.creditExpiry`, `totals.directSales` |
| Chain config and on-chain check | `GET /admin/chain`, `POST /admin/chain/check` (admin) |
| Top up a prepaid balance (marketplace and direct purchases) | `POST /admin/prepaid {wallet, amountUsd, note, ref?}` (admin) |
| Credits for friends | `POST /admin/starter-credits {items:[{wallet, amountUsd}], note}` (admin) |
| Beta: mint invite codes | `POST /admin/invites {count, uses}` (admin) → `codes[]` |
| Beta: admit next waitlist batch | `POST /admin/waitlist/admit {n?}` (admin) → `entries[] {email|wallet, code}` |
| Beta: waitlist + counters | `GET /admin/waitlist?status=waiting|invited|all` (admin) |
| Beta: admit one wallet | `POST /admin/admit {wallet}` (admin) |
| Spot checks: clear / set a quarantine | `POST /admin/nodes/:id/quarantine/clear`, `POST /admin/nodes/:id/quarantine {reason}` (admin) |
| Public telemetry | `GET /stats`, `GET /epochs?limit=48`, `GET /nodes` |

### 11l. Looking at the site with a bigger network (test mode)

`MESH_SAMPLE_NODES=254` in `/opt/mesh/.env`, then restart the gateway. From then on a browser that is
signed in to the admin console (`/admin`, the `mesh_admin` cookie) sees 254 simulated Macs **added to
the real count** on the landing page, `/stats`, `/status`, the node page and the model picker, with the
requests, tokens, spend, savings, usage share and node rewards that many machines would produce.
Sign out of the admin console, or open a private window, and the same pages show the real figures.

What it is and is not (`apps/gateway/src/sample-data.ts`):

- **Only an operator sees it.** A request without admin credentials gets the real figures on the same
  URLs; an operator's answers are sent `cache-control: private, no-store` and never reach the shared cache.
- **Nothing is stored.** No node, request, ledger row or reward is written for a simulated Mac. They
  cannot serve a job, and the admin console's own pages (overview, withdrawals) stay real. The figures are
  a function of the number and the clock, so every page agrees and a restart changes nothing.
- **It stays on until you remove it.** The launch does not switch it off: on the live chain an
  operator's view still adds the simulated Macs to the real ones, and a visitor still gets the real
  figures. While it is on, your own signed-in view of the public pages is not what visitors see: use a
  private window (or sign out of `/admin`) to see the real numbers. Remove the line and restart to end it.
- **Fees and credits are not simulated.** Before the launch they come from the fee test feed (push test
  fees with `POST /admin/fake-fees`; the hourly epoch distributes them as usual); after it they are the
  real ones.

Check: `curl -s $G/health | jq .sampleNodes` (the configured number, 0 when off);
`curl -s $G/stats -H "$A" | jq '.sample, .nodesOnline'` (operator view) against `curl -s $G/stats | jq .nodesOnline`
(what a visitor gets). Simulated machines are listed with ids starting `sim_`.

## 12. Backups: verify monthly, restore when needed

Nightly at 03:15 UTC `deploy.sh backup` writes a WAL-safe copy to `/opt/mesh/backups/mesh-YYYYMMDD-HHMMSS.db.gz` and keeps the newest 14. A backup nobody has ever restored is a hope, not a backup, so:

**Drill (monthly, 1 minute, touches nothing live)**

```
ssh mesh@SERVER "/opt/mesh/deploy.sh verify-backup"
```

Unpacks the newest backup in a throwaway container and checks three things: the archive is intact, the file is exactly `page_count × page_size` bytes (a truncated file can still pass `integrity_check`), and `PRAGMA integrity_check` says `ok`. It then prints row counts for wallets, ledger, epochs, nodes, keys, jobs, requests and market listings plus the latest migration number, so you can see the backup is the one you think it is. Pass a path to check an older file.

**Restore (only when the live database is lost or corrupt)**

```
ssh mesh@SERVER "/opt/mesh/deploy.sh restore /opt/mesh/backups/mesh-YYYYMMDD-HHMMSS.db.gz"
```

Verifies the file first, asks for a typed `YES`, stops the gateway, keeps the current database as `backups/pre-restore-<stamp>.db.gz`, swaps the backup in, starts the gateway and waits for `/health`. Anything created after the backup (credits, keys, nodes, listings) is gone; the pre-restore copy lets you roll the restore itself back with the same command. Node agents re-register on their own when the gateway rejects their token (`mesh-node` logs "re-registering").

Off-site copy: `scp mesh@SERVER:/opt/mesh/backups/mesh-*.db.gz ~/mesh-backups/` from any machine with the deploy key; the files are small (the whole beta database is under 10 MB).
