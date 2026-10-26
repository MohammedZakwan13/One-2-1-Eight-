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

   Do **not** set `API_MODE=mock` or any `MOCK_*` variable on Vercel — the app refuses to start with mock mode outside development/test.
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
CI uses mock-mode test configuration only; no secrets are required.

## Release checklist
- [ ] All `REMAINING_WORK.md` blockers closed or explicitly accepted
- [ ] Production env vars set; `API_MODE=live`; real domain
- [ ] Staging acceptance checklist (BACKEND_INTEGRATION §6) passed
- [ ] Legal pages published; seller/GST details in the CMS; consent requirements met
- [ ] Lighthouse/Web Vitals + manual device matrix run on staging
- [ ] Backups, monitoring/alerting (errors, 5xx rate, payment webhook failures), rollback plan
