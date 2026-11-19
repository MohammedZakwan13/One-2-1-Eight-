# Order flow — manual QA guide (COD + Mailpit, no client credentials needed)

Everything here runs against the **staging Supabase project** with Cash on delivery and the local **Mailpit** inbox. Nothing is delivered to real customers, and no Resend / Razorpay / MSG91 keys are required.

> **Migration 0005 first.** Cancellation by the customer, returns, refunds and the "Returnable product" switch need `supabase/migrations/0005_returns_cancellation.sql` (section 0). Until it is applied the app answers `503 migration_required` for those actions (nothing breaks, nothing is silently dropped). Everything else in this guide works without it.

## 0. One-time setup

1. **Apply migration 0005** — Supabase Dashboard → SQL Editor → paste the whole file → Run. It is additive and safe to run twice. Then record it:
   ```sql
   insert into supabase_migrations.schema_migrations (version, name) values ('0005','returns_cancellation') on conflict (version) do nothing;
   ```
   Verify (all should return rows / `true`):
   ```sql
   select column_name from information_schema.columns where table_schema='public' and table_name='products' and column_name='returnable';
   select count(*) = 4 as tables_ok from information_schema.tables where table_schema='public' and table_name in ('returns','return_items','return_history','refunds');
   select proname from pg_proc where proname in ('cancel_order_customer','create_return','process_return');
   ```
