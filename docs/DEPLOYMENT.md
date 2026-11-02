# Deployment

## Vercel (primary)

1. Import the repository (branch to deploy: after review/merge, not `production-readiness` directly unless you want a preview).
2. Framework preset **Next.js**; `vercel.json` already sets install/build commands, the Mumbai region (`bom1`) and a 30 s limit for the API proxy. Change the region to match your backend.
3. **Environment variables** (Project → Settings → Environment Variables). Set per environment:

| Variable | Production | Preview/Staging |
|---|---|---|
| `APP_ENV` | `production` | `staging` |
| `API_MODE` | `live` | `live` |
| `API_BASE_URL` | https backend root | staging backend |
| `NEXT_PUBLIC_SITE_URL` | final https domain | the preview/staging https URL |
| `ADMIN_SESSION_COOKIE` | same name the backend sets | same |
| `REVALIDATE_SECRET` | random ≥ 24 chars | different value |
| `CSP_EXTRA_*` | payment/analytics origins | same |

   Set `API_MODE=supabase` (default) plus the `SUPABASE_*` variables from docs/SETUP.md. Mock mode no longer exists.
4. Deploy. Verify `https://<site>/api/health` (and `?deep=1` once the backend exists), `/robots.txt` (production allows crawling; previews don't) and `/sitemap.xml`.
5. Backend → frontend purge: configure the backend to call `POST /api/revalidate` (see BACKEND_INTEGRATION §5).
6. Custom domain + HTTPS in Vercel; add the domain to Search Console after launch.

Notes: pages render per request with Next's data cache (60 s for catalogue) and `s-maxage=60, stale-while-revalidate=300` on public HTML for CDN edge caching.
To move to fully static ISR later, drop `await connection()` in `app/(storefront)/layout.tsx` once the backend is reliably reachable at build time.

## Docker fallback (self-hosting)

```bash
docker build -t one2oneight-web \
  --build-arg NEXT_PUBLIC_SITE_URL=https://www.your-domain.tld \
  --build-arg API_BASE_URL=https://api.your-domain.tld/v1 .

docker run -d -p 3000:3000 \
  -e APP_ENV=production -e NEXT_PUBLIC_SITE_URL=https://www.your-domain.tld \
  -e API_BASE_URL=https://api.your-domain.tld/v1 -e REVALIDATE_SECRET=... one2oneight-web
```
* Multi-stage, non-root, `output: 'standalone'`, healthcheck on `/api/health`. Put it behind a TLS-terminating reverse proxy / load balancer
  that forwards `Host` and `X-Forwarded-*` (the proxy route uses them for the same-origin check).
* `NEXT_PUBLIC_SITE_URL`, `API_BASE_URL` and `CSP_EXTRA_*` are needed at **build** time too (config is validated and CSP is compiled during the build). Rebuild when they change.
* Use `/api/health?deep=1` as the readiness probe.
* `docker-compose.yml` is provided for a one-command local/staging run.

## CI (GitHub Actions)
`.github/workflows/ci.yml` runs on pushes/PRs: lint → typecheck → unit tests → build → `npm audit --omit=dev` (high) → Playwright e2e (Chromium) → Docker image build.
CI uses placeholder configuration only; no secrets are required (unit tests never contact Supabase).

## Release checklist
- [ ] All `REMAINING_WORK.md` blockers closed or explicitly accepted
- [ ] Production env vars set; `API_MODE=live`; real domain
- [ ] Staging acceptance checklist (BACKEND_INTEGRATION §6) passed
- [ ] Legal pages published; seller/GST details in the CMS; consent requirements met
- [ ] Lighthouse/Web Vitals + manual device matrix run on staging
- [ ] Backups, monitoring/alerting (errors, 5xx rate, payment webhook failures), rollback plan

## Client IP and rate limits (trusted proxy)
IP rate limits (OTP sends, orders, tracking, newsletter, leads, admin login) use only an IP that a trusted proxy vouches for; `X-Forwarded-For` and `X-Real-IP` from the client are never used.
- **Cloudflare (proxied DNS or Tunnel):** set `TRUSTED_PROXY=cloudflare` and `TRUSTED_PROXY_SECRET=<random, 24+ chars>`. In Cloudflare add a **Transform Rule → Modify Request Header → Set static** `X-O218-Origin-Secret` = the same value for the zone/hostname. The app then trusts `CF-Connecting-IP` only when that header matches. Rotate by changing both sides.
- **Prevent direct-origin access:** use a Cloudflare Tunnel with no public inbound port, or firewall the origin to Cloudflare's published IP ranges only. The secret header is the application-level proof; the network rule removes the exposure.
- **Local development:** `TRUSTED_PROXY=cloudflare` without a secret (development only) trusts `CF-Connecting-IP` from a quick tunnel. Leave it unset to share one bucket.
- **Vercel (DNS pointing straight at Vercel, no proxy in front):** set `TRUSTED_PROXY=vercel`. Vercel overwrites `X-Forwarded-For` with the connecting client's address; the app trusts it only when the platform sets `VERCEL=1` (never set that yourself) and the value is exactly one valid IP. `X-Real-IP` and `X-Vercel-Forwarded-For` are never used. If a proxy such as Cloudflare is put in front of Vercel, that header holds the proxy's address and every visitor would share a bucket, so do not enable it there.
- **Other hosts:** not supported. `TRUSTED_PROXY=none` shares one IP bucket, and production refuses to start with it.
