#!/usr/bin/env bash
# Mesh end-to-end demo, fully offline:
#   boot gateway (mock adapter + mock upstream) -> fake $100 fees -> run epoch
#   -> dev-login as a holder -> create API key with a spend limit -> chat completion -> balance before/after
#   -> hit the key's spend limit -> raise it -> key usage
#   -> a curl-simulated Mesh node registers, pulls a job for a client request, streams chunks, finishes
#      (client sees one OpenAI SSE stream with mesh usage; node wallet earns a reward)
#   -> node stats + public stats (hourly series, servedByNetworkPercent) + epoch history
#   -> link-code path: the wallet "signs in the browser" (mock signature), POST /nodes/link mints a one-time
#      code, a second Mac registers with {linkCode} only (no wallet on the machine); the code is single use
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${DEMO_PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
ADMIN_TOKEN="${ADMIN_TOKEN:-demo-admin-token}"
WALLET="${DEMO_WALLET:-mockwallet_alice}"
DB_DIR="$(mktemp -d)"
LOG="$DB_DIR/gateway.log"

json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

cleanup() {
  if [[ -n "${GW_PID:-}" ]] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  rm -rf "$DB_DIR"
}
trap cleanup EXIT

if [[ ! -d node_modules ]]; then step "pnpm install"; pnpm install; fi
if [[ ! -f packages/chain-adapter/dist/index.js || ! -f packages/config/dist/index.js ]]; then
  step "building workspace packages"; pnpm --filter @mesh/config --filter @mesh/chain-adapter build
fi

step "booting gateway in MOCK mode on :$PORT (db: $DB_DIR/mesh.db)"
PORT="$PORT" HOST=127.0.0.1 MESH_DB_PATH="$DB_DIR/mesh.db" MESH_ADAPTER=mock EPOCH_CRON=off \
JWT_SECRET="demo-secret-demo-secret-demo-secret" ADMIN_TOKEN="$ADMIN_TOKEN" LOG_LEVEL=warn \
OPENROUTER_API_KEY="" STATS_CACHE_MS=0 AUTH_DOMAIN="127.0.0.1:$PORT" NODES_REQUIRE_SIGNATURE=false ALERTS_ENABLED=false \
  apps/gateway/node_modules/.bin/tsx apps/gateway/src/index.ts >"$LOG" 2>&1 &
GW_PID=$!

for i in $(seq 1 60); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then echo "gateway died:"; cat "$LOG"; exit 1; fi
  sleep 0.25
done
curl -s "$BASE/health"; echo

step "stats before"
curl -s "$BASE/stats"; echo

step "fake \$100 of trading fees into the MockAdapter"
curl -s -X POST "$BASE/admin/fake-fees" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"amountUsd":100}'; echo

step "run distribution epoch (50% to holders >= 1000 MESH, pro-rata)"
curl -s -X POST "$BASE/admin/run-epoch" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'; echo

step "dev-login as $WALLET (DEV ONLY: mints a session JWT without a wallet signature)"
JWT=$(curl -s -X POST "$BASE/admin/dev-login" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\"}" | json token)
echo "jwt: ${JWT:0:24}..."

step "balance BEFORE"
BEFORE=$(curl -s "$BASE/me" -H "authorization: Bearer $JWT" | json balance.usd)
echo "\$$BEFORE"

step "create API key named 'demo' with a \$0.0025 spend limit"
KEY_JSON=$(curl -s -X POST "$BASE/keys" -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"name":"demo","spendLimitUsd":0.0025}')
KEY=$(echo "$KEY_JSON" | json key)
KEY_ID=$(echo "$KEY_JSON" | json id)
echo "key: ${KEY:0:16}... (shown once)  id=$KEY_ID  spendLimitUsd=$(echo "$KEY_JSON" | json spendLimitUsd)"

step "OpenAI-compatible chat completion (mock upstream, streamed)"
curl -sN -X POST "$BASE/v1/chat/completions" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"mesh/mock","stream":true,"messages":[{"role":"user","content":"What did my fees buy?"}]}' \
  | grep '^data:' | grep -v '\[DONE\]' | sed 's/^data: //' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let out="",u=null;for(const l of d.trim().split("\n")){const j=JSON.parse(l);out+=j.choices?.[0]?.delta?.content??"";if(j.usage)u=j.usage}console.log(out);console.log("usage:",JSON.stringify(u))})'

step "balance AFTER"
AFTER=$(curl -s "$BASE/me" -H "authorization: Bearer $JWT" | json balance.usd)
echo "\$$AFTER"
node -e "console.log('delta: \$' + ($BEFORE - $AFTER).toFixed(6))"

step "last ledger rows"
curl -s "$BASE/me" -H "authorization: Bearer $JWT" | json ledger | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const r of JSON.parse(d)) console.log(`${r.kind.padEnd(13)} ${r.deltaUsd>=0?"+":""}${r.deltaUsd}  ${r.ref??""}`)})'

