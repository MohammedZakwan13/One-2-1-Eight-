# Setup guide

## Requirements
* Node.js 22 (>= 20.9) and npm. Docker is optional.

## 1. Install
```bash
npm ci
```

## 2. Configure
```bash
cp .env.example .env.local
```
See `.env.example` for every variable (all documented, placeholders only).

### A. Local development without a backend (mock)
```ini
APP_ENV=development
API_MODE=mock
MOCK_ADMIN_EMAIL=you@localhost.invalid
MOCK_ADMIN_PASSWORD=choose-a-long-local-password
MOCK_OTP_CODE=123456
```
* Storefront: http://localhost:3000 · Admin: http://localhost:3000/admin
* Customer sign-in: any valid 10-digit mobile starting 6–9, code = `MOCK_OTP_CODE`
* Coupons in the mock: `WELCOME10` (≥ ₹1,499), `LUXE15` (needs a Luxe item). Pincodes starting with `9` are "not serviceable".
* Online payment methods open the **mock gateway** page where you choose success or failure. COD completes directly.
* State is in memory: it resets when the server restarts (or `POST /api/v1/__mock/reset`).

### B. Against a real backend
```ini
APP_ENV=development            # or staging / production
API_MODE=live
API_BASE_URL=https://your-backend-host/v1
NEXT_PUBLIC_SITE_URL=https://your-domain   # required for staging/production
```
The backend must implement `openapi/openapi.yaml`; see [BACKEND_INTEGRATION.md](BACKEND_INTEGRATION.md).

## 3. Run
```bash
npm run dev          # development
npm run build && npm start   # production mode locally
```

## 4. Quality gates
```bash
npm run lint
npm run typecheck
npm test                      # unit + contract tests
npm run test:e2e:install      # once: downloads Chromium
npm run test:e2e              # builds with the mock API and runs the customer & admin journeys
npm run check                 # lint + typecheck + unit + build
```
The e2e run uses its own test-only mock credentials (see `playwright.config.ts`); they never apply to live mode.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `[env] API_BASE_URL is required` | `API_MODE=live` but no backend URL. Set it, or use mock mode locally. |
| `[env] API_MODE=mock is only permitted…` | Mock requested with `APP_ENV=staging/production`. Intentional. |
| `NEXT_PUBLIC_SITE_URL host … looks like a placeholder` | Production needs the real https domain. |
| Admin login says "not configured" | In mock mode set `MOCK_ADMIN_EMAIL` and `MOCK_ADMIN_PASSWORD`. |
| Pages show an error screen with a reference | The backend is unreachable or returned an off-contract response – check server logs for `[api]`. |
