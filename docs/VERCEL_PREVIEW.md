# Vercel Preview deployment checklist

Preview only. Production (`one21eight.com`) is a separate, later step. Never put production secrets in Preview variables.

## Project settings
| Setting | Value |
| --- | --- |
| Repository / branch | `MohammedZakwan13/One-2-1-Eight-`, `feature/supabase-api` (preview deployments only) |
| Framework / root | Next.js, repository root |
| Install / build | `npm ci` / `npm run build` (from `vercel.json`) |
| Node | 24.x (`engines` in package.json; Vercel project setting must also be 24.x) |
| Plan | Hobby is non-commercial only: fine for evaluating a preview, Pro is needed for the live store |

## Environment variables (scope: **Preview** only)
| Variable | Value |
| --- | --- |
| `APP_ENV` | `staging` |
| `NEXT_PUBLIC_SITE_URL` | the preview URL, once it exists (required for staging; redeploy after setting) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | the existing **staging** project `ouvkqdubunymmzwzkkip` only |
| `TRUSTED_PROXY` | `vercel` (use `none` while testing; it shares one IP bucket). `VERCEL=1` is set by Vercel: never add it by hand |
| `ENABLE_API_DOCS` | leave unset (off outside development unless `true`; on in staging by default, so set `false` if the preview URL is shared) |
| `RAZORPAY_*` | test keys, or leave all unset (Cash on delivery only) |
| `RESEND_*`, `EMAIL_FROM`, `INTERNAL_NOTIFICATION_EMAIL` | optional; unset means emails are logged as skipped |
| `MSG91_AUTH_KEY`, `MSG91_WIDGET_ID`, `MSG91_WIDGET_TOKEN_AUTH` | **only when live SMS testing is explicitly approved**; all three or none. Without them nobody can sign in, so nobody can check out |

Do **not** set: `EMAIL_PROVIDER=mailpit`, `SMTP_*`, `TRUSTED_PROXY_SECRET` (Cloudflare only), `API_MODE`/`API_BASE_URL`, any production credential.
Preview deployments sit behind Vercel Deployment Protection by default, which also blocks Razorpay and Resend webhooks until a bypass is configured.

## Needed for the preview to build
Nothing is required at build time: with no Supabase variables the build completes (pages are rendered on demand). At runtime the Supabase variables are required.

## Known limit on Vercel
Admin image uploads are temporarily limited to 4 MB (client and server share `lib/upload-limits.ts`) because Vercel Functions reject request bodies above about 4.5 MB. The Storage bucket still allows 5 MB (unchanged). Restoring larger images needs direct-to-Supabase uploads (not implemented).
