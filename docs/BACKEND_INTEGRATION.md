# Backend integration guide

The authoritative contract is [`openapi/openapi.yaml`](../openapi/openapi.yaml) (OpenAPI 3.1, framework-neutral).
The frontend Zod schemas in `lib/api/schemas.ts` mirror it, and `npm test` fails when they drift.
**Nothing here has been implemented as a live endpoint** — these are the requirements for the backend team.

## 1. Wiring it up
1. Implement the endpoints (start with the P0 list below).
2. Set `API_BASE_URL` to the API root (it contains any version prefix: frontend `/api/v1/products` → `GET {API_BASE_URL}/products`).
3. Set `APP_ENV=staging`, `API_MODE=live` on a staging deploy and run through the checklist in §6.
4. Add your payment provider to the CSP (`CSP_EXTRA_*`) and implement the provider case in `lib/payments.ts` (§4).

## 2. Cross-cutting rules
* **Cookies:** customer session, cart token, admin session and CSRF cookies are set by the backend with
  `HttpOnly; Secure; SameSite=Lax; Path=/`. The proxy passes `Set-Cookie` through to the shopper's browser unchanged.
  The admin cookie *name* must equal `ADMIN_SESSION_COOKIE`.
* **CSRF:** `GET /csrf-token` sets cookie `o218_csrf` and returns the same value; every non-GET must send it as `X-CSRF-Token`
  (double submit). Reject mismatches with `403 { error: { code: "csrf_invalid" } }` (the browser refreshes the token once and retries).
* **Errors:** `{ "error": { "code", "message", "fieldErrors"?, "requestId"? } }` with correct HTTP status. `message` is shown to shoppers —
  no internals. Use stable codes (`validation_failed`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
  `out_of_stock`, `coupon_invalid`, `idempotency_key_reuse`, …).
* **Money** is INR in rupees (JSON number). **Never accept** prices, totals, discounts or payment results from the browser.
* **Images / links** returned by the CMS must be site-relative paths or `https://` URLs; anything else fails validation in the UI.
* **Pagination:** list endpoints return `{ items, total, page, pageSize }`. Collection pages currently request `pageSize=200`;
  if a collection can exceed that, extend the pages to paginate (the API already supports `page`).
* **Rate limiting / abuse control** (OTP, login, reviews, leads, newsletter, coupons) is the backend's job — add captcha where needed.
* **Request IDs:** the proxy sends `x-request-id`; echo it in logs and in `error.requestId`.

## 3. Endpoint inventory (what to build)
Priority: **P0** = needed to take orders · **P1** = needed soon after.

| Area | Endpoints | Pri |
|---|---|---|
| Platform | `GET /health`, `GET /csrf-token` | P0 |
| Catalogue | `GET /products`, `/products/{slug}`, `/products/{slug}/related`, `/categories`, `/collections` | P0 |
| Inventory | `GET /inventory/availability` (+ atomic reserve/commit/release inside `POST /orders`) | P0 |
| Delivery | `GET /serviceability?pincode=` (courier-backed; COD + ETA) | P0 |
| Content | `GET /content/storefront`, `GET /content/pages/{slug}` (terms, privacy… must be authored by the business/counsel) | P0 |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/{id}`, `PUT/DELETE /cart/coupon` | P0 |
| Orders | `POST /orders` (idempotent), `GET /orders/{id}` | P0 |
| Payments | provider webhook (backend-only), `POST /payments/{id}/verify` for SDK flows | P0 |
| Customer auth | `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/logout`, `GET /me`, `GET /me/orders` | P0 |
| Reviews | `GET/POST /products/{slug}/reviews` | P1 |
| Marketing | `POST /newsletter/subscriptions` (double opt-in), `POST /leads` | P1 |
| Admin | everything under `/admin/*` (auth, dashboard, products, categories, orders, reviews, leads, content, CSV exports) | P0/P1 |

Out of the contract but required for a real launch: payment-provider webhooks, shipping/AWB + tracking webhooks, transactional
email/SMS, GST invoices, refunds/returns, audit log, image upload (presigned URLs), backups/monitoring.

## 4. Orders & payments (most important section)
`POST /orders` must:
1. Require `Idempotency-Key`. Same key + same body ⇒ return the original response (HTTP 200, no second order); same key + different body ⇒ `422 idempotency_key_reuse`.
2. Re-price the cart, validate address/pincode, **reserve stock atomically**; `409` (`out_of_stock`, `quantity_changed`) if anything changed.
3. Create the order + a payment at the provider. COD: `payment.action = null`, `paymentStatus = cod_pending`, order `confirmed`.
   Online: `paymentStatus = pending`, order `pending_payment`, and `payment.action`:
   * `{ "type": "redirect", "url": "https://…" }` → the browser navigates (already supported), or
   * `{ "type": "sdk", "provider": "razorpay", "payload": {…} }` → add a case in `lib/payments.ts` + a small client adapter that opens the SDK,
     then calls `POST /payments/{id}/verify` with the provider's client result and finally navigates to the confirmation URL.
4. Empty the cart; return `lookupToken` (≥128-bit, scoped to the order).
5. Mark `paid` **only** from the provider's signed webhook (or after verifying the signature in `/payments/{id}/verify`). Release stock on failure/expiry.

`GET /orders/{id}` is readable with `?token=` or by the owning signed-in customer; otherwise return `404`.
The confirmation page polls every 3 s while `paymentStatus` is `pending`/`unpaid` and shows exactly what the server reports.

## 5. Cache invalidation
Server-rendered pages cache API reads. After catalogue/content/review changes call:
```
POST https://<site>/api/revalidate
x-revalidate-secret: <REVALIDATE_SECRET>
{ "tags": ["products", "product:<slug>", "reviews:<slug>", "content", "page:<slug>"] }
```

## 6. Staging acceptance checklist
- [ ] `GET /api/health?deep=1` is 200 (backend `/health` reachable)
- [ ] Browse, search, filter, product pages render real data; unknown slug → real 404
- [ ] Add to bag, change quantity, coupon valid/invalid, free-shipping threshold — totals match the backend
- [ ] Stock: last unit cannot be bought twice; failed/expired payment releases stock
- [ ] COD order and online order end-to-end; double-click/Retry on "Place order" creates one order
- [ ] Payment failure shows "Payment failed" (never "Order placed"); webhook flips pending → paid and the page updates
- [ ] OTP sign-in, order history, wrong/expired/rate-limited codes
- [ ] Review: requires sign-in, pending until moderated, verified-purchase flag correct
- [ ] Admin: login (+MFA if enabled), role limits, product/stock/hero/settings edits appear on the storefront after revalidation
- [ ] Admin session cannot be forged from the browser; customer cookies never grant `/admin/*`
- [ ] Legal pages (`terms`, `privacy`) published → links appear in footer/checkout/login automatically
- [ ] Sitemap lists real products; robots only allows production
