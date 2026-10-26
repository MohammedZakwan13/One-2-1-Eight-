import { expect, test } from '@playwright/test';
import { openStore, resetMock } from './helpers';

test.beforeEach(async ({ request }) => { await resetMock(request); });

test.describe('storefront browsing', () => {
  test('home page renders the approved storefront with server data', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openStore(page, '/');
    await expect(page).toHaveTitle(/ONE 2 1 EIGHT/);
    await expect(page.locator('.hero-photo')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Best sellers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New arrivals' })).toBeVisible();
    await expect(page.locator('.category-card').first()).toBeVisible();
    await expect(page.locator('.product-card').first()).toBeVisible();
    // mock mode is always flagged so it cannot be mistaken for a live store
    await expect(page.getByText('DEV MOCK API', { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('collections filter, sort and open a product', async ({ page }) => {
    await openStore(page, '/collections/all');
    const cards = page.locator('.product-card');
    await expect(cards).toHaveCount(12);
    await page.getByLabel('Sort products').selectOption('price-low');
    await expect(cards.first()).toContainText('₹699');
    await page.getByRole('button', { name: /FILTERS/ }).click();
    await page.locator('.filter-color-options').getByRole('button', { name: 'Olive', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await cards.first().getByRole('link', { name: /Elevated Knit Polo/ }).first().click();
    await expect(page).toHaveURL(/\/products\/elevated-polo-knit-olive$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Elevated Knit Polo' })).toBeVisible();
  });

  test('LUXE collection keeps its dedicated experience', async ({ page }) => {
    await openStore(page, '/collections/one-2-1-eight-luxe');
    await expect(page.locator('.collection-page-luxe')).toBeVisible();
    await expect(page.locator('.product-card')).toHaveCount(4);
  });

  test('search is URL-driven and shareable', async ({ page }) => {
    await openStore(page, '/search?q=polo');
    await expect(page.getByLabel('Search all products')).toHaveValue('polo');
    await expect(page.locator('.product-card')).toHaveCount(2);
    await page.getByLabel('Search all products').fill('hoodie');
    await expect(page).toHaveURL(/q=hoodie/);
    await expect(page.locator('.product-card')).toHaveCount(1);
    await page.getByLabel('Search all products').fill('zzzzzz');
    await expect(page.getByText('No matching pieces found')).toBeVisible();
  });

  test('unknown URLs and products return real 404s inside the branded shell', async ({ page }) => {
    for (const path of ['/definitely-not-a-page', '/products/not-a-product', '/collections/not-a-collection', '/policies/not-there']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByText('This page took')).toBeVisible();
    }
  });

  test('wishlist persists locally and hydrates from the API', async ({ page }) => {
    await openStore(page, '/collections/all');
    await page.locator('.product-card').first().getByRole('button', { name: 'Add to wishlist' }).click();
    await expect(page.locator('.toast-message')).toContainText('saved for later');
    await openStore(page, '/wishlist');
    await expect(page.locator('.product-card')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.product-card')).toHaveCount(1);
  });

  test('newsletter and bulk enquiry post to the API and surface server state', async ({ page, request }) => {
    await openStore(page, '/');
    await page.getByLabel('Email for newsletter').fill('reader@example.org');
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(page.getByText('Almost there — check your inbox to confirm.')).toBeVisible();

    await page.getByLabel('Your name').fill('Asha Verma');
    await page.getByLabel('Work email').fill('asha@example.org');
    await page.getByLabel('Phone number').fill('9876543210');
    await page.getByRole('button', { name: /SEND PROJECT ENQUIRY/ }).click();
    await expect(page.getByText('ENQUIRY RECEIVED')).toBeVisible();
    expect((await request.get('/api/v1/admin/leads')).status()).toBe(401); // and is not world-readable
  });

  test('responses carry security headers and the app does not leak its stack', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBeTruthy();
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('staging/test environments are not indexable', async ({ request }) => {
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
    expect(await (await request.get('/')).text()).toContain('noindex');
  });
});
