# syntax=docker/dockerfile:1.7
# Docker fallback for self-hosting. Vercel does NOT use this file.
#
# Build (all validated settings are required at build time because `next build` imports lib/env.ts):
#   docker build -t one2oneight-web \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://www.your-domain.tld \
#     --build-arg API_BASE_URL=https://api.your-domain.tld/v1 .
# Run (secrets are runtime-only; never bake them into the image):
#   docker run -p 3000:3000 -e APP_ENV=production -e API_BASE_URL=... -e NEXT_PUBLIC_SITE_URL=... one2oneight-web

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
# Non-secret build-time configuration (public site URL and API origin). Staging builds can override APP_ENV.
ARG APP_ENV=production
ARG NEXT_PUBLIC_SITE_URL
ARG API_BASE_URL
ARG CSP_EXTRA_SCRIPT_SRC=""
ARG CSP_EXTRA_CONNECT_SRC=""
ARG CSP_EXTRA_FRAME_SRC=""
ARG CSP_EXTRA_IMG_SRC=""
ENV APP_ENV=$APP_ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL API_BASE_URL=$API_BASE_URL \
    CSP_EXTRA_SCRIPT_SRC=$CSP_EXTRA_SCRIPT_SRC CSP_EXTRA_CONNECT_SRC=$CSP_EXTRA_CONNECT_SRC \
    CSP_EXTRA_FRAME_SRC=$CSP_EXTRA_FRAME_SRC CSP_EXTRA_IMG_SRC=$CSP_EXTRA_IMG_SRC
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
USER app
EXPOSE 3000
# Liveness only; use `/api/health?deep=1` from your orchestrator for readiness (also probes the backend).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
