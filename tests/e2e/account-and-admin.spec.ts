import { expect, test } from '@playwright/test';
import { E2E, openStore, resetMock, signInAsAdmin, signInAsCustomer } from './helpers';

test.beforeEach(async ({ request }) => { await resetMock(request); });

test.describe('customer account', () => {
  test('rejects a wrong code, signs in with the right one and shows the account', async ({ page }) => {
    await openStore(page, '/login');
    await page.getByLabel('MOBILE NUMBER').fill('9876543210');
    await page.getByRole('button', { name: /SEND OTP/ }).click();
    for (const [index, digit] of '000000'.split('').entries()) await page.getByLabel(`OTP digit ${index + 1}`).fill(digit);
    await page.getByRole('button', { name: /VERIFY & CONTINUE/ }).click();
    await expect(page.locator('.form-error-banner')).toContainText('not correct');
    await expect(page.getByText("You're signed in.")).toHaveCount(0);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/); // not signed in → bounced

    await signInAsCustomer(page);
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText('+91 9876543210')).toBeVisible();
    await page.getByRole('button', { name: 'SIGN OUT' }).click();
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
  });

  test('reviews need a sign-in and appear only after an admin publishes them', async ({ page, browser }) => {
    const fill = async () => {
      await page.getByLabel('YOUR NAME').fill('Asha');
      await page.getByLabel('REVIEW TITLE').fill('Lovely weight');
      await page.getByLabel('YOUR REVIEW').fill('Heavy cotton, great drape and the fit is exactly right.');
      await page.getByRole('button', { name: /SUBMIT REVIEW/ }).click();
    };
    await openStore(page, '/products/essential-box-fit-tee-black');
    await fill();
    await expect(page.locator('.review-submit-notice')).toContainText('Please sign in');

    await signInAsCustomer(page);
    await openStore(page, '/products/essential-box-fit-tee-black');
    await fill();
    await expect(page.locator('.review-submit-notice')).toContainText(/moderated|checked/);
    await expect(page.getByText('Lovely weight')).toHaveCount(0); // pending → not public

    const adminContext = await browser.newContext({ baseURL: E2E.baseURL });
    const admin = await adminContext.newPage();
    await signInAsAdmin(admin);
    await admin.goto('/admin/reviews');
    const row = admin.locator('.admin-review-row', { hasText: 'Lovely weight' });
    await row.getByRole('combobox').selectOption('published');
    await expect(admin.locator('.toast-message')).toContainText('published');
    await adminContext.close();

    await page.reload();
    await expect(page.getByText('Lovely weight')).toBeVisible();
  });
});

test.describe('admin console', () => {
  test('is locked: anonymous visitors are redirected and APIs answer 401', async ({ page, request }) => {
    for (const path of ['/admin', '/admin/products', '/admin/orders']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/admin\/login/);
    }
    expect((await request.get('/api/v1/admin/auth/me')).status()).toBe(401);
    expect((await request.get('/api/v1/admin/orders')).status()).toBe(401);
    // writes need a CSRF token even before auth is checked
    const forged = await request.post('/api/v1/admin/products', { data: {} });
    expect([401, 403]).toContain(forged.status());
  });

  test('has no demo credentials: not shown, not accepted, and a forged cookie does not help', async ({ page, context }) => {
    await page.goto('/admin/login');
    await expect(page.getByText('1218admin')).toHaveCount(0);
    await expect(page.getByText('admin@one2oneight.com')).toHaveCount(0);
    await page.getByLabel('ADMIN EMAIL').fill('admin@one2oneight.com');
    await page.getByLabel('PASSWORD').fill('1218admin');
    await page.getByRole('button', { name: /ENTER CMS/ }).click();
    await expect(page.locator('.admin-login-error')).toContainText('did not match');
    await expect(page).toHaveURL(/\/admin\/login/);

    // the old client-side flag and a made-up session cookie grant nothing
    await page.evaluate(() => localStorage.setItem('one218-prototype-v3', JSON.stringify({ adminAuthed: true })));
    await context.addCookies([{ name: 'o218_admin_session', value: 'forged', url: E2E.baseURL }]);
    await page.goto('/admin/products');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('sign in, edit a product, see it on the storefront, sign out', async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page.locator('.admin-metric-card').first()).toContainText('03'); // 3 real (mock) orders
    await expect(page.getByText('vs previous period')).toHaveCount(0); // no fabricated trend numbers
    await expect(page.getByText('Demo total')).toHaveCount(0);

    await page.getByRole('button', { name: /Products/ }).first().click();
    await expect(page).toHaveURL(/\/admin\/products/);
    await page.locator('.admin-product-list-row', { hasText: 'Everyday Regular Fit Tee' }).click();
    await page.getByLabel('Price (₹)').fill('649');
    await page.getByRole('button', { name: /Save product/ }).click();
    await expect(page.locator('.toast-message')).toContainText('Product saved');

    await openStore(page, '/collections/all');
    await expect(page.locator('.product-card', { hasText: 'Everyday Regular Fit Tee' })).toContainText('₹649');

    await page.goto('/admin');
    await page.getByRole('button', { name: /Sign out/ }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto('/admin/products');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('validates product input and protects products that have orders', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/products');
    await page.getByRole('button', { name: /Add product/ }).click();
    await page.getByLabel('Product name').fill('E2E Tee');
    await page.getByLabel(/Image URLs/).fill('javascript:alert(1)');
    await page.getByRole('button', { name: /Save product/ }).click();
    await expect(page.locator('.form-error-banner')).toContainText('images');

    await page.locator('.admin-product-list-row', { hasText: 'Essential Box Fit T-Shirt' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'DELETE' }).click();
    await expect(page.locator('.toast-message')).toContainText(/has orders/i);
  });

  test('order status and lead workflows persist through the API', async ({ page }) => {
    await openStore(page, '/');
    await page.getByLabel('Your name').fill('Zed Buyer');
    await page.getByLabel('Work email').fill('zed@example.org');
    await page.getByLabel('Phone number').fill('9876501234');
    await page.getByRole('button', { name: /SEND PROJECT ENQUIRY/ }).click();
    await expect(page.getByText('ENQUIRY RECEIVED')).toBeVisible();

    await signInAsAdmin(page);
    await page.goto('/admin/leads');
    await expect(page.locator('.admin-lead-list-row', { hasText: 'Zed Buyer' })).toBeVisible();
    await page.getByLabel('Status').selectOption('contacted');
    await expect(page.locator('.toast-message')).toContainText('contacted');

    await page.goto('/admin/orders');
    const select = page.getByLabel(/Update status for/).first();
    await select.selectOption('shipped');
    await expect(page.locator('.toast-message')).toContainText('status updated');
  });

  test('content edits (hero destination, announcement) reach the storefront', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/content');
    await page.getByLabel('ANNOUNCEMENT COPY').fill('FREE SHIPPING THIS WEEKEND ONLY');
    await page.getByRole('button', { name: /Save announcement/ }).click();
    await expect(page.locator('.toast-message')).toContainText('Announcement strip updated');
    await openStore(page, '/');
    await expect(page.locator('.announcement-track').first()).toContainText('FREE SHIPPING THIS WEEKEND ONLY');
  });
});