step "key spend limit: two more requests fit under \$0.0025, the third is refused (429 key_spend_limit_reached)"
for i in 1 2 3; do
  CODE=$(curl -s -o "$DB_DIR/resp.json" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "authorization: Bearer $KEY" \
    -H 'content-type: application/json' -d '{"model":"mesh/mock","messages":[{"role":"user","content":"again"}]}')
  if [[ "$CODE" == "200" ]]; then echo "request $i: 200 (cost \$$(json usage.cost < "$DB_DIR/resp.json"))"; else echo "request $i: $CODE $(json error.code < "$DB_DIR/resp.json") - $(json error.message < "$DB_DIR/resp.json")"; fi
done

step "raise the limit with PATCH /keys/$KEY_ID"
curl -s -X PATCH "$BASE/keys/$KEY_ID" -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"spendLimitUsd":1}'; echo
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model":"mesh/mock","messages":[{"role":"user","content":"ok now?"}]}')
echo "request after raise: $CODE"

step "key usage (GET /keys/$KEY_ID/usage)"
curl -s "$BASE/keys/$KEY_ID/usage" -H "authorization: Bearer $JWT" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const u=JSON.parse(d);console.log(`name=${u.key.name} limit=$${u.key.spendLimitUsd} spent=$${u.key.spentUsd}`);console.log("last24h:",JSON.stringify(u.last24h));console.log("topModels:",JSON.stringify(u.topModels))})'

step "models visible through the policy (GET /v1/models)"
curl -s "$BASE/v1/models" -H "authorization: Bearer $KEY" | json data

step "node network: register a Mac node (gets a bearer token), heartbeat with hardware"
REG=$(curl -s -X POST "$BASE/nodes/register" -H 'content-type: application/json' \
  -d '{"nodeId":"demo-mac","wallet":"mockwallet_bob","chip":"M3 Max","ramGb":64,"models":["llama3.1:8b"],"agentVersion":"demo"}')
NODE_ID=$(echo "$REG" | json nodeId); NODE_TOKEN=$(echo "$REG" | json nodeToken)
echo "nodeId=$NODE_ID token=${NODE_TOKEN:0:14}... heartbeatEverySec=$(echo "$REG" | json heartbeatEverySec)"
curl -s -X POST "$BASE/nodes/$NODE_ID/heartbeat" -H "authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' \
  -d '{"models":["llama3.1:8b"],"busy":false,"loadAvg":1.2}'; echo

step "client asks for llama-3.1-8b (a network model) on the 'network' privacy tier -> gateway queues a job for the node (request runs in background)"
# The demo node is unstaked and unpledged, so it is not 'trusted' (the default tier; docs/PRIVACY.md). Ask for 'network' explicitly.
curl -sN -D "$DB_DIR/client.headers" -o "$DB_DIR/client.sse" -X POST "$BASE/v1/chat/completions" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'x-mesh-privacy: network' \
  -d '{"model":"llama-3.1-8b","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"Who served this?"}]}' &
CLIENT_PID=$!

step "node long-polls GET /nodes/$NODE_ID/jobs/next and claims the job"
JOB=$(curl -s "$BASE/nodes/$NODE_ID/jobs/next?wait=10000" -H "authorization: Bearer $NODE_TOKEN")
JOB_ID=$(echo "$JOB" | json jobId)
echo "jobId=$JOB_ID model=$(echo "$JOB" | json model) maxTokens=$(echo "$JOB" | json maxTokens) attempt=$(echo "$JOB" | json attempt)"
echo "messages: $(echo "$JOB" | json messages)"
echo "(that is the whole job: no wallet, key, IP or user agent reaches the node — docs/PRIVACY.md)"

step "node streams chunks (POST .../chunk {seq, delta}) then finishes (POST .../done)"
SEQ=0
for WORD in "This" " reply" " was" " generated" " on" " a" " Mesh" " node" "."; do
  curl -s -o /dev/null -X POST "$BASE/nodes/$NODE_ID/jobs/$JOB_ID/chunk" -H "authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' \
    -d "{\"seq\":$SEQ,\"delta\":\"$WORD\"}"
  SEQ=$((SEQ+1)); sleep 0.05
done
curl -s -X POST "$BASE/nodes/$NODE_ID/jobs/$JOB_ID/done" -H "authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' \
  -d '{"promptTokens":12,"completionTokens":9,"finishReason":"stop"}'; echo

step "client received one continuous SSE stream"
wait "$CLIENT_PID" || true
grep -i '^x-mesh-route\|^x-mesh-privacy\|^x-mesh-served-by' "$DB_DIR/client.headers" || true
grep '^data:' "$DB_DIR/client.sse" | grep -v '\[DONE\]' | sed 's/^data: //' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let out="",u=null,m=null;for(const l of d.trim().split("\n")){const j=JSON.parse(l);out+=j.choices?.[0]?.delta?.content??"";if(j.usage)u=j.usage;if(j.mesh)m=j.mesh}console.log("text:",out);console.log("usage:",JSON.stringify(u));console.log("mesh:",JSON.stringify(m))})'

