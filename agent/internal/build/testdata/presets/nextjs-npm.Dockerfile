FROM node:22-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY ["package.json","package-lock.json","./"]
RUN ["sh","-c","npm ci"]
COPY . .
RUN ["sh","-c","npm run build"]
FROM node:22-alpine
RUN ["sh","-c","apk add --no-cache tini"]
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN ["sh","-c","chown node:node /app"]
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["sh","-c","npm exec -- next start -p \"$PORT\""]
