# Mesh gateway. Build from the REPO ROOT so the workspace packages are in context:
#   docker build -f apps/gateway/Dockerfile -t mesh-gateway .
# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++ \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Install first (layer cache): manifests only.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# every workspace manifest so the frozen lockfile's importer list matches
COPY packages/config/package.json packages/config/
COPY packages/chain-adapter/package.json packages/chain-adapter/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY apps/gateway/package.json apps/gateway/
COPY apps/node-agent/package.json apps/node-agent/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @mesh/gateway...

# Sources + build (config -> chain-adapter -> gateway).
COPY config ./config
COPY packages/config packages/config
COPY packages/chain-adapter packages/chain-adapter
COPY apps/gateway apps/gateway
RUN pnpm --filter @mesh/config --filter @mesh/chain-adapter --filter @mesh/gateway build

# Drop devDependencies, keep the compiled native module.
RUN CI=true pnpm install --frozen-lockfile --prod --filter @mesh/gateway... --ignore-scripts \
 && CI=true pnpm rebuild better-sqlite3

# ---------- runtime ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    MESH_DB_PATH=/data/mesh.db
RUN apk add --no-cache curl tini && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/config ./config
COPY --from=builder --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=builder --chown=node:node /app/packages/config/dist ./packages/config/dist
COPY --from=builder --chown=node:node /app/packages/chain-adapter/package.json ./packages/chain-adapter/package.json
COPY --from=builder --chown=node:node /app/packages/chain-adapter/dist ./packages/chain-adapter/dist
COPY --from=builder --chown=node:node /app/packages/chain-adapter/node_modules ./packages/chain-adapter/node_modules
COPY --from=builder --chown=node:node /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=builder --chown=node:node /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=builder --chown=node:node /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder --chown=node:node /app/apps/gateway/openapi.yaml ./apps/gateway/openapi.yaml
COPY --from=builder --chown=node:node /app/apps/gateway/node_modules ./apps/gateway/node_modules

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/gateway/dist/index.js"]
