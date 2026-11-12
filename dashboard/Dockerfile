# syntax=docker/dockerfile:1
#
# Build from the repository root, so the image can carry the agent the dashboard installs on servers:
#
#   docker build -f dashboard/Dockerfile --build-arg VERSION="$(scripts/version.sh)" -t keelson-dashboard .
#
# VERSION names the dashboard and the agent it carries (v0.1.0 on a release; scripts/version.sh says how it is derived). REVISION
# is the commit. The .git directory is not part of the build context, so both come in as build args.

# The agent: for the Linux servers it is installed on, and for the Macs and laptops that connect out as build machines. A static binary.
# It runs on the builder's own architecture and cross-compiles all four targets, so a multi-platform image never emulates the Go build.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ARG VERSION=dev
RUN set -eu; for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do \
      CGO_ENABLED=0 GOOS=${target%/*} GOARCH=${target#*/} go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/keelson-agent-${target%/*}-${target#*/} ./cmd/keelson-agent; \
    done; \
    echo "${VERSION}" > /out/VERSION

FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@12.14.0
WORKDIR /app

FROM base AS deps
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY dashboard/ ./
RUN pnpm run build

FROM node:24-bookworm-slim AS run
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Keelson dashboard" \
      org.opencontainers.image.description="The Keelson dashboard: one place to deploy to your own servers." \
      org.opencontainers.image.source="https://github.com/0x2u/keelson" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production \
    KEELSON_DASHBOARD_VERSION=${VERSION} \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEELSON_DASHBOARD_DATA_DIR=/data \
    KEELSON_AGENT_BIN_DIR=/app/agent-bin
WORKDIR /app
# The standalone output carries its own minimal node_modules and server.js.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=agent --chown=node:node /out /app/agent-bin
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
