#!/usr/bin/env bash
# Switch the gateway from the test feed to the real $MESH token — run on Oliver's Mac after the Pons launch.
#
#   bash scripts/chain/go-live.sh <token address> <excluded contracts, comma-separated> <launch block>
#   (excluded = the Pons/Uniswap contracts that hold supply: pool manager, launch locker, hook — never holders)
#
# The admin API is only reachable on the server itself (Caddy answers 404 for /admin/* from the
# internet), so this does over ssh what the Admin → Token page would do:
#   1. saves token + launch block + curve exclusion in the gateway (POST /admin/chain)
#   2. runs the on-chain Check (POST /admin/chain/check) and prints every item
#   3. if you say yes: sets MESH_ADAPTER=evm in /opt/mesh/.env, recreates the gateway container and
#      waits for /health to report the live adapter
# It also writes the three values into config/deploy.robinhood.json and commits (push when you like).
# Nothing here needs a private key; the admin token is read on the server and never printed.
set -euo pipefail

SERVER="${MESH_SERVER:-root@80.78.27.94}"
SSH_KEY="${MESH_SSH_KEY:-$HOME/Documents/mesh-keys/mesh_deploy}"
PORT="${MESH_GATEWAY_PORT:-8787}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$REPO/config/deploy.robinhood.json"

TOKEN="${1:-}"; CURVE="${2:-}"; BLOCK="${3:-}"
die() { echo "  ✗ $*" >&2; exit 1; }
ok() { echo "  ✓ $*"; }
addr='^0x[0-9a-fA-F]{40}$'
[[ "$TOKEN" =~ $addr ]] || die "usage: go-live.sh <token 0x…> <curve 0x…> <launch block>   (token address missing or malformed)"
IFS=, read -r -a EXCL <<< "$CURVE"
for a in "${EXCL[@]}"; do [[ "$a" =~ $addr ]] || die "excluded address malformed: $a"; done
[[ "$BLOCK" =~ ^[0-9]+$ ]] || die "launch block must be a number"
[[ -f "$SSH_KEY" ]] || die "ssh key not found at $SSH_KEY"

remote() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" "$@"; }

echo
echo "1/3 Saving the token in the gateway"
EXCL_JSON=$(printf '"%s",' "${EXCL[@]}"); EXCL_JSON="[${EXCL_JSON%,}]"
BODY=$(printf '{"token":"%s","deployBlock":"%s","excludeWallets":%s}' "$TOKEN" "$BLOCK" "$EXCL_JSON")
remote "T=\$(grep ^ADMIN_TOKEN= /opt/mesh/.env | cut -d= -f2-); curl -sS -X POST -H \"authorization: Bearer \$T\" -H 'content-type: application/json' http://127.0.0.1:$PORT/admin/chain -d '$BODY'" > /tmp/mesh-go-live-save.json
python3 - /tmp/mesh-go-live-save.json <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print('  ✗ save failed:', json.dumps(d)[:400]); sys.exit(1)
e = d.get('effective', {})
print(f"  ✓ saved: token {e.get('token')}  launch block {e.get('deployBlock')}  excluded {len(e.get('excludeWallets') or [])} wallet(s)")
print(f"  adapter now: {d['adapter']['status']} (requested {d['adapter']['requested']}, ready {d['adapter']['ready']})")
EOF

echo
echo "2/3 On-chain check (reads the chain; nothing is sent)"
remote "T=\$(grep ^ADMIN_TOKEN= /opt/mesh/.env | cut -d= -f2-); curl -sS -X POST -H \"authorization: Bearer \$T\" -H 'content-type: application/json' http://127.0.0.1:$PORT/admin/chain/check -d '{}'" > /tmp/mesh-go-live-check.json
python3 - /tmp/mesh-go-live-check.json <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
mark = {'ok': '✓', 'warn': '!', 'fail': '✗', 'info': '·'}
fails = 0
for it in d.get('items', []):
    s = it.get('status'); fails += s == 'fail'
    print(f"  {mark.get(s, '?')} {it.get('check')}: {it.get('detail', '')}")
print(f"  rpc reachable: {d.get('rpcReachable')}  ready: {d.get('ready')}  overall ok: {d.get('ok')}")
if fails:
    print(f"\n  {fails} check(s) FAILED — do not switch the adapter; send this output to Claude."); sys.exit(2)
EOF

echo
echo "3/3 Switch the gateway to the live adapter (MESH_ADAPTER=evm + restart)."
echo "    From then on the next top-of-the-hour epoch sweeps real fees."
read -r -p "    Switch now? (yes/no): " ans
if [[ "$ans" != "yes" ]]; then echo "  stopped before switching; re-run this script when ready"; exit 0; fi
remote "sed -i 's/^MESH_ADAPTER=.*/MESH_ADAPTER=evm/' /opt/mesh/.env && grep -q '^MESH_ADAPTER=evm' /opt/mesh/.env || echo 'MESH_ADAPTER=evm' >> /opt/mesh/.env; cd /opt/mesh && docker compose up -d gateway >/dev/null 2>&1; for i in \$(seq 1 60); do curl -sf http://127.0.0.1:$PORT/health && exit 0; sleep 2; done; echo 'gateway not healthy after 120 s' >&2; exit 1" > /tmp/mesh-go-live-health.json
python3 - /tmp/mesh-go-live-health.json <<'EOF'
import json, sys
h = json.load(open(sys.argv[1]))
print(f"  ✓ gateway healthy — adapter: {h.get('adapter')} (requested {h.get('adapterRequested')})")
if str(h.get('adapter', '')).startswith('mock'):
    print("  ! still on the mock adapter: check the output above and tell Claude"); sys.exit(3)
EOF

# record the launch in the config template (informative; the gateway reads its own saved overrides)
python3 - "$CFG" "$TOKEN" "$CURVE" "$BLOCK" <<'EOF'
import json, re, sys
p, token, curve, block = sys.argv[1:5]
s = open(p).read()
s = re.sub(r'"token":\s*null', f'"token": "{token}"', s, 1)
s = re.sub(r'"curve":\s*null', f'"curve": "{curve.split(",")[0]}"', s, 1)
s = re.sub(r'"deployBlock":\s*null', f'"deployBlock": {int(block)}', s, 1)
json.loads(s); open(p, 'w').write(s)
EOF
( cd "$REPO" && git add config/deploy.robinhood.json && git -c user.name="Mesh" -c user.email="dev@mesh-network.ai" commit -qm "launch: \$MESH $TOKEN live on Robinhood Chain (excluded $CURVE, block $BLOCK)" && ok "config committed (push when you like: git push)" ) || true
echo
echo "  Done. Watch the first epoch at the top of the hour (Telegram alerts are on)."
