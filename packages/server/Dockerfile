ARG NODE_VERSION=24.15.0

# ---- Builder: install dev deps, esbuild-bundle the four runtime entries,
# and assemble the production dependency tree (server-image stage 1).
FROM node:${NODE_VERSION}-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app

# Copy workspace root files (.npmrc pins the pnpm settings the lockfile was
# generated with — without it the container's pnpm defaults mismatch and
# --frozen-lockfile refuses to install).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches/ patches/

# Copy package manifests
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# Install all dependencies (esbuild + tsx are devDependencies)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

# Copy source (dockerignore trims drizzle/meta/*_snapshot.json; the journal
# and SQL files stay — migrations read them at runtime)
COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/

# Bundle the four runtime entries into packages/server/dist/
RUN pnpm --filter @botiverse/raft-server run bundle

# Production dependency tree for the runtime image. --legacy keeps the
# deploy layout validated during stage 0: workspace deps (shared, sync-core)
# are inlined into the output's node_modules. The workspace-root patches
# (k-carrier/hands-node/react-native-screens) target desktop/mobile deps the
# server subtree never pulls, so allow them to stay unused for this subset
# install instead of tripping ERR_PNPM_UNUSED_PATCH.
RUN pnpm --config.allow-unused-patches=true deploy --prod --legacy \
  --filter=@botiverse/raft-server /deploy-out

# ---- Runtime: slim image running the prebuilt bundles (no tsx, no sources).
FROM node:${NODE_VERSION}-bookworm-slim

# Sharp rasterizes download-only SVG attachments through libvips/librsvg.
# The slim Node image contains neither fontconfig nor fonts, so otherwise even
# ordinary Mermaid `font-family="sans-serif"` labels become tofu/blank pixels
# while shapes still render. Keep small Latin and CJK baseline fonts and fail
# the image build if the generic family cannot actually resolve them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-wqy-zenhei \
  && fc-match sans-serif | grep -q "DejaVu Sans" \
  && for language in zh-cn ja ko; do \
    fc-match -f '%{family}\n' "sans-serif:lang=${language}" | grep -q "WenQuanYi Zen Hei"; \
  done \
  && rm -rf /var/lib/apt/lists/*

ARG RAFT_RELEASE_SHA=""
ARG RAFT_BUILD_AT=""
ARG RAFT_RELEASE_BRANCH=""
ARG SLOCK_RELEASE_SHA=""
ARG SLOCK_BUILD_AT=""
ARG SLOCK_RELEASE_BRANCH=""
# RAFT_* is the canonical release identity; SLOCK_* remains a compatibility alias.
ENV RAFT_RELEASE_SHA=$RAFT_RELEASE_SHA
ENV RAFT_BUILD_AT=$RAFT_BUILD_AT
ENV RAFT_RELEASE_BRANCH=$RAFT_RELEASE_BRANCH
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA
ENV SLOCK_BUILD_AT=$SLOCK_BUILD_AT
ENV SLOCK_RELEASE_BRANCH=$SLOCK_RELEASE_BRANCH

WORKDIR /app

# Bundled entries (dist/*.js + external .map files). Layout invariants the
# bundles rely on, relative to packages/server/dist/:
#   ../package.json   — version.ts reads the server version
#   ../drizzle        — migration-preflight / migrate-deploy / pglite journal
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /deploy-out/package.json packages/server/package.json
COPY --from=builder /app/packages/server/drizzle packages/server/drizzle
COPY --from=builder /deploy-out/node_modules packages/server/node_modules
COPY --from=builder /app/packages/server/entrypoint.sh packages/server/entrypoint.sh

# agent-knowledge service reads manual/ relative to process.cwd() (= /app)
COPY manual/ manual/

EXPOSE 3001

# Entrypoint: push DB schema then start server
RUN chmod +x packages/server/entrypoint.sh
CMD ["packages/server/entrypoint.sh"]
