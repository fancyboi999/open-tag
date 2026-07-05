# syntax=docker/dockerfile:1
# Control-plane image: builds the web client and serves it together with the API from one Node process.
# The daemon (compute plane) is intentionally NOT in this image — it runs on the user's own host with their
# CLIs/credentials/code and connects back over the published WS port. See docs/docker.md.

# ---- build stage: install deps + build the web client and docs ----
FROM node:22-slim AS build
WORKDIR /app
ENV NODE_ENV=development
# Root deps first (server runs via tsx and pushes schema via drizzle-kit at runtime, so full deps are needed).
COPY package.json package-lock.json ./
RUN npm ci
# Web/docs deps, then build.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY docs-site/package.json docs-site/package-lock.json ./docs-site/
RUN npm --prefix docs-site ci
COPY . .
RUN npm run site:build

# ---- runtime stage: source + root node_modules + built client/docs, run with tsx ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The entrypoint's npx invocations print "npm notice: new major version available" to stderr on start,
# which log collectors (e.g. Railway) surface at error level — noise that pollutes @level:error queries.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/docs-site/dist ./docs-site/dist
COPY --from=build /app/src ./src
# daemon package.json: read at runtime for latestDaemonVersion (system-alert "outdated daemon" check); only the manifest is needed.
COPY --from=build /app/packages/daemon/package.json ./packages/daemon/package.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 7788
# Liveness via the app's own /health (Node 22 has global fetch; no curl/wget needed in the slim image).
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
