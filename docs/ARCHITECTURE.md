# Architecture

## Repository layout

```
app/
  layout.tsx                 root: next/font, validated env, providers, indexing policy
  (storefront)/              public shop; layout fetches CMS data once, renders header/footer/splash shell
    page.tsx · collections/[slug] · products/[slug] · bag · wishlist · search · login · account
    checkout · order-confirmation · policies/returns · policies/[slug] (CMS legal pages) · size-guide
    [...rest] + not-found.tsx  real HTTP 404 inside the branded shell
  admin/                     ISOLATED admin area (own layout, never indexed)
    login/                   public sign-in
    (console)/               server-guarded: layout asks the backend to validate the session
  api/v1/[...path]/route.ts  same-origin proxy to the backend (+ uploads/, openapi.json)
  api/health · api/revalidate
  sitemap.ts · robots.ts     generated from live API data / environment
components/ ui · storefront (+ pages/) · admin · providers
lib/
  env.ts                     validated server config (fails fast on unsafe combos)
  api/                       schemas.ts (Zod contract) · http.ts (caller) · *-transport.ts · repositories/ · client.ts · server.ts
  hooks/ · catalog.ts · payments.ts · site.ts · security-headers.ts · admin-gate.ts
lib/backend/                 Supabase-backed implementation of the contract
openapi/openapi.yaml         the contract for the backend team
middleware.ts                /admin edge gate (cookie present?) + noindex/no-store
tests/unit · tests/e2e
```

## Data flow

* **Server Components** (`lib/api/server.ts`) call the backend directly using `API_BASE_URL`. Catalogue/content
  reads are cached by Next's data cache (`revalidate` 60–3600 s) with tags (`products`, `product:<slug>`,
  `reviews:<slug>`, `content`, `page:<slug>`). The backend purges them via `POST /api/revalidate`.
* **Client Components** (`lib/api/client.ts`) call `/api/v1/*`. The proxy validates the path, enforces
  same-origin for writes, limits body size, forwards only an allow-list of headers, passes `Set-Cookie` through,
  maps upstream failures to safe JSON errors and always responds `no-store`.
* Every response is parsed with the Zod schema for that endpoint (`lib/api/schemas.ts`); a contract mismatch is an
  error, not silently-wrong UI.
* GETs retry (2×, linear backoff) on network/5xx; writes are **never** retried automatically.
* Storefront layouts use `connection()` so `next build` never needs the backend; data caching still applies per fetch.

## What is server-authoritative (and therefore removed from the browser)

| Concern | Before (prototype) | Now |
|---|---|---|
| Prices, discounts, shipping, totals | computed in the browser from `localStorage` | returned by `GET /cart`; checkout sends **no amounts** |
| Coupons | hard-coded in client code | `PUT /cart/coupon`, rules live server-side |
| Stock | single number, never decremented | per-size variants, availability from API, capped in cart, reserved by `POST /orders` |
| Orders | random id written to `localStorage` | `POST /orders` with mandatory `Idempotency-Key`; confirmation reads `GET /orders/{id}` |
| Payment status | "success" assumed | only `paymentStatus` from the server (set by verified provider events) |
| Customer login and checkout access | any 6 digits; checkout open to anyone | SMS OTP through the MSG91 widget, verified server-side before a session is created; HttpOnly session cookie, `GET /me`; **checkout requires a signed-in customer** (server-guarded page, `POST /orders` answers 401 to guests) |
| Admin auth | password in the JS bundle, flag in `localStorage` | backend session cookie, validated server-side on every `/admin` request |
| Reviews | hard-coded counts, sample reviews, auto-publish | API; sign-in required; moderated; real aggregates; verified-purchase from server |
| Pincode check | any 6 digits = "available" | `GET /serviceability` |
| Dashboard metrics | fabricated trends/chart | `GET /admin/dashboard/summary` (nulls are hidden, never invented) |
| SEO metadata / JSON-LD / sitemap | static seed data, `.example` domain | built from live API data and `NEXT_PUBLIC_SITE_URL` |

Only the guest **wishlist** (a non-sensitive preference) stays in `localStorage`; product data for it is fetched by id.

## Security controls

* Strict env validation; placeholder/non-HTTPS production URLs rejected.
* CSP + HSTS + X-Frame-Options + nosniff + Referrer/Permissions-Policy (`lib/security-headers.ts`, extendable via `CSP_EXTRA_*`).
* CSRF: double-submit token (`GET /csrf-token`) on every write; proxy additionally rejects cross-origin writes.
* Open-redirect-safe admin `next` parameter; proxy path-traversal guard; 1 MB body cap.
* CMS-controlled URLs (images, links) must be site-relative or `https://` (`javascript:`/`data:` rejected); CMS text is rendered as text, never HTML; JSON-LD escapes `<`.
* Admin pages `noindex`, `no-store`; errors never print stack traces (digest reference only).
* No secrets in source: `.env*` ignored except `.env.example` (placeholders).

## Backend (Supabase)

`lib/backend/` implements the REST contract inside the Next.js server: `core.ts` (routing, CSRF, rate limits, storage paths),
`routes/storefront.ts` and `routes/admin.ts` (handlers), `data.ts` (mapping + cart pricing), `auth.ts` (sessions/roles),
`integrations.ts` (Resend, Razorpay, MSG91). Server Components call it in-process; browsers use the same-origin proxy.
Stock, orders and payments change only through Postgres functions in `supabase/migrations/0002_backend_features.sql`
(row-locked, transactional). RLS is enabled with no policies, so only the server (service-role key) can touch data.
See docs/SETUP.md and docs/API_TESTING.md.