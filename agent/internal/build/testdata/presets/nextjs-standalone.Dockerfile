FROM node:24-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN ["sh","-c","command -v corepack >/dev/null 2>&1 || npm install -g corepack; corepack enable"]
WORKDIR /app
COPY ["package.json","yarn.lock","./"]
RUN ["sh","-c","yarn install --frozen-lockfile"]
COPY . .
RUN ["sh","-c","yarn run build"]
RUN ["sh","-c","mkdir -p public && test -f .next/standalone/server.js || { echo 'keelson: standalone is on, but the build wrote no .next/standalone/server.js: set output: \"standalone\" in next.config' >&2; exit 1; }"]
FROM node:24-alpine
RUN ["sh","-c","apk add --no-cache tini"]
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN ["sh","-c","chown node:node /app"]
COPY --from=build --chown=node:node /app/.next/standalone /app
COPY --from=build --chown=node:node /app/.next/static /app/.next/static
COPY --from=build --chown=node:node /app/public /app/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["sh","-c","node server.js"]
