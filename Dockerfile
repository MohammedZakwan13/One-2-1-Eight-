# syntax=docker/dockerfile:1.7
# Local / self-hosted image. No secrets are baked in: Supabase and provider keys are injected at RUN time.
#
#   docker compose up --build        (see docker-compose.yml and docs/SETUP.md)

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
# Only non-secret, public build-time configuration. `next build` tolerates the absence of runtime secrets.
ARG APP_ENV=production
ARG TRUSTED_PROXY=cloudflare
ARG MSG91_WIDGET_ENABLED=true
ARG NEXT_PUBLIC_SITE_URL
ARG CSP_EXTRA_SCRIPT_SRC=""
ARG CSP_EXTRA_CONNECT_SRC=""
ARG CSP_EXTRA_FRAME_SRC=""
ARG CSP_EXTRA_IMG_SRC=""
ENV APP_ENV=$APP_ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL TRUSTED_PROXY=$TRUSTED_PROXY \
    CSP_EXTRA_SCRIPT_SRC=$CSP_EXTRA_SCRIPT_SRC CSP_EXTRA_CONNECT_SRC=$CSP_EXTRA_CONNECT_SRC \
    CSP_EXTRA_FRAME_SRC=$CSP_EXTRA_FRAME_SRC CSP_EXTRA_IMG_SRC=$CSP_EXTRA_IMG_SRC
ENV MSG91_WIDGET_ENABLED=$MSG91_WIDGET_ENABLED
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node scripts/copy-swagger.mjs && npm run build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/openapi ./openapi
USER app
EXPOSE 3000
# Liveness only; `/api/health?deep=1` also checks the database (readiness).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# `node server.js` handles SIGTERM, so `docker compose stop` shuts down gracefully.
CMD ["node", "server.js"]
