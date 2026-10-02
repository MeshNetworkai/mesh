# Deploy the Mesh gateway on a fresh Ubuntu 24.04 VPS

Target: one small VPS (1 vCPU / 1 GB is enough for a friends launch), Docker Compose for the
gateway + SQLite volume, Caddy on the host for automatic HTTPS. ~15 minutes.

Replace `api.example.com` with your API hostname and point its DNS **A record** at the VPS IP
before step 5 (Caddy needs it to issue the certificate).

## 1. Base system

```sh
ssh root@YOUR_VPS_IP
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw
timedatectl set-timezone UTC

# firewall: ssh + http/https only (the gateway itself binds to 127.0.0.1)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# non-root deploy user
adduser --disabled-password --gecos "" mesh
usermod -aG sudo mesh
rsync -a ~/.ssh/ /home/mesh/.ssh/ && chown -R mesh:mesh /home/mesh/.ssh
```

## 2. Docker (official repo)

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker mesh
systemctl enable --now docker
```

Log out and back in as `mesh` so the docker group applies:

```sh
exit
ssh mesh@YOUR_VPS_IP
docker ps   # should print an empty table, no permission error
```

## 3. Clone and configure

```sh
git clone https://github.com/YOUR_ORG/mesh.git ~/mesh
cd ~/mesh
cp .env.example .env

# generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)"  >> .env
echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
```

Edit `.env` (`nano .env`) so these lines are set (later lines win over the defaults above them):

```ini
NODE_ENV=production
MESH_ADAPTER=mock                 # keep mock until the chain adapter is wired; fees come from /admin/fake-fees
OPENROUTER_API_KEY=sk-or-v1-...   # real upstream; unset = offline mock models only
AUTH_DOMAIN=api.example.com       # must equal the public hostname; it is in the message wallets sign
AUTH_URI=https://api.example.com
EPOCH_CRON=0 * * * *              # hourly distribution
V1_RATE_LIMIT=120
AUTH_RATE_LIMIT=20
LOG_LEVEL=info
```

`NODE_ENV=production` turns on geo-blocking for the countries in `config/tokenomics.json`
`geoBlock` (reads `CF-IPCountry` / `X-Country`; see step 5 for how Caddy sets it). Also review
`config/model-policy.json` (allow/deny lists) before launch; it is baked into the image, so
rebuild after editing.

## 4. Build and run

```sh
cd ~/mesh
docker compose up -d --build
docker compose logs -f gateway     # wait for "mesh gateway up", Ctrl-C
curl -s localhost:8787/health | jq
```

Expected: `{"ok":true,"db":"ok","upstream":"openrouter","upstreamMode":"live",...}`.

The SQLite file lives in the named volume `mesh-data` (`/data/mesh.db` inside the container)
and survives rebuilds. Back it up with:

```sh
docker compose exec gateway sh -c 'sqlite3 /data/mesh.db ".backup /data/backup.db"' 2>/dev/null \
  || docker run --rm -v mesh_mesh-data:/data -v "$PWD":/out alpine cp /data/mesh.db /out/mesh-backup-$(date +%F).db
```

## 5. Caddy for HTTPS

Caddy runs on the host (not in compose) so it owns :80/:443 and auto-renews Let's Encrypt.

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
api.example.com {
    encode zstd gzip

    # Geo header for the gateway's geo-block middleware.
    # Option A (recommended): put the domain behind Cloudflare (proxied / orange cloud). Cloudflare
    # adds CF-IPCountry itself; nothing to do here, but strip any client-sent copy first.
    # Option B (no Cloudflare): install the MaxMind geoip plugin
    #   (xcaddy build --with github.com/porech/caddy-maxmind-geolocation) and uncomment:
    # @geo {
    #     maxmind_geolocation {
    #         db_path "/usr/share/GeoIP/GeoLite2-Country.mmdb"
    #         allow_countries *
    #     }
    # }
    request_header -CF-IPCountry
    request_header -X-Country
    # request_header X-Country {geoip.country_code}

    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1          # stream SSE chunks immediately
        transport http {
            read_timeout 10m       # long generations
        }
    }

    # never expose admin endpoints publicly; call them from the box over ssh instead
    @admin path /admin/*
    respond @admin 404
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -s https://api.example.com/health | jq .ok     # true
curl -s https://api.example.com/stats | jq .token
```

If you use Cloudflare in front: set SSL mode to **Full (strict)**, and in the Caddyfile remove
the two `request_header -...` lines (Cloudflare's own `CF-IPCountry` must pass through).

## 6. Launch-day admin (from the box)

```sh
cd ~/mesh && set -a && . ./.env && set +a
A="x-admin-token: $ADMIN_TOKEN"; J='content-type: application/json'

# starter credits for friends (batched, audited)
curl -s -X POST localhost:8787/admin/starter-credits -H "$A" -H "$J" \
  -d '{"note":"launch","items":[{"wallet":"<wallet1>","amountUsd":2},{"wallet":"<wallet2>","amountUsd":2}]}' | jq

# operator overview: last 48 epochs, totals, top holders, nodes, recent errors
curl -s localhost:8787/admin/overview -H "$A" | jq '.totals, .recentErrors[:5]'

# force an epoch now (idempotent per hour)
curl -s -X POST localhost:8787/admin/run-epoch -H "$A" -H "$J" -d '{}' | jq
```

## 7. Updates

```sh
cd ~/mesh && git pull && docker compose up -d --build && docker compose logs --tail=50 gateway
```

Rollback: `git checkout <previous-sha> && docker compose up -d --build`. Migrations are additive
(`schema_migrations` table), so an older image runs fine against a newer DB.

## Checklist before you hand out keys

- [ ] `curl https://api.example.com/health` -> `ok: true`, `upstream: openrouter`
- [ ] `/admin/*` returns 404 through Caddy, works on `localhost:8787`
- [ ] `JWT_SECRET` and `ADMIN_TOKEN` are random, `.env` is `chmod 600`
- [ ] `AUTH_DOMAIN` equals the hostname users see in their wallet prompt
- [ ] A test wallet: `/auth/nonce` -> sign -> `/auth/verify` -> `POST /keys` -> one `/v1/chat/completions`
- [ ] `/stats` shows `series24h` moving after the first epoch
- [ ] OpenRouter key has a spend limit set on openrouter.ai
