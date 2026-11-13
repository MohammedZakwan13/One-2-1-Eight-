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

## Banner video upload and optimisation (FFmpeg)

Admin → Homepage & banners accepts videos of **any size** in common formats (MP4, MOV, MKV, AVI, WMV, FLV, MPEG, M4V, 3GP, WebM, and anything else FFmpeg can decode). The original is uploaded in resumable 8 MB chunks and then processed **on the server in the background**. There is no fixed output size: the admin picks one of three modes for each upload.

| Mode | What happens |
|---|---|
| **Original Quality** (default) | A browser-compatible file (H.264/AAC MP4 or MOV, VP8/VP9 WebM) is kept exactly as uploaded when its index is up front, or re-wrapped with a lossless stream copy (no re-encoding, resolution / frame rate / bitrate untouched). Only a codec browsers cannot play (HEVC, MPEG-4, WMV, 10-bit/HDR ...) is converted to H.264/AAC at near-lossless quality (CRF 17) without resizing, and the admin is told that conversion can affect quality. |
| **Auto Compress — Balanced** | Re-encoded with H.264 at the original resolution and frame rate (CRF 22, bitrate capped near 80% of the source). If that would not make the file meaningfully smaller, the original is kept instead. 8K is limited to 4K. |
| **Auto Compress — Smaller Size** | Stronger compression (CRF 28, bitrate capped near 45% of the source), at most 1080p and 30 fps. Resolution is reduced only when the source is larger. |

The admin screen shows original and processed size and resolution, the mode, and whether the file was **preserved**, **re-wrapped**, **re-encoded** or **resized** (resolution is only mentioned when it really changed), plus a warning when compression was heavy or HDR was flattened. A failed or incomplete conversion is never published, and the banner keeps its current video until the replacement is ready **and the banner is saved**.

- **FFmpeg is required, with no fallback.** The production `Dockerfile` installs Alpine's `ffmpeg` and **fails the build** if `ffmpeg`, `ffprobe`, `libx264` or `aac` is missing. `GET /api/health?deep=1` reports `videoProcessing: "ok" | "ffmpeg_missing"`, and an upload without FFmpeg is answered with `503 media_processing_unavailable`. For local development install FFmpeg (for example `winget install Gyan.FFmpeg`) or set `FFMPEG_PATH` / `FFPROBE_PATH`.
- **Storage limit (migration 0013).** The `banner-media` bucket's per-file limit was 12 MB; migration `0013_banner_video_size_limit.sql` raises it to 50 MB (52428800 bytes), matching the Free plan's project-wide per-file limit (Dashboard → Storage → Settings), which applies regardless. Apply it in Supabase before using files above 12 MB; on a paid plan with a higher project limit, raise the bucket limit with a new migration and set HERO_VIDEO_MAX_OUTPUT_MB to match. A refusal by Supabase is reported with exactly that explanation.
- **Safeguards (all configurable, none is a quality rule):** `HERO_VIDEO_MAX_OUTPUT_MB` largest processed file (default 45,000,000 bytes: deliberately below the Free plan's 50,000,000-byte project-wide limit, with the bucket at 52,428,800 bytes; a file of exactly 45,000,000 bytes is accepted, one byte more is refused before anything is uploaded; the variable is in MiB, e.g. 60 = 62,914,560 bytes, so raise it only together with the Supabase project limit and the bucket limit); `HERO_VIDEO_MAX_DURATION_S` longest source (default 300); `HERO_VIDEO_MAX_SOURCE_MB` largest original (unset = none; the real limit is free disk space, checked per upload at about 3x the file plus 1 GB); `HERO_VIDEO_CONCURRENCY` encodes at once (default 1, max 2); `HERO_VIDEO_MAX_QUEUE` waiting jobs (default 3); `HERO_VIDEO_MAX_UPLOADS` simultaneous chunked uploads (default 3); `HERO_VIDEO_UPLOAD_IDLE_S` seconds without any progress before a Storage upload is aborted (default 120) and `HERO_VIDEO_UPLOAD_MIN_KBPS` slowest connection to Supabase still accepted, which sets the overall upload deadline (default 32 KiB/s); `HERO_VIDEO_JOB_TIMEOUT_S` minimum time per video (default 420; heavier clips get about 12 s per second of video, up to an hour); `HERO_VIDEO_TMP_DIR`; `FFMPEG_PATH` / `FFPROBE_PATH`; `HERO_VIDEO_NICE=0`.
- **Capacity (Hostinger KVM 1, 1 vCPU):** one encode at a time at low priority (`nice 10`), a short queue, a hard time limit, and temp files deleted on success, failure, cancel or after two idle hours. Jobs are held in memory only. The finished file is read into memory once for the upload (at most the output safeguard).
- **Monitoring:** each job writes one log line (`[video] job ready|failed mode=… action=… in=…B out=…B WxH->WxH took=…ms`); check it for processing time, storage growth and expected bandwidth. Original Quality keeps large files large: a 4K clip can be tens of MB, so prefer Balanced or Smaller Size for the homepage when load speed matters.
- **Storefront delivery:** only the active banner's video element exists at any time, its poster image is painted first, other slides use `preload="metadata"`, desktop and mobile have separate videos, files are served from Supabase Storage with a one-year cache header and HTTP range support (seeking and progressive playback), and the CDN in front of the storage caches them.
- **Check after deploy:** `docker compose -f docker-compose.prod.yml exec web ffmpeg -version`, `curl -s http://127.0.0.1:3000/api/health?deep=1` (expect `"videoProcessing":"ok"`), then upload a video from Admin → Homepage & banners.

- **Upload lifecycle.** FFmpeg runs one video at a time (the encoder slot is freed as soon as encoding ends); the processed file is then streamed to Supabase Storage with real progress, a stall detector and a deadline, so a slow or dead connection can delay or fail only that one upload and never blocks other videos. A watchdog fails any job that stops reporting progress. A failed or stalled job never changes the published video.
