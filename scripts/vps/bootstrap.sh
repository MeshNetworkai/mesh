#!/usr/bin/env bash
# Mesh VPS bootstrap: turns a fresh Ubuntu 24.04 box into the production host for the gateway + web app.
#
# Run ONCE from your Mac (root over ssh, script fed through stdin):
#   ssh root@80.78.27.94 'bash -s' -- --domain mesh.example.com < scripts/vps/bootstrap.sh
#
# Safe to re-run at any time (idempotent). Re-run with --domain after you buy the domain, or without
# it to keep the stored one. It never touches secrets that already exist in /opt/mesh/.env.
#
# Options:
#   --domain <name>   public domain (web at <name> + www.<name>, API at api.<name>). Optional at first:
#                     without it Caddy serves plain http://<ip> so /health works, and the first --domain
#                     re-run switches to HTTPS (Caddy issues the certificate once DNS resolves).
#   --cloudflare      the domain is proxied by Cloudflare (orange cloud): keep Cloudflare's CF-IPCountry
#                     header instead of stripping it. Off by default; stored for re-runs.
#   --no-cloudflare   turn the above off again.
#   --repo <url>      git clone URL (default git@github.com:MeshNetworkai/mesh.git).
#   --ip <ipv4>       public IPv4 (auto-detected when omitted).
#   -h, --help
#
# What it does: apt upgrade, UTC, ufw 22/80/443, fail2ban, unattended-upgrades, `mesh` user (docker group,
# root's authorized_keys), Docker CE + compose plugin, Caddy, read-only GitHub deploy key, /opt/mesh layout,
# /etc/caddy/Caddyfile, /opt/mesh/.env (secrets generated once), /opt/mesh/deploy.sh (what GitHub Actions
# runs), nightly SQLite backup cron. Everything after this is driven by .github/workflows/deploy.yml.

set -euo pipefail

# ----------------------------------------------------------------------------------------------------
# constants
# ----------------------------------------------------------------------------------------------------
MESH_USER="mesh"
MESH_HOME="/home/${MESH_USER}"
MESH_ROOT="/opt/mesh"
DEFAULT_REPO="git@github.com:MeshNetworkai/mesh.git"
GATEWAY_PORT="8787"
COMPOSE_PROJECT="mesh"

# ----------------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------------
log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ssh root@<ip> 'bash -s' -- [options] < scripts/vps/bootstrap.sh

  --domain <name>    public domain (web: <name>, www.<name>; API: api.<name>). Optional on the first run.
  --cloudflare       domain is proxied by Cloudflare (keep its CF-IPCountry header)
  --no-cloudflare    turn that off again
  --repo <url>       git clone URL (default git@github.com:MeshNetworkai/mesh.git)
  --ip <ipv4>        public IPv4 (auto-detected when omitted)
  -h, --help         this text

Idempotent: re-run any time; secrets in /opt/mesh/.env are never regenerated.
EOF
}

