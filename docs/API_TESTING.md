# Testing the API

| What | URL (npm run dev) | URL (Docker) |
| --- | --- | --- |
| **Swagger UI** | http://localhost:3000/docs | http://localhost:3001/docs |
| OpenAPI JSON | http://localhost:3000/api/v1/openapi.json | http://localhost:3001/api/v1/openapi.json |
| Health / readiness | `/api/health` · `/api/health?deep=1` | same on :3001 |
| API base | http://localhost:3000/api/v1 | http://localhost:3001/api/v1 |

## In Swagger UI

1. Open `/docs`. "Try it out" calls the real implementation and database.
2. **Authenticate once:** `POST /admin/auth/login` with your admin e-mail/password. The HttpOnly cookie is kept by the browser, so every later admin call is authorised. CSRF tokens are added automatically.
3. Customer routes need SMS sign-in (`/auth/otp/request` → `/auth/otp/verify`) and therefore MSG91. Order creation (`POST /orders`) also needs that sign-in: there is no guest checkout.

## Safe test sequence

1. `GET /ready` → database `ok`. `GET /products` → empty list on a fresh database (correct).
2. Admin login → `POST /admin/uploads` (a small PNG/JPEG/WebP) → note `url`.
3. `POST /admin/products` with `images:[url]`, `variants:[{size:"S",stock:3},{size:"M",stock:10}]`, `stockDisplay:"exact"`, `status:"active"`.
4. `GET /products/{slug}` → image, per-size availability. `PUT /admin/products/{id}` with new stock → re-read.
5. Cart: `POST /cart/items` (variantId from step 4) → `POST /orders` with header `Idempotency-Key` and `paymentMethod:"cod"` → keep `order.id` + `lookupToken`.
6. `GET /orders/{id}?token=…` (customer tracking) → `PATCH /admin/orders/{id}/status` (`processing`, `packed`, `shipped` + `carrier`/`trackingNumber`) → re-read the order.
7. `GET /admin/dashboard/summary` → `lowStockItems` use real stock. `POST /leads` → `GET /admin/leads`.
8. Cancel the order (`cancelled`) → stock is returned once.

## Automated

```bash
npm test                     # unit + contract tests (no network)
npm run smoke                # public + security checks on a running server
SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run smoke   # full flow incl. concurrency; cleans up its QA SMOKE rows with the service key
BASE_URL=http://localhost:3001 npm run smoke               # against Docker
```
