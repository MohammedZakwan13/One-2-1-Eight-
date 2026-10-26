import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const isCI = Boolean(process.env.CI);

/**
 * End-to-end tests run against a REAL production build (`next build && next start`) backed by the
 * in-memory mock API. The credentials below are test-only values for that mock; they are not used anywhere else.
 */
export const E2E = {
  baseURL: `http://localhost:${PORT}`,
  adminEmail: 'e2e-admin@localhost.invalid',
  adminPassword: 'e2e-only-password-not-a-secret',
  otp: '246810',
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // the mock backend is one shared in-memory process
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: E2E.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Honours the approved reduced-motion path of the splash (1.2s instead of 2.75s) to keep tests fast.
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /storefront\.spec\.ts/ },
  ],
  webServer: {
    command: 'npx next build && npx next start -p ' + PORT,
    url: `${E2E.baseURL}/api/health`,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    stdout: 'pipe',
    env: {
      APP_ENV: 'test',
      API_MODE: 'mock',
      NEXT_PUBLIC_SITE_URL: E2E.baseURL,
      MOCK_ADMIN_EMAIL: E2E.adminEmail,
      MOCK_ADMIN_PASSWORD: E2E.adminPassword,
      MOCK_OTP_CODE: E2E.otp,
    },
  },
});