# Write a file only when its content changed; returns 0 when it was (re)written.
write_if_changed() { # path mode owner content-on-stdin
  local path="$1" mode="$2" owner="$3" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"; chmod "$mode" "$path"; chown "$owner" "$path"; return 1
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# Set KEY=value in an env file (replace the line if the key exists, append otherwise).
set_env_kv() { # file key value
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; }

detect_public_ip() {
  local ip=""
  ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [[ -n "$ip" ]] || ip="$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip"
}

# ----------------------------------------------------------------------------------------------------
# Caddyfile rendering (pure function: prints to stdout; also used by the repo's dry-run check)
# ----------------------------------------------------------------------------------------------------
render_caddyfile() { # domain|"" cloudflare(true|false) web_root gateway_port
  local domain="$1" cloudflare="$2" web_root="$3" port="$4"
  local geo_block
  if [[ "$cloudflare" == "true" ]]; then
    geo_block='	# Behind Cloudflare (orange cloud): Cloudflare sets CF-IPCountry itself, so it passes through.
	# Only strip X-Country (clients could spoof it).
	request_header -X-Country'
  else
    geo_block='	# Geo header for the gateway geo-block middleware. Strip anything a client sent; nothing is
	# trusted unless a proxy in front of Caddy (e.g. Cloudflare, --cloudflare) sets it.
	# Without Cloudflare you can build Caddy with the MaxMind plugin
	#   (xcaddy build --with github.com/porech/caddy-maxmind-geolocation) and uncomment:
	# @geo { maxmind_geolocation { db_path "/usr/share/GeoIP/GeoLite2-Country.mmdb" allow_countries * } }
	# request_header X-Country {geoip.country_code}
	request_header -CF-IPCountry
	request_header -X-Country'
  fi

  cat <<EOF
# Managed by scripts/vps/bootstrap.sh (re-run it to change the domain; manual edits get overwritten).
{
	admin off
	servers {
		trusted_proxies static private_ranges
	}
}

(mesh_security_headers) {
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
}

(mesh_api) {
	encode zstd gzip
${geo_block}

	# never expose admin endpoints publicly; call them from the box (curl localhost:${port}/admin/...)
	@admin path /admin /admin/*
	respond @admin 404

	# Deploys recreate the gateway container. Pooled keep-alive connections to the old container go stale
	# and Go only retries GETs on a dead pooled connection, so POSTs got a bare 502 (no CORS headers → the
	# browser shows a CORS error) for up to two minutes after every deploy. No pooling to a localhost
	# upstream (a new TCP connection per request costs nothing here), and dial failures during the swap
	# itself are retried for up to 15 s instead of failing the request.
	reverse_proxy 127.0.0.1:${port} {
		lb_try_duration 15s
		lb_try_interval 250ms
		flush_interval -1 # stream SSE chunks immediately
		transport http {
			read_timeout 10m # long generations
			keepalive off
		}
	}
}

(mesh_web) {
	encode zstd gzip
	import mesh_security_headers
	root * ${web_root}

	# latest.json / installer must never be cached by browsers (mesh-node update reads them)
	@nocache path /downloads/* /install-node.sh /mesh-node.js
	header @nocache Cache-Control "no-cache"

	# hashed Vite assets are immutable
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"

	# SPA: unknown paths fall back to index.html
	try_files {path} /index.html
	file_server
}
EOF

  if [[ -n "$domain" ]]; then
	cat <<EOF

# ---- API --------------------------------------------------------------------------------------------
api.${domain} {
	import mesh_api
}

# ---- Web app ----------------------------------------------------------------------------------------
www.${domain} {
	redir https://${domain}{uri} permanent
}

${domain} {
	import mesh_web
}
EOF
  else
	cat <<EOF

# ---- No domain yet: plain HTTP on the IP. Re-run bootstrap.sh --domain <name> to switch to HTTPS. ----
:80 {
	# the gateway's public read-only endpoints, so http://<ip>/health works before DNS exists
	@api path /health /health/* /stats /install/*
	handle @api {
		import mesh_api
	}
	handle {
		import mesh_web
	}
}
EOF
  fi
}

# ----------------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------------
main() {
  local DOMAIN="" REPO="" PUBLIC_IP="" CLOUDFLARE="" SET_DOMAIN=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)       DOMAIN="${2:-}"; SET_DOMAIN=true; shift 2 ;;
      --domain=*)     DOMAIN="${1#*=}"; SET_DOMAIN=true; shift ;;
      --repo)         REPO="${2:-}"; shift 2 ;;
      --repo=*)       REPO="${1#*=}"; shift ;;
      --ip)           PUBLIC_IP="${2:-}"; shift 2 ;;
      --ip=*)         PUBLIC_IP="${1#*=}"; shift ;;
      --cloudflare)   CLOUDFLARE=true; shift ;;
      --no-cloudflare) CLOUDFLARE=false; shift ;;
      -h|--help)      usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
  done

  [[ "$(id -u)" -eq 0 ]] || die "run as root (ssh root@<ip> 'bash -s' -- --domain <name> < bootstrap.sh)"
  [[ -r /etc/os-release ]] && . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "this script is written for Ubuntu 24.04; detected ${PRETTY_NAME:-unknown}"

  export DEBIAN_FRONTEND=noninteractive
  umask 022

  # ---- settings file: remembers domain/repo/ip/cloudflare between runs ----------------------------
  mkdir -p "$MESH_ROOT"
  local SETTINGS="${MESH_ROOT}/deploy.env"
  if [[ -f "$SETTINGS" ]]; then
    # shellcheck disable=SC1090
    . "$SETTINGS"
    [[ "$SET_DOMAIN" == true ]] || DOMAIN="${MESH_DOMAIN:-}"
    [[ -n "$REPO" ]] || REPO="${MESH_REPO:-}"
    [[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="${MESH_PUBLIC_IP:-}"
    [[ -n "$CLOUDFLARE" ]] || CLOUDFLARE="${MESH_CLOUDFLARE:-false}"
    SOCIAL_X="${SOCIAL_X:-}"; SOCIAL_TELEGRAM="${SOCIAL_TELEGRAM:-}"; HERO_3D="${HERO_3D:-1}"
  fi
  REPO="${REPO:-$DEFAULT_REPO}"
  CLOUDFLARE="${CLOUDFLARE:-false}"
  DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"${DOMAIN}")"
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#www.}"; DOMAIN="${DOMAIN%/}"
  if [[ -n "$DOMAIN" ]] && ! valid_domain "$DOMAIN"; then die "'$DOMAIN' does not look like a domain (expected e.g. mesh.example.com)"; fi

  log "Mesh VPS bootstrap"
  echo "  domain:      ${DOMAIN:-<none yet: HTTP on the IP>}"
  echo "  repo:        ${REPO}"
  echo "  cloudflare:  ${CLOUDFLARE}"

  # ---- 1. base system ------------------------------------------------------------------------------
  log "1/9 Base packages + upgrade"
  apt-get update -q
  apt-get -y -q -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade
  apt-get install -y -q ca-certificates curl git gnupg ufw fail2ban python3-systemd unattended-upgrades \
    rsync jq openssl sqlite3 debian-keyring debian-archive-keyring apt-transport-https
  timedatectl set-timezone UTC
  ok "packages installed, timezone UTC"

  if [[ -z "$PUBLIC_IP" ]]; then PUBLIC_IP="$(detect_public_ip)"; fi
  [[ -n "$PUBLIC_IP" ]] || die "could not detect the public IPv4; pass --ip <ipv4>"
  echo "  public ip:   ${PUBLIC_IP}"

  # ---- 2. firewall / fail2ban / unattended upgrades ------------------------------------------------
  log "2/9 Firewall, fail2ban, unattended-upgrades"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "ufw: 22, 80, 443 open (gateway :${GATEWAY_PORT} stays on localhost)"

  write_if_changed /etc/fail2ban/jail.local 0644 root:root <<'EOF' || true
# Managed by scripts/vps/bootstrap.sh
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
EOF
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
  ok "fail2ban: sshd jail active"

  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF
  write_if_changed /etc/apt/apt.conf.d/52mesh-unattended 0644 root:root <<'EOF' || true
// Managed by scripts/vps/bootstrap.sh: security updates only, no automatic reboot.
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  ok "unattended-upgrades: security updates daily"

  # ---- 3. mesh user -------------------------------------------------------------------------------
  log "3/9 Deploy user '${MESH_USER}'"
  if ! id -u "$MESH_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "Mesh deploy" "$MESH_USER" >/dev/null
    ok "user created"
  else
    ok "user exists"
  fi
  install -d -m 700 -o "$MESH_USER" -g "$MESH_USER" "${MESH_HOME}/.ssh"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    # merge root's keys into mesh's authorized_keys (keeps any key already there)
    touch "${MESH_HOME}/.ssh/authorized_keys"
    cat /root/.ssh/authorized_keys "${MESH_HOME}/.ssh/authorized_keys" | grep -v '^\s*$' | sort -u >"${MESH_HOME}/.ssh/authorized_keys.tmp"
    mv "${MESH_HOME}/.ssh/authorized_keys.tmp" "${MESH_HOME}/.ssh/authorized_keys"
    chmod 600 "${MESH_HOME}/.ssh/authorized_keys"
    chown "$MESH_USER:$MESH_USER" "${MESH_HOME}/.ssh/authorized_keys"
    ok "root's ssh keys copied to ${MESH_USER} (the same key you ssh with works for GitHub Actions)"
  else
    warn "/root/.ssh/authorized_keys not found; add a key to ${MESH_HOME}/.ssh/authorized_keys yourself"
  fi

  # ---- 4. docker ----------------------------------------------------------------------------------
  log "4/9 Docker CE + compose plugin"
  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-noble} stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ok "docker installed"
  else
    ok "docker already installed ($(docker --version))"
  fi
  docker compose version >/dev/null 2>&1 || apt-get install -y -q docker-compose-plugin
  write_if_changed /etc/docker/daemon.json 0644 root:root <<'EOF' && systemctl restart docker || true
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
  systemctl enable --now docker >/dev/null
  usermod -aG docker "$MESH_USER"
  ok "docker running, ${MESH_USER} in the docker group"

  # ---- 5. caddy -----------------------------------------------------------------------------------
  log "5/9 Caddy"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
    ok "caddy installed"
  else
    ok "caddy already installed ($(caddy version | head -1))"
  fi

  # ---- 6. GitHub deploy key + /opt/mesh layout ----------------------------------------------------
  log "6/9 GitHub deploy key + ${MESH_ROOT} layout"
  local DEPLOY_KEY="${MESH_HOME}/.ssh/github_deploy"
  local NEW_KEY=false
  if [[ ! -f "$DEPLOY_KEY" ]]; then
    sudo -u "$MESH_USER" ssh-keygen -t ed25519 -N "" -C "mesh-vps-deploy@${PUBLIC_IP}" -f "$DEPLOY_KEY" >/dev/null
    NEW_KEY=true
    ok "generated ${DEPLOY_KEY}"
  else
    ok "deploy key exists (${DEPLOY_KEY})"
  fi
  write_if_changed "${MESH_HOME}/.ssh/config" 0600 "$MESH_USER:$MESH_USER" <<EOF || true
# Managed by scripts/vps/bootstrap.sh
Host github.com
    HostName github.com
    User git
    IdentityFile ${DEPLOY_KEY}
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF
  # pre-trust github.com so the first clone never prompts
  if ! sudo -u "$MESH_USER" ssh-keygen -F github.com -f "${MESH_HOME}/.ssh/known_hosts" >/dev/null 2>&1; then
    ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >>"${MESH_HOME}/.ssh/known_hosts" || warn "ssh-keyscan github.com failed (no network?); accept-new will handle it on first clone"
    chown "$MESH_USER:$MESH_USER" "${MESH_HOME}/.ssh/known_hosts"; chmod 600 "${MESH_HOME}/.ssh/known_hosts"
  fi

  install -d -m 755 -o "$MESH_USER" -g "$MESH_USER" "$MESH_ROOT" "${MESH_ROOT}/web" "${MESH_ROOT}/web/downloads" "${MESH_ROOT}/cache" "${MESH_ROOT}/cache/pnpm-store"
  install -d -m 750 -o "$MESH_USER" -g "$MESH_USER" "${MESH_ROOT}/backups"
  # a placeholder page until the first deploy copies the real build in
  if [[ ! -f "${MESH_ROOT}/web/index.html" ]]; then
    cat >"${MESH_ROOT}/web/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Mesh</title>
<body style="font-family:system-ui;margin:4rem auto;max-width:40rem;color:#222"><h1>Mesh</h1>
<p>The server is up. The web app has not been deployed yet: run the <b>Deploy</b> workflow on GitHub.</p></body>
EOF
    chown "$MESH_USER:$MESH_USER" "${MESH_ROOT}/web/index.html"
  fi

  # non-secret settings read by deploy.sh (and by re-runs of this script)
  write_if_changed "$SETTINGS" 0644 "$MESH_USER:$MESH_USER" <<EOF || true
# Managed by scripts/vps/bootstrap.sh (re-run it with --domain/--repo/--cloudflare to change these).
MESH_DOMAIN=${DOMAIN}
MESH_REPO=${REPO}
MESH_BRANCH=main
MESH_PUBLIC_IP=${PUBLIC_IP}
MESH_CLOUDFLARE=${CLOUDFLARE}
MESH_GATEWAY_PORT=${GATEWAY_PORT}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT}
# Web build options (edit, then: deploy.sh deploy). Footer social links are hidden while empty.
SOCIAL_X=${SOCIAL_X:-}
SOCIAL_TELEGRAM=${SOCIAL_TELEGRAM:-}
HERO_3D=${HERO_3D:-1}
EOF
  ok "settings written to ${SETTINGS}"

  # ---- 7. Caddyfile -------------------------------------------------------------------------------
  log "7/9 Caddyfile"
  local caddy_tmp
  caddy_tmp="$(mktemp)"
  render_caddyfile "$DOMAIN" "$CLOUDFLARE" "${MESH_ROOT}/web" "$GATEWAY_PORT" >"$caddy_tmp"
  caddy validate --config "$caddy_tmp" --adapter caddyfile >/dev/null || { cat "$caddy_tmp"; rm -f "$caddy_tmp"; die "generated Caddyfile failed validation"; }
  if write_if_changed /etc/caddy/Caddyfile 0644 root:root <"$caddy_tmp"; then
    ok "/etc/caddy/Caddyfile updated"
  else
    ok "/etc/caddy/Caddyfile unchanged"
  fi
  rm -f "$caddy_tmp"
  systemctl enable --now caddy >/dev/null
  # The Caddyfile turns the admin API off, which `systemctl reload caddy` needs, so a reload can never
  # succeed here: restart (a second of downtime on config changes only; in-flight SSE streams drop).
  systemctl restart caddy
  systemctl is-active --quiet caddy || { journalctl -u caddy -n 30 --no-pager; die "caddy failed to start — see the log above"; }
  if [[ -n "$DOMAIN" ]]; then
    ok "caddy serving https://${DOMAIN}, https://api.${DOMAIN} (certificate is issued automatically once DNS points here)"
  else
    ok "caddy serving http://${PUBLIC_IP} (no domain yet)"
  fi

  # ---- 8. /opt/mesh/.env ---------------------------------------------------------------------------
  log "8/9 Gateway environment (${MESH_ROOT}/.env)"
  local ENV_FILE="${MESH_ROOT}/.env" NEW_ENV=false ADMIN_TOKEN_VALUE=""
  local AUTH_DOMAIN AUTH_URI CORS_ORIGINS PUBLIC_WEB_URL
  if [[ -n "$DOMAIN" ]]; then
    AUTH_DOMAIN="api.${DOMAIN}"; AUTH_URI="https://api.${DOMAIN}"
    CORS_ORIGINS="https://${DOMAIN},https://www.${DOMAIN}"; PUBLIC_WEB_URL="https://${DOMAIN}"
  else
    AUTH_DOMAIN="${PUBLIC_IP}"; AUTH_URI="http://${PUBLIC_IP}"
    CORS_ORIGINS="http://${PUBLIC_IP}"; PUBLIC_WEB_URL="http://${PUBLIC_IP}"
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    NEW_ENV=true
    ADMIN_TOKEN_VALUE="$(openssl rand -hex 24)"
    (
      umask 077
      cat >"$ENV_FILE" <<EOF
# Mesh gateway production environment. Generated once by scripts/vps/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Secrets below are NEVER regenerated by re-runs; the domain-derived lines are updated by --domain re-runs.
# Reference for every variable: apps/gateway/src/env.ts and .env.example in the repo.
NODE_ENV=production
HOST=0.0.0.0
PORT=${GATEWAY_PORT}
MESH_DB_PATH=/data/mesh.db
MESH_ADAPTER=mock
LOG_LEVEL=info

# ---- secrets (generated with openssl rand) ----
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=${ADMIN_TOKEN_VALUE}
KEY_PEPPER=$(openssl rand -hex 32)
# JWT_SECRET_PREVIOUS=   # set during a JWT_SECRET rotation, remove after 7 days

# ---- domain-derived (managed by bootstrap.sh --domain) ----
AUTH_DOMAIN=${AUTH_DOMAIN}
AUTH_URI=${AUTH_URI}
CORS_ORIGINS=${CORS_ORIGINS}
PUBLIC_WEB_URL=${PUBLIC_WEB_URL}

# ---- upstream: leave unset for the offline mock models; set a real key to serve OpenRouter ----
# OPENROUTER_API_KEY=sk-or-v1-...
UPSTREAM_TIMEOUT_MS=60000

# ---- schedule + limits ----
EPOCH_CRON=0 * * * *
V1_RATE_LIMIT=120
AUTH_RATE_LIMIT=20
NODE_REGISTER_RATE_LIMIT=10
STATS_CACHE_MS=10000

# ---- alerts (off until Telegram is configured; see apps/gateway/src/alerts.ts) ----
ALERTS_ENABLED=false
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=

# ---- node distribution: the deploy copies the release latest.json to /opt/mesh/web/downloads/latest.json ----
# UPDATE_LATEST_URL=${PUBLIC_WEB_URL}/downloads/latest.json
EOF
    )
    ok "generated .env with fresh JWT_SECRET / ADMIN_TOKEN / KEY_PEPPER"
  else
    set_env_kv "$ENV_FILE" AUTH_DOMAIN "$AUTH_DOMAIN"
    set_env_kv "$ENV_FILE" AUTH_URI "$AUTH_URI"
    set_env_kv "$ENV_FILE" CORS_ORIGINS "$CORS_ORIGINS"
    set_env_kv "$ENV_FILE" PUBLIC_WEB_URL "$PUBLIC_WEB_URL"
    ok ".env exists: secrets kept, domain lines updated (AUTH_DOMAIN=${AUTH_DOMAIN})"
  fi
  chown "$MESH_USER:$MESH_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

  # ---- 9. deploy.sh + backup cron ------------------------------------------------------------------
  log "9/9 ${MESH_ROOT}/deploy.sh + nightly backup"
  write_if_changed "${MESH_ROOT}/deploy.sh" 0755 "$MESH_USER:$MESH_USER" <<'DEPLOY_EOF' || true
#!/usr/bin/env bash
# Mesh deploy script. Installed by scripts/vps/bootstrap.sh; run as the `mesh` user (GitHub Actions does
# this over ssh on every push to main; you can also run it by hand: /opt/mesh/deploy.sh <command>).
#
#   deploy    pull main, rebuild + restart the gateway, build the web app, publish it, health-check (default)
#   restart   restart the gateway container without rebuilding
#   logs      last 200 lines of the gateway log
#   health    curl the gateway /health (exit 1 when not ok)
#   backup    snapshot the SQLite database to /opt/mesh/backups now (keeps the newest 14)
#   status    containers, disk, versions
set -euo pipefail

ROOT=/opt/mesh
SRC="$ROOT/src"
WEB="$ROOT/web"
ENV_FILE="$ROOT/.env"
SETTINGS="$ROOT/deploy.env"
BACKUPS="$ROOT/backups"
KEEP_BACKUPS=14
COMPOSE_FILE="$SRC/docker-compose.yml"

# shellcheck disable=SC1090
. "$SETTINGS"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mesh}"
DOMAIN="${MESH_DOMAIN:-}"
REPO="${MESH_REPO:?MESH_REPO missing in $SETTINGS}"
BRANCH="${MESH_BRANCH:-main}"
PORT="${MESH_GATEWAY_PORT:-8787}"
PUBLIC_IP="${MESH_PUBLIC_IP:-}"
VOLUME="${COMPOSE_PROJECT_NAME}_mesh-data"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

if [[ -n "$DOMAIN" ]]; then
  API_URL="https://api.${DOMAIN}"; WEB_URL="https://${DOMAIN}"
else
  API_URL="http://${PUBLIC_IP}"; WEB_URL="http://${PUBLIC_IP}"
fi

cmd_health() {
  local out
  if out="$(curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/health" 2>&1)"; then
    echo "$out" | jq . 2>/dev/null || echo "$out"
    if echo "$out" | jq -e '.ok == true' >/dev/null 2>&1; then ok "gateway healthy"; return 0; fi
    die "gateway /health returned ok != true"
  fi
  echo "$out"
  die "gateway /health unreachable on 127.0.0.1:${PORT}"
}

wait_healthy() {
  local _i
  for _i in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

sync_source() {
  log "Source: ${REPO} (${BRANCH})"
  if [[ ! -d "$SRC/.git" ]]; then
    git clone --branch "$BRANCH" "$REPO" "$SRC"
    ok "cloned"
  else
    git -C "$SRC" fetch --prune origin "$BRANCH"
    git -C "$SRC" reset --hard "origin/${BRANCH}"
    ok "reset to origin/${BRANCH}"
  fi
  git -C "$SRC" log -1 --format='  %h %s (%ci)'
  # compose `env_file: .env` resolves relative to the compose file; keep both paths pointing at the one file
  ln -sfn "$ENV_FILE" "$SRC/.env"
}

build_gateway() {
  log "Gateway: docker compose up -d --build"
  compose up -d --build --remove-orphans gateway
  if wait_healthy; then ok "gateway up"; else compose logs --tail=100 gateway; die "gateway did not become healthy"; fi
}

build_web() {
  log "Web app: build in node:20-alpine (VITE_API_URL=${API_URL})"
  # Runs as the mesh uid so node_modules / dist in the checkout stay ours. corepack is invoked directly
  # (no `corepack enable`, which needs root) and resolves pnpm from package.json "packageManager".
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack -e CI=true \
    -e npm_config_store_dir=/pnpm-store \
    -e VITE_API_URL="$API_URL" -e VITE_PUBLIC_API_URL="$API_URL" \
    -e VITE_SOCIAL_X="${SOCIAL_X:-}" -e VITE_SOCIAL_TELEGRAM="${SOCIAL_TELEGRAM:-}" -e VITE_HERO_3D="${HERO_3D:-1}" \
    -v "$SRC:/app" -v "$ROOT/cache/pnpm-store:/pnpm-store" -w /app \
    node:20-alpine sh -c '
      set -e
      corepack pnpm install --frozen-lockfile --filter web... --filter @mesh/node-agent... --filter @mesh/config...
      corepack pnpm --filter @mesh/config build
      corepack pnpm --filter @mesh/node-agent build
      corepack pnpm --filter web build
    '
  [[ -f "$SRC/apps/web/dist/index.html" ]] || die "web build produced no dist/index.html"
  rsync -a --delete --chmod=D755,F644 --exclude 'downloads/latest.json' "$SRC/apps/web/dist/" "$WEB/"
  mkdir -p "$WEB/downloads"
  ok "published to ${WEB} (${WEB_URL})"
}

fetch_latest_json() {
  log "latest.json from the newest GitHub release (non-fatal)"
  local url="https://github.com/MeshNetworkai/mesh/releases/latest/download/latest.json" tmp
  tmp="$(mktemp)"
  if curl -fsSL --max-time 20 "$url" -o "$tmp" && jq -e '.version and .bundleUrl' "$tmp" >/dev/null 2>&1; then
    install -m 644 "$tmp" "$WEB/downloads/latest.json"
    ok "downloads/latest.json = v$(jq -r .version "$WEB/downloads/latest.json")"
  elif [[ -f "$WEB/downloads/latest.json" ]]; then
    warn "release not reachable; kept the existing downloads/latest.json"
  elif [[ -f "$SRC/apps/web/dist/downloads/latest.json" ]]; then
    install -m 644 "$SRC/apps/web/dist/downloads/latest.json" "$WEB/downloads/latest.json"
    warn "release not reachable; using the sample latest.json from the web build"
  else
    warn "release not reachable and no latest.json yet"
  fi
  rm -f "$tmp"
}

cmd_backup() {
  log "SQLite backup -> ${BACKUPS}"
  mkdir -p "$BACKUPS"
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume ${VOLUME} does not exist yet (deploy first)"
  local stamp out
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  out="mesh-${stamp}.db"
  # Online, consistent copy via sqlite's .backup (WAL-safe); falls back to a plain cp.
  if ! docker run --rm -v "${VOLUME}:/data:ro" -v "$BACKUPS:/out" alpine:3 sh -c \
      "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /data/mesh.db \".backup /out/${out}\""; then
    warn "sqlite3 backup failed; copying the raw file"
    docker run --rm -v "${VOLUME}:/data:ro" -v "$BACKUPS:/out" alpine:3 sh -c "cp /data/mesh.db /out/${out}"
  fi
  gzip -f "$BACKUPS/$out"
  ok "wrote ${out}.gz ($(du -h "$BACKUPS/$out.gz" | cut -f1))"
  # prune: keep the newest $KEEP_BACKUPS
  ls -1t "$BACKUPS"/mesh-*.db.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f --
  echo "  kept $(ls -1 "$BACKUPS"/mesh-*.db.gz 2>/dev/null | wc -l) backup(s)"
}

# verify-backup <file.db.gz>: integrity check + key row counts, in a throwaway container. Never touches the live volume.
cmd_verify_backup() {
  local f="${1:-}"
  [[ -n "$f" ]] || f="$(ls -1t "$BACKUPS"/mesh-*.db.gz 2>/dev/null | head -1)"
  [[ -f "$f" ]] || die "no backup file (pass a path, or run: deploy.sh backup)"
  log "Verifying $(basename "$f") in a throwaway container"
  # Three checks, any failure aborts: the archive unpacks, the file is exactly page_count × page_size bytes
  # (a truncated file can still answer integrity_check with "ok"), integrity_check says ok, and every core
  # table answers a COUNT. Row counts are printed so you can eyeball that the backup is the one you think.
  docker run --rm -v "$(dirname "$(readlink -f "$f")"):/in:ro" alpine:3 sh -c "
    set -e
    apk add --no-cache sqlite >/dev/null 2>&1
    gzip -t /in/$(basename "$f")
    gunzip -c /in/$(basename "$f") > /tmp/check.db
    size=\$(wc -c < /tmp/check.db)
    want=\$(( \$(sqlite3 /tmp/check.db 'PRAGMA page_count;') * \$(sqlite3 /tmp/check.db 'PRAGMA page_size;') ))
    [ \"\$size\" -eq \"\$want\" ] || { echo \"  size mismatch: file \$size bytes, header says \$want (truncated?)\"; exit 3; }
    ic=\$(sqlite3 /tmp/check.db 'PRAGMA integrity_check;')
    echo \"  integrity: \$ic\"
    [ \"\$ic\" = ok ] || exit 3
    for t in wallets credits_ledger epochs nodes api_keys jobs requests_log market_listings schema_migrations; do
      n=\$(sqlite3 /tmp/check.db \"SELECT COUNT(*) FROM \$t;\")
      printf '  %-18s %s\\n' \"\$t\" \"\$n\"
    done
    echo \"  latest migration: \$(sqlite3 /tmp/check.db 'SELECT MAX(id) FROM schema_migrations;' 2>/dev/null || echo '?')\"
  " || die "backup failed verification"
  ok "backup unpacks, is complete and passes integrity_check"
}

# restore <file.db.gz>: stop the gateway, keep the current database beside the backups as a safety copy,
# put the backup in its place, start again and wait for /health. Asks for a typed YES.
cmd_restore() {
  local f="${1:-}"
  [[ -f "$f" ]] || die "usage: deploy.sh restore /opt/mesh/backups/mesh-YYYYMMDD-HHMMSS.db.gz"
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume ${VOLUME} does not exist yet (deploy first)"
  cmd_verify_backup "$f"
  echo
  warn "This replaces the LIVE database with $(basename "$f"). Credits, keys and nodes registered after that backup are lost."
  printf '  type YES to continue: '
  local answer; read -r answer
  [[ "$answer" == "YES" ]] || die "aborted"
  log "Stopping the gateway"
  compose stop gateway
  local stamp; stamp="$(date -u +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUPS"
  log "Safety copy of the current database -> ${BACKUPS}/pre-restore-${stamp}.db.gz"
  docker run --rm -v "${VOLUME}:/data:ro" -v "$BACKUPS:/out" alpine:3 sh -c "cp /data/mesh.db /out/pre-restore-${stamp}.db && gzip -f /out/pre-restore-${stamp}.db"
  log "Restoring"
  docker run --rm -v "${VOLUME}:/data" -v "$(dirname "$(readlink -f "$f")"):/in:ro" alpine:3 sh -c \
    "rm -f /data/mesh.db /data/mesh.db-wal /data/mesh.db-shm && gunzip -c /in/$(basename "$f") > /data/mesh.db && chown 1000:1000 /data/mesh.db"
  log "Starting the gateway"
  compose start gateway
  wait_healthy || die "gateway not healthy after restore — roll back with: deploy.sh restore ${BACKUPS}/pre-restore-${stamp}.db.gz"
  ok "restored $(basename "$f"); the previous database is at ${BACKUPS}/pre-restore-${stamp}.db.gz"
}

cmd_status() {
  log "Status"
  compose ps 2>/dev/null || true
  echo; df -h / | tail -1 | awk '{print "  disk: " $3 " used of " $2 " (" $5 ")"}'
  [[ -d "$SRC/.git" ]] && git -C "$SRC" log -1 --format='  source: %h %s (%ci)'
  echo "  web:    ${WEB_URL}"
  echo "  api:    ${API_URL}"
  ls -1t "$BACKUPS"/mesh-*.db.gz 2>/dev/null | head -1 | sed 's|^|  latest backup: |' || true
}

cmd_deploy() {
  local started
  started=$(date +%s)
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE missing (run bootstrap.sh)"
  sync_source
  if [[ -d "$SRC/.git" ]] && docker volume inspect "$VOLUME" >/dev/null 2>&1; then cmd_backup || warn "pre-deploy backup failed (continuing)"; fi
  build_gateway
  build_web
  fetch_latest_json
  log "Health"
  cmd_health
  docker image prune -f >/dev/null 2>&1 || true
  log "Deployed in $(( $(date +%s) - started ))s"
  echo "  commit:  $(git -C "$SRC" rev-parse --short HEAD)"
  echo "  web:     ${WEB_URL}"
  echo "  api:     ${API_URL}/health"
  if [[ -z "$DOMAIN" ]]; then warn "no domain configured yet: re-run bootstrap.sh --domain <name> once you have one"; fi
}

case "${1:-deploy}" in
  deploy)  cmd_deploy ;;
  restart) log "Restarting gateway"; compose restart gateway; wait_healthy || die "gateway not healthy after restart"; cmd_health ;;
  logs)    compose logs --tail=200 --no-color gateway ;;
  health)  cmd_health ;;
  backup)  cmd_backup ;;
  verify-backup) cmd_verify_backup "${2:-}" ;;
  restore) cmd_restore "${2:-}" ;;
  status)  cmd_status ;;
  -h|--help|help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (deploy|restart|logs|health|backup|verify-backup|restore|status)" ;;
esac
DEPLOY_EOF
  ok "deploy.sh installed"

  write_if_changed /etc/cron.d/mesh-backup 0644 root:root <<EOF || true
# Nightly SQLite backup of the Mesh gateway (keeps 14). Managed by scripts/vps/bootstrap.sh.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * ${MESH_USER} ${MESH_ROOT}/deploy.sh backup >> ${MESH_ROOT}/backups/backup.log 2>&1
EOF
  ok "cron: backup every night at 03:15 UTC"

  # ---- summary -------------------------------------------------------------------------------------
  local PUBKEY
  PUBKEY="$(cat "${DEPLOY_KEY}.pub")"
  printf '\n\033[1;32m============================================================================================\033[0m\n'
  printf '\033[1;32m  Bootstrap complete.\033[0m\n'
  printf '\033[1;32m============================================================================================\033[0m\n\n'

  if [[ "$NEW_ENV" == true ]]; then
    printf '\033[1;33mADMIN_TOKEN (save this in your password manager; it is shown only this once):\033[0m\n\n'
    printf '    %s\n\n' "$ADMIN_TOKEN_VALUE"
    printf '(It is stored in %s on the server; it guards /admin/* which is only reachable from the box.)\n\n' "$ENV_FILE"
  fi

  cat <<EOF
NEXT STEPS
----------

1. Add the DEPLOY KEY to GitHub so the server can pull the private repo (read-only):
     GitHub -> repository MeshNetworkai/mesh -> Settings -> Deploy keys -> Add deploy key
     Title:  mesh-vps ${PUBLIC_IP}
     Key:    (paste the one line below)      [ ] Allow write access  <- leave UNCHECKED

$(printf '     %s\n' "$PUBKEY")

2. Add the GitHub Actions SECRETS (repository -> Settings -> Secrets and variables -> Actions):
     VPS_HOST     = ${PUBLIC_IP}
     VPS_SSH_KEY  = the PRIVATE key you ssh to this server with (the whole file, BEGIN...END lines included)
     VPS_USER     = ${MESH_USER}            (optional; this is the default)

3. Run the first deploy: GitHub -> Actions -> "Deploy" -> Run workflow (command: deploy).
   After that every push to main deploys automatically.

EOF
  if [[ -n "$DOMAIN" ]]; then
    cat <<EOF
4. DNS (if not done yet) -> all pointing at ${PUBLIC_IP}:
     A    @      ${PUBLIC_IP}
     A    api    ${PUBLIC_IP}
     A    www    ${PUBLIC_IP}
   Caddy issues the HTTPS certificates by itself a minute or two after DNS resolves.
   Check:  curl -s https://api.${DOMAIN}/health      and open https://${DOMAIN}
EOF
  else
    cat <<EOF
4. No domain yet. The site answers on http://${PUBLIC_IP} and http://${PUBLIC_IP}/health.
   When you have bought a domain, re-run this script with it (nothing else changes):
     ssh root@${PUBLIC_IP} 'bash -s' -- --domain yourdomain.com < scripts/vps/bootstrap.sh
   then create the DNS records it prints and run the Deploy workflow again.
EOF
  fi
  [[ "$NEW_KEY" == true ]] || echo "(deploy key unchanged: if it is already on GitHub, step 1 is done)"
  echo
}

# Everything runs with stdin detached: the script itself arrives on stdin (bash -s), so no command below may
# read from it or it would swallow the rest of the script.
main "$@" </dev/null
