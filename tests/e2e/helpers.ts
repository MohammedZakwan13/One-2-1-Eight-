import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../../playwright.config';

export { E2E };

/** Resets the in-memory mock backend (test-only endpoint; 404s outside mock mode). */
export async function resetMock(request: APIRequestContext) {
  const response = await request.post('/api/v1/__mock/reset');
  expect(response.status()).toBe(204);
}

/** Opens a storefront page and waits for the approved first-visit splash to finish. */
export async function openStore(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.locator('.initial-splash-screen')).toHaveCount(0, { timeout: 15_000 });
}

/** Navigates client-side (no splash re-run) by clicking through the real UI. */
export async function addProductToBag(page: Page, slug: string, size: string) {
  await openStore(page, `/products/${slug}`);
  await page.getByRole('button', { name: new RegExp(`^Size ${size}$`) }).click();
  const added = page.waitForResponse(response => response.url().includes('/api/v1/cart/items') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /ADD TO BAG/ }).first().click();
  expect((await added).status()).toBe(200);
}

export async function signInAsAdmin(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('ADMIN EMAIL').fill(E2E.adminEmail);
  await page.getByLabel('PASSWORD').fill(E2E.adminPassword);
  await page.getByRole('button', { name: /ENTER CMS/ }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

export async function signInAsCustomer(page: Page, phone = '9876543210') {
  await openStore(page, '/login');
  await page.getByLabel('MOBILE NUMBER').fill(phone);
  await page.getByRole('button', { name: /SEND OTP/ }).click();
  const digits = E2E.otp.split('');
  for (const [index, digit] of digits.entries()) await page.getByLabel(`OTP digit ${index + 1}`).fill(digit);
  await page.getByRole('button', { name: /VERIFY & CONTINUE/ }).click();
  await expect(page.getByText("You're signed in.")).toBeVisible();
}