step "node stats (GET /nodes/$NODE_ID with the node token): uptime, jobs, tokens, earnings, reputation"
curl -s "$BASE/nodes/$NODE_ID" -H "authorization: Bearer $NODE_TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const n=JSON.parse(d);console.log(`status=${n.status} uptimePct24h=${n.uptimePct24h} jobs24h=${n.jobs24h} tokens24h=${n.tokens24h} earnedUsd24h=${n.earnedUsd24h} earnedUsdTotal=${n.earnedUsdTotal}`);console.log("reputation:",JSON.stringify(n.reputation))})'

step "node owner view (GET /me/nodes as mockwallet_bob)"
BOB_JWT=$(curl -s -X POST "$BASE/admin/dev-login" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"wallet":"mockwallet_bob"}' | json token)
curl -s "$BASE/me/nodes" -H "authorization: Bearer $BOB_JWT" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);console.log(`wallet=${m.wallet} nodes=${m.nodes.length} earnedUsdTotal=${m.earnedUsdTotal} rewardUsdPerMTokens=${m.rewardUsdPerMTokens}`)})'

step "public node summary (GET /nodes): no wallets or tokens"
curl -s "$BASE/nodes"; echo

step "public stats (cached 10s in prod): totals, token meta, servedByNetworkPercent, last 3 hourly buckets"
curl -s "$BASE/stats" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const {series24h,...rest}=s;console.log(JSON.stringify(rest));console.log("feesThisEpochUsd:",s.feesThisEpochUsd);console.log(`servedByNetworkPercent: ${s.servedByNetworkPercent}% (servedByNetwork24h=${s.servedByNetwork24h} of requestsLast24h=${s.requestsLast24h}, jobs24h=${s.jobs24h})`);console.log("series24h (last 3 of "+series24h.length+"):");for(const p of series24h.slice(-3))console.log(`  ${new Date(p.hour*1000).toISOString().slice(0,13)}h fees=$${p.feesUsd} credits=$${p.creditsDistributedUsd} requests=${p.requests} spend=$${p.spendUsd}`)})'

step "public epoch history (GET /epochs?limit=48)"
curl -s "$BASE/epochs?limit=5" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);console.log(`total=${e.total} showing=${e.epochs.length}`);for(const x of e.epochs)console.log(`  ${new Date(x.epochStart*1000).toISOString().slice(0,13)}h ${x.status.padEnd(8)} fees=$${x.feesUsd} holders=$${x.holderPoolUsd} eligible=${x.eligibleHolders}`)})'

step "link a Mac: bob's browser fetches the register challenge and signs it (MockAdapter signature = base64(wallet:message))"
CH=$(curl -s -X POST "$BASE/nodes/register/challenge" -H 'content-type: application/json' -d '{"wallet":"mockwallet_bob"}')
NONCE=$(echo "$CH" | json nonce)
MESSAGE=$(echo "$CH" | json message)
SIG=$(printf '%s:%s' "mockwallet_bob" "$MESSAGE" | base64 | tr -d '\n')
LINK=$(curl -s -X POST "$BASE/nodes/link" -H "authorization: Bearer $BOB_JWT" -H 'content-type: application/json' \
  -d "{\"nonce\":\"$NONCE\",\"signature\":\"$SIG\",\"chain\":\"solana\"}")
CODE=$(echo "$LINK" | json code)
echo "link code: $CODE (expires $(echo "$LINK" | json expiresAt)) -> on the Mac: mesh-node setup --link $CODE"

step "second Mac registers with the link code only (what 'mesh-node setup --link' sends); the code is single use"
REG2=$(curl -s -X POST "$BASE/nodes/register" -H 'content-type: application/json' \
  -d "{\"linkCode\":\"$CODE\",\"chip\":\"M2\",\"ramGb\":16,\"models\":[\"llama3.1:8b\"],\"agentVersion\":\"demo\"}")
echo "nodeId=$(echo "$REG2" | json nodeId) wallet=$(echo "$REG2" | json wallet) walletVerified=$(echo "$REG2" | json walletVerified) linked=$(echo "$REG2" | json linked)"
curl -s -X POST "$BASE/nodes/register" -H 'content-type: application/json' \
  -d "{\"linkCode\":\"$CODE\",\"models\":[]}"; echo
curl -s "$BASE/me/nodes" -H "authorization: Bearer $BOB_JWT" | json nodes | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log("bob now owns:",JSON.parse(d).map(n=>n.nodeId).join(", "))})'

step "health"
curl -s "$BASE/health"; echo

step "admin overview (totals + audit trail)"
curl -s "$BASE/admin/overview" -H "x-admin-token: $ADMIN_TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log("totals:",JSON.stringify(o.totals));console.log("topHolders:",JSON.stringify(o.topHolders.map(h=>`${h.wallet}=$${h.balanceUsd}`)));console.log("adminActions:",o.recentAdminActions.map(a=>a.action).join(", "))})'
echo
echo "demo complete."
