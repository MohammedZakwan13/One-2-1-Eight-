# Setup — local, Docker and manual steps

Target: hosted Supabase project **one2oneight-staging** (ref `ouvkqdubunymmzwzkkip`, Mumbai). Nothing is deployed anywhere else.

## 1. Required before local use

| # | Step | Where | Variable / command |
| --- | --- | --- | --- |
| 1 | Copy API keys | Supabase Dashboard → Project Settings → API Keys | `SUPABASE_SERVICE_ROLE_KEY` (secret), `SUPABASE_ANON_KEY` (publishable) in `.env.local` |
| 2 | Apply the database schema | Dashboard → SQL Editor → paste & run **in order**: `supabase/migrations/0001_init.sql`, `0002_backend_features.sql`, then `supabase/seed.sql` | or `npx supabase db push --db-url "postgresql://postgres.<ref>:<DB-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"` |
| 3 | Create the first admin | terminal | `ADMIN_PASSWORD='long-password' npm run admin:create -- you@company.com "Your Name" owner` |
| 4 | Fill real store details | `/admin/settings` | contact e-mail/phone (seed uses `care@example.com`), return policy, shipping fee, low-stock threshold |
| 5 | Add products | `/admin/products` | upload images, set stock per size |
| 6 | Write legal pages | `/admin/settings` → Legal pages | `terms`, `privacy` (linked from checkout/footer once published) |

**Later migrations** (run each once in the SQL Editor, then record it in `supabase_migrations.schema_migrations`): `0003_service_role_grants.sql` (applied) and `0004_stock_message.sql` — adds the free-text stock message column; until it is applied, saving a non-empty stock message returns a clear 503 `migration_required` instead of dropping the text. `0005_returns_cancellation.sql` adds product returnability, customer cancellation, returns and refunds (see `docs/ORDER_FLOW_MANUAL_QA.md`); until applied those actions return 503 `migration_required`.

**Free e-mail testing:** `EMAIL_PROVIDER=mailpit` + `docker compose up -d mailpit` captures every order e-mail at http://localhost:8025 (no Resend key needed).

`seed.sql` inserts only store settings, the 8 category tiles, the 3 homepage banners (existing files in `public/images`) and a default delivery rule. It adds **no** products, customers, orders or reviews.

Coupons (`public.coupons`) and delivery rules (`public.pincode_rules`) are edited in Dashboard → Table Editor (no admin screen yet).

## 2. Run

```bash
npm run dev                         # http://localhost:3000
docker compose up --build -d        # http://localhost:3001 — reads .env.local at run time; nothing secret enters the image
docker compose logs -f web          # logs
docker compose down                 # stop
```

Health: `/api/health` (liveness) · `/api/health?deep=1` (also checks the database).

## 3. Required before live e-mail / payments / SMS (optional until then)

| Feature | Without it | Steps | Variables |
| --- | --- | --- | --- |
| **Resend** (order/lead e-mails) | Orders & leads still save; e-mails logged as `skipped_unconfigured` | resend.com → verify sending domain → API key; Webhooks → add `{SITE}/api/webhooks/resend` (events delivered, bounced, complained, failed) | `RESEND_API_KEY`, `EMAIL_FROM`, `INTERNAL_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET` |
| **Razorpay** (UPI/card) | Only Cash on delivery is offered | Razorpay Dashboard → test keys; Settings → Webhooks → `{SITE}/api/webhooks/razorpay` (events `payment.captured`, `order.paid`) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| **MSG91** (customer SMS sign-in) | No customer sign-in, so checkout is unavailable (checkout, wishlist, reviews and account all need sign-in) | MSG91 dashboard → OTP → Widget (Web SDK, custom UI, SMS, India); copy `widgetId` and `tokenAuth` from the generated code, and the dedicated website Authkey | `MSG91_AUTH_KEY`, `MSG91_WIDGET_ID`, `MSG91_WIDGET_TOKEN_AUTH` |
| pg_cron (auto-release unpaid online orders after 60 min) | Held stock is not released automatically | Dashboard → Database → Extensions → enable `pg_cron`, re-run the last block of `0001_init.sql` | — |

Webhook URLs must be public HTTPS (use a tunnel such as ngrok for local testing).

## 4. Before a future deployment

Set `APP_ENV=production`, a real https `NEXT_PUBLIC_SITE_URL`, all variables above in the host's secret store; keep `ENABLE_API_DOCS` unset (Swagger is then off) or protect it. Rotate any key that was ever pasted into chat or committed.
