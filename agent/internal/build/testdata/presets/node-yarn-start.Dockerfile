FROM node:22-alpine AS build
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN ["sh","-c","command -v corepack >/dev/null 2>&1 || npm install -g corepack; corepack enable"]
WORKDIR /app
COPY ["package.json","yarn.lock",".yarnrc.yml","./"]
RUN ["sh","-c","yarn install --frozen-lockfile"]
COPY . .
RUN ["sh","-c","if node -e 'const s=require(\"./package.json\").scripts||{};process.exit(s.build?0:1)'; then yarn run build; fi"]
FROM node:22-alpine
RUN ["sh","-c","apk add --no-cache tini"]
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN ["sh","-c","command -v corepack >/dev/null 2>&1 || npm install -g corepack; corepack enable"]
COPY --from=build /opt/corepack /opt/corepack
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN ["sh","-c","chown node:node /app"]
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["sh","-c","node dist/main.js --port \"$PORT\""]
