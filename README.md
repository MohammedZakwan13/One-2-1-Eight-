# ONE 2 1 EIGHT — storefront, Admin/CMS and API

Next.js 15 (App Router, TypeScript) storefront + Admin/CMS, backed by **Supabase** (Postgres, Auth, Storage).
There is no mock data in the running app: everything is read from and written to the database through the REST API.

* API base path: `/api/v1` (same origin as the site) — documented in [`openapi/openapi.yaml`](openapi/openapi.yaml)
* **Swagger UI: `/docs`** · OpenAPI JSON: `/api/v1/openapi.json` · health: `/api/health` · readiness: `/api/health?deep=1`
* Full local setup, manual steps and test flow: [`docs/SETUP.md`](docs/SETUP.md) · [`docs/API_TESTING.md`](docs/API_TESTING.md)

## Quick start

```bash
npm install
cp .env.example .env.local         # fill SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
npm run dev                        # http://localhost:3000   (Swagger: http://localhost:3000/docs)
```

Or in Docker (container on **3001**, so it can run next to `npm run dev`):

```bash
docker compose up --build -d       # http://localhost:3001   (Swagger: http://localhost:3001/docs)
docker compose down
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` · `typecheck` · `test` | ESLint · TypeScript · Vitest (env guards, HTTP layer, security rules, backend logic, OpenAPI ⇄ route-table contract) |
| `npm run check` | lint + typecheck + test + build |
| `npm run admin:create -- <email> "<name>" <role>` | Create an admin (needs `ADMIN_PASSWORD` env; see docs/SETUP.md) |
| `npm run smoke` | End-to-end API smoke test against a running server and the real database |

## Layout

```
app/                 routes: (storefront)/, admin/, api/v1 (proxy + uploads + openapi), api/webhooks, docs
components/          storefront/, admin/, ui/
lib/api/             typed REST client + Zod contract (schemas.ts)  ◄── single source of truth for payloads
lib/backend/         the server: routes, auth, pricing, integrations (Resend, Razorpay, MSG91)
supabase/migrations/ database schema, RLS, atomic order/stock/payment functions
openapi/             OpenAPI 3.1 contract (kept in step with the route table by a unit test)
```

Prices, stock, order ownership, payment status and admin roles are decided on the server only.
