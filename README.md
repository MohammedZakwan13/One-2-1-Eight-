# ONE 2 1 EIGHT — Storefront + Admin (production-preparation build)

Next.js 15 · React 19 · TypeScript (strict) · Tailwind v4 · TanStack Query · Zod

This is the production-preparation version of the client-approved prototype. The approved design,
copy, imagery, splash, LUXE experience and interactions are preserved (verified by pixel comparison —
see [`docs/BASELINE_AND_VERIFICATION.md`](docs/BASELINE_AND_VERIFICATION.md)). What changed is everything
*behind* the UI: all data now flows through a typed API layer that a real backend plugs into.

> **Status:** the frontend is integration-ready. It is **not** a live shop until a backend implementing
> [`openapi/openapi.yaml`](openapi/openapi.yaml), a payment provider, SMS and shipping are connected.
> See [`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md) for the exact list.

## Quick start (local, no backend needed)

```bash
nvm use            # Node 22 (>= 20.9)
npm ci
cp .env.example .env.local
```

Edit `.env.local` for mock mode (choose your own local values — there are no built-in credentials):

```ini
APP_ENV=development
API_MODE=mock
MOCK_ADMIN_EMAIL=you@localhost.invalid
MOCK_ADMIN_PASSWORD=pick-a-long-local-password
MOCK_OTP_CODE=123456
```

```bash
npm run dev        # http://localhost:3000  (storefront)  ·  /admin  (CMS)
```

A yellow **DEV MOCK API** badge is always visible in mock mode. Mock mode is refused at start-up unless
`APP_ENV` is `development` or `test`, so it can never silently serve fake data in staging/production.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:mock` | Dev server (live API / forced mock) |
| `npm run lint` | ESLint (zero warnings allowed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit/contract tests (env guards, HTTP layer, security rules, mock API flows, OpenAPI consistency) |
| `npm run test:e2e` | Playwright journeys against a real production build + mock API (run `npm run test:e2e:install` once) |
| `npm run build` / `npm start` | Production build / server |
| `npm run check` | lint + typecheck + unit tests + build |

## Architecture in one picture

```
Browser ──► /api/v1/*  (Next.js same-origin proxy, CSRF/Origin checks, no CORS, cookies stay first-party)
   ▲                         │
   │ React Query             ▼
Client Components      BACKEND REST API  (openapi/openapi.yaml)   ◄── API_MODE=live
                             ▲
Server Components ───────────┘  (direct, server-side; data cached with tags)
                             ▲
                       mocks/  (in-memory dev/test implementation of the same contract) ◄── API_MODE=mock
```

Read next: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/SETUP.md`](docs/SETUP.md) ·
[`docs/BACKEND_INTEGRATION.md`](docs/BACKEND_INTEGRATION.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
[`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md)

The original prototype documentation is archived in [`docs/prototype/`](docs/prototype/).
