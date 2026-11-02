# Implementation and QA record — branch `feature/supabase-api`

## Audit findings (before)
* The storefront and Admin called one REST contract (`lib/api/schemas.ts`, `openapi/openapi.yaml`); in practice `mocks/` answered it with
  in-memory seed data (fake orders, products, OTP code, coupons, payment gateway page, "DEV MOCK API" banner). No persistence, no real auth.
* `supabase/` held only CLI config; no schema existed. Admin image field was a URL textarea. Stock display had no real source.

## Architecture chosen
Backend inside the existing Next.js server (`lib/backend/*`), same `/api/v1` path, Supabase Postgres/Auth/Storage via the server-only service-role
key. No second service was needed. Server Components dispatch in-process; browsers use the same-origin proxy (CSRF + origin checks).
Stock/orders/payments change only through row-locking Postgres functions. RLS is on with **no policies** (anon/authenticated can read/write nothing).

## Changes
* **Removed:** `mocks/`, mock payment page/route, mock env vars/mode, "DEV MOCK" UI, mock unit tests and the mock-driven Playwright suite (`git rm`, recoverable from history).
* **Added:** migrations `0001_init.sql`, `0002_backend_features.sql`, `seed.sql` (settings, categories, banners, delivery rule only — no demo products/orders);
  `lib/backend/*`; webhooks `/api/webhooks/{razorpay,resend}`; Swagger UI `/docs`; `/api/v1/openapi.json`; image uploader; legal-pages editor; tracking prompts on shipping;
  low-stock list; stock-message setting; Razorpay checkout launcher; server-side wishlist sync; Docker/compose; `scripts/{create-admin,smoke}.mjs`; `supabase/tests/db-functions.sh`.
* **Stock display (decision):** the earlier idea of showing an admin-entered "duplicate/hype" stock number was **not** implemented — showing counts that are not real is a
  deceptive urgency pattern and contradicts the brief. Admin picks per product: availability only / exact real count / "Only N left" when low. Dashboard low-stock always uses real stock and the threshold in Store & SEO.

## QA evidence
| Check | Command / scenario | Result |
| --- | --- | --- |
| Lint | `npm run lint` | **Pass** (0 warnings) |
| Types | `npm run typecheck` | **Pass** |
| Unit + contract | `npm test` | **Pass** — 59 tests (env guards, proxy/CSRF/CSV security, upload magic-byte checks, stock-display rules, Razorpay/Resend signature checks, e-mail escaping, route table ⇄ OpenAPI ⇄ frontend repositories) |
| Production build | `npm run build` | **Pass** (3 storefront pages log "backend not configured" while prerendering without keys; non-fatal) |
| Compose config | `docker compose config -q` | **Pass** |
| Image build | `docker compose build` | **Pass** (339 MB, non-root, Node 22) |
| Container run | image on :3101 with placeholder keys | **Pass** — healthy; `/api/health`, `/docs`, `/api/v1/openapi.json`, Swagger assets 200 |
| Swagger/OpenAPI | dev server :3100 and container | **Pass** — `/docs` 200, OpenAPI 3.1 JSON served, 56 paths |
| HTTP gates | curl | **Pass** — write without CSRF 403; invalid body 422 with field errors; anonymous admin 401; unknown path 404; wrong method 405 |
| DB schema | migrations + seed applied to a throwaway local Postgres 17 | **Pass** (0001, 0002, seed; only the expected pg_cron notice) |
| DB business logic | `supabase/tests/db-functions.sh` on that Postgres | **Pass 35/35** — per-size stock save/audit, atomic order, price-change refusal, **8 concurrent buyers for 3 units → exactly 3 succeed, stock never negative**, invalid transitions refused, shipped ≠ paid, COD delivered → paid, cancel restores stock once, replayed payment webhook is a no-op, stale unpaid order release, dashboard from real stock, anon role denied on functions/tables |
| **Migrations on Supabase staging** | applied by the owner in the SQL Editor: 0001, 0002, seed, 0003 (service_role grants) | **Pass** — 30 tables, seed counts and migration history verified; `service_role` access verified via API; `0003` added after the first run hit `permission denied for table` |
| Admin account | `npm run admin:create` | **Pass** — Auth user + matching `admin_users` owner row verified read-only |
| Smoke, public/security part | `BASE_URL=http://localhost:3001 npm run smoke` | **Pass 14/14** against the Docker container and the real database |
| Failure mode | container with an invalid service key | **Pass** — API 500 `server_error`, `/ready` 503, deep health 503, home page 500; no sample data shown |
| Full smoke (admin flow: upload, product, stock, orders, concurrency, tracking, leads) | needs the admin password typed by the owner | **Pending** — run the PowerShell command in docs/API_TESTING.md |
| Image upload to Storage, Resend delivery, Razorpay payment, MSG91 SMS, browser UI walkthrough with data | — | **Not run** (credentials/data absent). Code paths are implemented and unit-tested only where marked above |

## Blockers / next actions
1. Put `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` in `.env.local`; apply the three SQL files (SQL Editor) — SETUP.md §1.
2. `ADMIN_PASSWORD=… npm run admin:create -- you@company.com "Name" owner`.
3. `SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run smoke` (set `SUPABASE_*` too for cleanup) and walk the admin UI once.
4. Resend / Razorpay / MSG91 when ready (SETUP.md §3).
Do not call the app production-ready until steps 1–3 pass and a payment sandbox test is done.
