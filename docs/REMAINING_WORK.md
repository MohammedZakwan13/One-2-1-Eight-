# Remaining work before a real launch

The frontend is integration-ready. The items below cannot be done in this repository alone.

## A. Blockers (need other teams / credentials)

| # | Item | Needs | Where it plugs in |
|---|---|---|---|
| 1 | **Backend + database** implementing `openapi/openapi.yaml` (catalogue, cart, orders, inventory, reviews, content, leads, newsletter, admin) | Backend team | `API_BASE_URL` |
| 2 | **Payment provider** (e.g. Razorpay / Cashfree / PhonePe): create payment, hosted redirect or SDK, signed webhooks, refunds | Provider account + credentials (server-side only) | Backend; frontend adapter in `lib/payments.ts` (`unsupported` branch) + `CSP_EXTRA_*` |
| 3 | **Customer OTP / SMS** (DLT-registered templates, rate limits, captcha) | SMS provider | `POST /auth/otp/*` |
| 4 | **Admin authentication** (hashed passwords, MFA, roles, lockout, audit log) | Backend | `POST /admin/auth/*`; cookie name = `ADMIN_SESSION_COOKIE` |
| 5 | **Shipping / courier** (serviceability, AWB, tracking webhooks) | Courier aggregator | `GET /serviceability`, order status updates |
| 6 | **Transactional email/SMS, GST invoices, returns/refunds flow** | Backend + accounting | Backend |
| 7 | **Legal & compliance content**: Terms, Privacy (DPDP Act), seller/GSTIN/grievance-officer details (Consumer Protection E-Commerce Rules), cookie consent if analytics are added, real returns/shipping policy | Business + counsel | `GET /content/pages/terms|privacy` (links appear automatically once published); `returnPolicy` in settings |
| 8 | **Production domain & deployment secrets** (`NEXT_PUBLIC_SITE_URL`, `API_BASE_URL`, `REVALIDATE_SECRET`, CSP origins) | DevOps | Vercel env / Docker build args |
| 9 | **Real catalogue & media**: approved products, per-size stock, owned/licensed images on a CDN, approved size charts | Business | Backend/CMS |
| 10 | **Backups, monitoring, alerting** (errors, 5xx, payment-webhook failures), WAF/rate limiting at the edge | DevOps | Infra |

## B. Frontend follow-ups (known, deliberately not done or not verifiable here)

* **Payment SDK adapter** — redirect flows work; SDK flows (`payment.action.type = "sdk"`) show a clear "payment method not available" message until a provider case is added (see BACKEND_INTEGRATION §4). No fake success path exists.
* **Placeholder content kept for design fidelity** (approve or replace before launch):
  * Size-guide tables (same illustrative measurements for every garment) — shown to shoppers in production; supply approved per-category charts.
  * Static marketing claims in the approved copy: "Secure checkout", "7-day easy returns", "Complimentary shipping over ₹1,499" (menu/home/bag — the *amount* in several places is hard-coded text, not the CMS threshold), "+ curated colours" on product cards, footer payment labels "UPI · VISA · MASTERCARD".
  * Footer Instagram/WhatsApp icons now appear only when set in CMS settings (otherwise hidden).
  * Category tiles: the prototype hid *Track Pant* and *Joggers* tiles by code. Visibility is now data-driven (`active` flag) — set it in the CMS to match the intended storefront.
* **Collections**: the server returns up to 200 products per collection and sorting/filtering runs client-side (preserves the approved UX). Large catalogues should move filters to API query parameters (the endpoint already supports `category`, `collection`, `q`, `sort`, `page`).
* **Wishlist** is per-browser (localStorage); account-synced wishlist needs an API.
* **Admin gaps vs. a full OMS/CMS**: image upload (URLs only), order detail/refund/shipment screens, coupon management, customer management, roles UI, audit log viewer, CSV import. The contract and UI cover the screens that existed in the prototype.
* **Splash screen** (approved) delays first paint of content by ~2.75 s (1.2 s with reduced motion). Consider skipping it for returning visitors if Core Web Vitals require.
* **Accessibility**: header icon links now have accessible names, overlays close on Escape, size buttons expose state. Still to do: focus trap in the side menu/search/size-guide dialogs, a pause control for the auto-advancing hero, field-level (`aria-describedby`) form errors, and a full audit with assistive technology.
* **Images**: shipped `<img>` + pre-optimised WebP (no `next/image`) because CMS image hosts are unknown. Serve through a CDN with explicit dimensions, or allow-list hosts and adopt `next/image`.
* **Analytics / consent / error tracking** (e.g. Sentry, GA4 behind consent) are not wired.
* **Upgrade path**: stays on Next.js **15.5.28** (latest 15.x). `npm audit` flagged a PostCSS advisory bundled inside Next ≤ 16.3; it is resolved here by an npm `overrides` pin (`postcss@8.5.31`, build verified). Plan a deliberate Next 16 upgrade later and then drop the override.

## C. Not verified in this environment
* Lighthouse / Core Web Vitals, manual device matrix, screen-reader testing.
* A real Vercel deployment and a real backend (none exists). Docker image builds and starts in live mode; it was not run against a backend.
* Load / security (pen) testing.

## D. Repository housekeeping for you to decide
* Nothing is staged or committed. When you commit: `git rm --cached tsconfig.tsbuildinfo` (it is a build artefact; now git-ignored and relocated to `.next/cache`).
* The clone's `origin` remote was removed on purpose so nothing can be pushed by accident; add your remote when ready.
* Test-only mock credentials appear in `playwright.config.ts` and the CI workflow. They only work against the in-memory mock and are ignored in live mode.