2. **Return window** — `store_settings.return_window_days` defaults to **7 days after delivery** (matches the old "7-day returns" text). This is a business decision: change it in the Table Editor if the client's policy differs.
3. **Start Mailpit + the app (PowerShell, project folder):**
   ```powershell
   $env:EMAIL_PROVIDER = 'mailpit'
   docker compose up --build -d          # app on http://localhost:3001, Mailpit inbox on http://localhost:8025
   docker compose ps                     # both services Up
   docker compose logs -f web            # app logs
   docker compose stop mailpit           # stop only Mailpit (orders still work; emails are logged as failed, never lost silently)
   docker compose down                   # stop everything
   ```
   Running the dev server instead (`npm run dev`, http://localhost:3000)? Start Mailpit alone with `docker compose up -d mailpit` and put `EMAIL_PROVIDER=mailpit` in `.env.local` (SMTP defaults to `localhost:1025`). Mailpit mode is refused when `APP_ENV=production`.
4. **Which instance am I testing?** Swagger shows the host that served it: `http://localhost:3001/docs` (Docker) or `http://localhost:3000/docs` (dev server). Use one of them consistently.

## 1. State model (server-enforced)

| From | Allowed next |
| --- | --- |
| pending_payment | cancelled |
| confirmed | processing, cancelled |
| processing | packed, cancelled |
| packed | shipped, cancelled |
| shipped | delivered |
| delivered | refunded (legacy manual) — returns use their own track |

Rules: cancelling restores stock **once**; **COD becomes `paid` only on Delivered**; shipping/delivery never marks an online order paid; cancelling a *paid* order creates a **pending** refund (never "completed"); a COD order cancelled before delivery has no refund.
**Customer cancel:** only before Shipped. **Returns:** only after Delivered, inside the window, for items whose purchase-time snapshot says returnable.

| Return status | Allowed next | Stock / money |
| --- | --- | --- |
| requested | approved, rejected | none |
| approved | received | none (item not back yet) |
| received | refund_pending, completed | stock +qty **only** if admin chose "put back in stock", once |
| refund_pending | completed | refund row = pending |
| completed | — | refund = completed **only** with a reference you type |

Shipping details are optional in the admin dialog (decision: some orders are hand-delivered). The customer page shows only what you stored; no live carrier scans are claimed.

## 2. Administrator tests

Sign in at `/admin/login` (your existing owner account).

| # | Do this | Expect |
| --- | --- | --- |
| A1 | **Products → New product.** Name `QA Tee`, price 499, status **Active**, sizes M=3, S=1, tick **Returnable product**, Save. Reopen it. | Values persist, including the Returnable tick. Untick it, save, reopen → stays off (needs 0005; before 0005 you get a clear "needs migration" message). Stock figures unchanged by the toggle. |
| A2 | Place a customer order (section 3). Open **Orders**. | Row shows order number, **name and "+91 mobile"**, amount, payment (Pay on delivery state `Cod Pending`), status `Confirmed`. Older orders without a number show "Mobile not recorded". |
| A3 | Click **Details** on the row. | Customer, mobile, e-mail, delivery address, items (size × qty), payment, history timeline. |
| A4 | Status dropdown: choose **Processing**, then **Packed**. | Each saves; refresh the page → still saved. The dropdown only offers valid next states. A Packed e-mail arrives in Mailpit. |
| A5 | Choose **Shipped** → enter courier `BlueDart`, tracking `QA123`. | Saved; Shipped e-mail has courier + tracking + tracking link. |
| A6 | Choose **Delivered**. | Payment becomes **Paid** (COD collected). Delivered e-mail sent once. |
| A7 | Cancel test: place a second order, choose **Cancelled** in the dropdown (confirm dialog). | Stock for that size goes back **once**; payment stays unpaid; no refund is invented for COD. A second attempt does nothing. |
| A8 | **Returns** (second table on the Orders page): after the customer requests (section 3, C10), use **Approved**. | Status changes; **stock is NOT changed**. |
| A9 | Click **Received** → dialog → "Received, put back in stock". | Stock for that size rises by the returned quantity, once. |
| A10 | Click **Refund Pending**, then **Completed** with a reference such as `UTR-QA-1`. | Completing without a reference is refused. The refund shows `Completed (UTR-QA-1)` only after you enter it. |
| A11 | A rejected return: request another, click **Rejected**. | No stock change; the customer sees "not approved" and may re-request. |
| A12 | Dashboard → low-stock numbers. | Reflect real size stock only; the product's stock message text never affects them. |

Errors: a failed action keeps the dialog open with the message and changes nothing.

## 3. Customer tests (signed-in customer; checkout requires MSG91 OTP sign-in — guest cases are in the checkout sign-in section at the end)

Use `http://localhost:3001` (or :3000).

| # | Do this | Expect |
| --- | --- | --- |
| C1 | Open the storefront, find **QA Tee** (card shows its stock message if set). | Visible only while Active. |
| C2 | Pick size M, quantity 1, **Add to bag**, open the bag, **Checkout**. | Bag totals are computed by the server. |
| C3 | Fill name, **mobile (10 digits starting 6–9)**, e-mail, address with pincode `560001`, choose **Cash on delivery**, accept terms, **Place order**. | Missing/invalid mobile is rejected. |
| C4 | Confirmation page. | Order number, total, "Pay on delivery". Refreshing the page does **not** create another order. |
| C5 | Open **http://localhost:8025**. | Confirmation e-mail for that order with number, items, total and a **View or track your order** link. |
| C6 | Click that link in a **private window**. | The same order opens (tracking with the secure token link works without signing in again; closing the browser does not lose it). A link with a changed token shows "order not found". |
| C7 | Admin moves the order along (A4–A6); reload the tracking page. | Timeline, courier and tracking number match the admin's saved state. The page also refreshes itself every 30 s. |
| C8 | **Allowed cancellation:** on a fresh Confirmed order press **CANCEL ORDER**, type a reason, **YES, CANCEL ORDER**. | Order shows Cancelled; stock restored once; cancellation e-mail in Mailpit. (Needs 0005.) |
| C9 | **Prohibited cancellation:** on a Shipped or Delivered order. | No cancel button; a note explains it. Calling the API directly returns 409 `not_cancellable`. |
| C10 | **Return:** on a Delivered order press **RETURN ITEMS**, pick quantity, reason, submit. | Return number shown; "Return request received" e-mail; status follows admin steps A8–A10 on the same page. (Needs 0005.) |
| C11 | **Non-returnable:** untick Returnable on a product, buy it, deliver it. | The product page says "Non-returnable item"; the order page lists it under "Not returnable" and offers no return; the API answers 409 `not_returnable`. Re-ticking the product later does **not** make the old purchase returnable. |
| C12 | Return window: set an order's `delivered_at` back > window days (Table Editor, **QA orders only**). | "The return window has closed"; API 409 `return_window_closed`. |
| C13 | Signed-in customers (needs MSG91): **Account → View order** lists only that customer's orders. | Not testable without SMS keys — **Blocked**. |

## 4. Mailpit

- Inbox: **http://localhost:8025**, SMTP `localhost:1025`, local only (ports bound to 127.0.0.1).
- Real application actions trigger the mails: placed (C3), packed/shipped/delivered (A4–A6), cancelled (A7/C8), return requested/approved/rejected/received/refund pending/completed (C10, A8–A11).
- **No duplicates:** repeat a status change or refresh the confirmation page — still one message per event (`email_log.dedupe_key`).
- **Controlled failure:** `docker compose stop mailpit`, place an order → the order still succeeds; `select status, error from email_log order by created_at desc limit 3;` shows `failed` / "Mailpit unreachable". Start Mailpit again; the next status e-mail for that order sends normally.
- What Mailpit proves: the message was **generated and accepted by the local SMTP server**. It does **not** prove delivery to a real inbox; `email_log.status = 'accepted'` with a `mailpit:` id means exactly that. Only a Resend webhook can set `delivered`.
- Mailpit data is in memory: `docker compose restart mailpit` clears the inbox.

## 5. Swagger (`http://localhost:3001/docs` or `:3000/docs`)

Cookie/CSRF convention: Swagger's `init.js` calls `GET /api/v1/csrf-token` first and adds `X-CSRF-Token` plus the `o218_csrf` cookie automatically. Guests identify an order with `?token=<tracking token>` (from the confirmation response `lookupToken` or the e-mail link); admin calls need the `o218_admin_session` cookie, which you get by signing in at `/admin/login` in the **same browser** (do not paste cookies anywhere).

| Endpoint | Auth | Body / params | Success | Failure test | Verify in |
| --- | --- | --- | --- | --- | --- |
| `POST /cart/items` | none (cart cookie) | `{ "variantId": "<id>", "quantity": 1 }` | 200 cart | unknown variant → 4xx | Bag page |
| `POST /orders` | none; header **`Idempotency-Key`** (8–128 chars) | `{ "contact": { "name": "QA", "phone": "9876543210", "email": "qa@qa.invalid" }, "shippingAddress": { "line1": "1 QA Road", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001" }, "paymentMethod": "cod", "acceptedTerms": true }` | 201 `{ order, payment, lookupToken }` | phone `12345` → 422; reuse key with a different body → 422 | Admin Orders, Table Editor `orders`, Mailpit |
| `GET /orders/{id}?token=` | token or owning customer | — | 200 order incl. `history`, `shipment`, `cancellable`, `returns` | wrong token → 404 | Tracking page |
| `POST /orders/{id}/cancel?token=` | token/customer + CSRF | `{ "reason": "changed my mind" }` | 200, `status: cancelled` | after Shipped → 409 `not_cancellable` | Stock, Mailpit |
| `POST /orders/{id}/returns?token=` | token/customer + CSRF | `{ "reason": "does not fit", "items": [{ "orderItemId": "<lines[].id>", "quantity": 1 }] }` | 201 return | before Delivered → 409 `return_not_allowed`; too many units → 409 `quantity_exceeded` | Admin → Returns |
| `GET /admin/orders` | admin | — | 200 list with `contact.phone` | no session → 401 | Admin Orders |
| `PATCH /admin/orders/{id}/status` | admin + CSRF | `{ "status": "shipped", "carrier": "BlueDart", "trackingNumber": "QA123" }` | 200 order | `confirmed → delivered` → 409 `invalid_transition` | Tracking page |
| `GET /admin/returns` | admin | — | 200 list | no session → 401 | Admin Returns table |
| `PATCH /admin/returns/{id}` | admin + CSRF | `{ "status": "received", "restock": true }` · `{ "status": "completed", "refundReference": "UTR-QA-1" }` | 200 return | `completed` without reference → 422 `refund_reference_required`; skipping steps → 409 | Stock, refund row |

## 6. Test tracker (mark each: Pass / Fail / Blocked / Not yet tested)

Legend: **Pass** = behaved as expected · **Fail** = deviated (note what) · **Blocked** = cannot run (reason, e.g. needs 0005, Razorpay, MSG91, Resend) · **Not yet tested**.

| Area | Scenario | Result |
| --- | --- | --- |
| Local automated | `npm test` (69), typecheck, lint | |
| Local automated | `bash supabase/tests/db-orders-returns.sh` (35 DB checks, disposable Postgres) | |
| Staging API | Order placement, idempotency, concurrency, transitions, tracking, e-mails (scripted) | |
| Browser | A1–A12 | |
| Browser | C1–C12 | |
| Mailpit | Confirmation, packed, shipped, delivered, cancelled, return e-mails, no duplicates, controlled failure | |
| Provider (needs client keys) | Resend real delivery + webhook events | Blocked |
| Provider (needs client keys) | Razorpay order/verify/webhook/refund | Blocked |
| Provider (needs client keys) | MSG91 sign-in, signed-in order history | Blocked |

**Cleanup:** QA data = products/orders whose names or slugs start with `QA`. Delete orders first (Table Editor → `orders` → delete row; items cascade), then the QA product. Never delete the real `go-high` product or pre-existing orders. Clear Mailpit with `docker compose restart mailpit`.

## 7. Switching to real Resend later

1. Verify the sending domain in Resend; create an API key.
2. In the host's secrets / `.env.local`: `RESEND_API_KEY`, `EMAIL_FROM` (verified sender), `INTERNAL_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`; **remove** `EMAIL_PROVIDER=mailpit` (or set `resend`).
3. Resend → Webhooks → `https://<site>/api/webhooks/resend` (delivered, bounced, complained, failed).
4. Place one COD order and check `email_log.status` moves `accepted` → `delivered`. No code or template changes are needed.

## Checkout requires sign-in (MSG91 OTP) — no guest checkout

Enforced twice: the `/checkout` page (server-side session check, redirect to `/login?returnTo=%2Fcheckout`) and the API (`POST /orders` and `POST /payments/:id/verify` answer 401 without a valid customer session, before touching the cart, stock, orders or payments). The cart lives in the `o218_cart` cookie, which signing in never touches, so it survives the login round trip. Razorpay's server-to-server webhook is unchanged (signature-verified, no customer session).

Use an Incognito window on the staging/tunnel URL. Create no real orders as a guest; every guest case below must end without one. Each OTP sign-in uses one of the 3 sends per phone per 10 minutes.

### A. Guest cases (signed out; DevTools → Network, Preserve log)
| # | Action | Expected |
|---|---|---|
| G1 | Open `/checkout` directly | 307 to `/login?returnTo=%2Fcheckout`; the delivery form never renders |
| G2 | Add a product (pick a size), open the bag, press CONTINUE TO CHECKOUT | Lands on `/login?returnTo=%2Fcheckout` |
| G3 | On a product page choose a size, press Buy now | Item is added, then lands on `/login?returnTo=%2Fcheckout` |
| G4 | In the Console: `fetch('/api/v1/orders', {method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:'{}'})` | 403 `csrf_invalid` (no CSRF token) — still no order. With a valid CSRF token and body: **401** `unauthorized` |
| G5 | Open `/login?returnTo=https://evil.example`, `//evil.example`, `/login` | Plain login page; after signing in you go to `/account`, never off-site, no redirect loop |
| G6 | Sign in from the G2/G3 login page | Redirected to `/checkout` (not `/account`); bag still has the same items, sizes and quantities; totals recalculated by the server |
| G7 | After G6, check the Admin → Orders list | No order exists from the guest attempts |

### B. Signed-in customer cases
| # | Action | Expected |
|---|---|---|
| C1 | Open `/checkout` with items in the bag | Checkout form renders (brief "Loading checkout…" first), no redirect |
| C2 | Open `/login?returnTo=%2Fcheckout` while signed in | Goes straight to `/checkout` once (no loop) |
| C3 | Place a Cash on delivery order | 201, confirmation page, stock decremented once, order is linked to the customer (`/me/orders`) |
| C4 | Online payment (Razorpay test keys), then confirm | `POST /payments/:id/verify` 200 for the order's owner; Razorpay webhook still settles independently |
| C5 | Delete the `o218_session` cookie (or sign out in another tab), then press Place order | 401, redirected to `/login?returnTo=%2Fcheckout`, bag intact, no order created |
| C6 | Product reviews (write a review while signed out / signed in) | Behaviour unchanged from before: sign-in prompt when signed out, works when signed in |

Safe diagnostics in the dev terminal: `[otp] reason=verified …` for the sign-in; none for a rejected guest order (the 401 is answered before any database work).
