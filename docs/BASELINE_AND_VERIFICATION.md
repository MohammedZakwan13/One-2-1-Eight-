# Baseline audit & verification record

## Phase 1 — baseline of the prototype (commit `a609b5c`, measured in a separate clone)

| Check | Result |
|---|---|
| `npm ci` | OK; `npm audit`: 2 advisories (PostCSS bundled in Next ≤ 16.3: 1 high, 1 moderate) |
| `tsc --noEmit` | pass |
| `next build` (Next 15.5.28) | pass; single route `/[[...slug]]` 144 kB first-load, admin code + credentials shipped to every visitor |
| Lint / tests | none existed (`next lint` had no ESLint config) |

Findings that drove the refactor (full list in the earlier audit): no backend/DB; state in `localStorage`; hard-coded
client-side admin credentials; fake OTP; client-computed prices; coupon discount lost between bag and checkout; no stock model;
fabricated reviews/metrics; unknown product slug rendered the first product; soft-404s; `.example` domain in SEO output; search
ignoring `?q=`; header icon links with no accessible name; category rename emptied collections.

## Phase 6 — results after the refactor (all executed, final run)

| Check | Result |
|---|---|
| `npm run lint` (`--max-warnings=0`) | **pass** |
| `npm run typecheck` | **pass** |
| `npm test` (Vitest) | **73 / 73 passed** (6 files) |
| `npm run build` (test/mock config) | **pass** (Next 15.5.28) |
| `npx playwright test` (Chromium: 25 desktop + 9 mobile) | **34 / 34 passed** against a production build |
| `npm audit` | **0 vulnerabilities** (PostCSS override, see REMAINING_WORK) |
| Production guard: `APP_ENV=production API_MODE=mock next build` | **fails by design** (`API_MODE=mock is only permitted…`) |
| Docker image (`APP_ENV=staging`, live mode, unreachable backend) | builds; `/api/health` 200; `/api/health?deep=1` 503 |

### What the automated tests cover
* **Env safety:** mock never allowed in staging/production; placeholder / non-https production URLs rejected; no default credentials.
* **HTTP layer:** contract validation, error mapping without leaking internals, GET-only retries, no retry for writes, framework-signal passthrough.
* **Security rules:** proxy path traversal, cross-origin writes, admin gate + open-redirect, CSP/HSTS, JSON-LD escaping, URL scheme validation, CSV formula injection.
* **Mock API contract:** cart pricing & coupons, stock caps, idempotent orders, payment pending → paid/failed with restock, order access control, CSRF, OTP, moderation, admin RBAC/lockout, slug stability, dashboard honesty.
* **Contract drift:** mock routes ⇄ `openapi.yaml` ⇄ frontend repository calls must match exactly; every write requires CSRF; every admin operation requires the admin session.
* **E2E journeys:** browse/filter/sort/search, 404s, wishlist, newsletter/lead, bag + coupon → checkout total (regression for the lost-discount bug), COD, online success, online failure, validation/consent, stock limits, pincode check, customer login & reviews, admin lockout/forged-cookie/CSRF, admin product/lead/order/content edits reaching the storefront.

## Approved-design preservation (pixel comparison)
The original prototype (built from commit `a609b5c` in a scratch folder) and this build were screenshotted with identical settings
(reduced motion, mock badge hidden) at 1440×900 and 390×844 and diffed:

| Page | Desktop diff | Mobile diff | Note |
|---|---|---|---|
| Home | **0 %** | **0 %** | identical |
| Bag (empty), Wishlist (empty) | 0 % | 0 % | identical |
| Login | 1.4 % | 0 % | terms sentence hidden until Terms/Privacy exist in the CMS; dev note in mock mode |
| Collections / LUXE / New arrivals | 0.001–0.018 % | 0.007–0.021 % | rating chip hidden when a product has no real reviews |
| Size guide / Returns | 0.05 % / 1.9 % | 0.18 % / 0.29 % | "prototype/placeholder" notes removed from production copy |
| Product detail | top section identical; differs below | — | fabricated sample reviews, invented "fit feedback" and rating bars removed (page is shorter) |

During the comparison one real regression was found and fixed: the prototype's CSS targeted `a[aria-label="Shopping bag"]` but
the old `RouteLink` never rendered that attribute, so the client-approved mobile header showed the bag icon. The accessible name is now provided
with visually-hidden text so rendering stays identical and the links are no longer unlabeled.
