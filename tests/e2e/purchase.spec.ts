import { expect, test, type Page } from '@playwright/test';
import { addProductToBag, openStore, resetMock } from './helpers';

test.beforeEach(async ({ request }) => { await resetMock(request); });

async function fillCheckout(page: Page, method: 'UPI' | 'Card' | 'Cash on delivery', options: { acceptTerms?: boolean } = {}) {
  await page.getByLabel('Full name').fill('Asha Verma');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Email address').fill('asha@example.org');
  await page.getByLabel('Pincode').fill('560001');
  await page.getByLabel('Address', { exact: true }).fill('12 MG Road, Indiranagar');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByLabel('State').fill('Karnataka');
  await page.getByRole('button', { name: new RegExp(method) }).click();
  if (options.acceptTerms !== false) await page.getByLabel(/I agree to the terms of sale/).check();
}

test.describe('cart and checkout', () => {
  test('bag is server-priced and coupons flow through to checkout (regression: discount used to be lost)', async ({ page }) => {
    await addProductToBag(page, 'essential-box-fit-tee-black', 'M');
    await page.getByRole('link', { name: 'Shopping bag' }).click();
    await expect(page.getByRole('heading', { name: /Your bag/ })).toBeVisible();
    await expect(page.locator('.bag-item')).toHaveCount(1);

    // under the threshold: shipping applies; the server explains why a coupon is refused
    await expect(page.locator('.summary-total')).toContainText('₹978'); // 899 + 79 shipping
    await page.locator('#coupon').fill('WELCOME10');
    await page.getByRole('button', { name: 'APPLY' }).click();
    await expect(page.locator('.coupon-error')).toContainText('more to use this code');
    await page.locator('#coupon').fill('NOT-A-CODE');
    await page.getByRole('button', { name: 'APPLY' }).click();
    await expect(page.locator('.coupon-error')).toContainText('not available');

    // increase quantity → free shipping and a valid coupon
    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(page.locator('.summary-total')).toContainText('₹1,798');
    await page.locator('#coupon').fill('welcome10');
    await page.getByRole('button', { name: 'APPLY' }).click();
    await expect(page.locator('.applied-coupon')).toContainText('WELCOME10');
    await expect(page.locator('.summary-total')).toContainText('₹1,618');

    await page.getByRole('link', { name: /CONTINUE TO CHECKOUT/ }).click();
    await expect(page.locator('.checkout-summary .summary-total')).toContainText('₹1,618');
    await expect(page.locator('.checkout-summary')).toContainText('Discount');
  });

  test('cash on delivery places a real order, empties the bag and reads status back from the server', async ({ page }) => {
    await addProductToBag(page, 'everyday-regular-fit-tee-sage', 'L');
    await openStore(page, '/checkout');
    await fillCheckout(page, 'Cash on delivery');
    await page.getByRole('button', { name: /PLACE ORDER/ }).click();

    await expect(page).toHaveURL(/\/order-confirmation\?order=.+&token=.+/);
    await expect(page.getByText('ORDER PLACED')).toBeVisible();
    await expect(page.getByText(/pay on delivery|keep the amount ready/i).first()).toBeVisible();
    await expect(page.locator('.confirmation-receipt')).toContainText('1218-');
    await expect(page.locator('.confirmation-receipt')).toContainText('₹778'); // 699 + 79
    // the bag is empty because the SERVER emptied it
    await openStore(page, '/bag');
    await expect(page.getByRole('heading', { name: 'Your bag is waiting.' })).toBeVisible();
  });

  test('online payment is only confirmed after the server records the provider outcome', async ({ page }) => {
    await addProductToBag(page, 'luxe-merino-polo-midnight', 'M');
    await openStore(page, '/checkout');
    await fillCheckout(page, 'UPI');
    await page.getByRole('button', { name: /PLACE ORDER/ }).click();

    // mock gateway stand-in (only exists in mock mode)
    await expect(page).toHaveURL(/\/mock-payment\//);
    await page.getByRole('button', { name: /SIMULATE SUCCESS/ }).click();
    await expect(page).toHaveURL(/\/order-confirmation/);
    await expect(page.getByText('ORDER PLACED')).toBeVisible();
    await expect(page.getByText('Your payment has been received.')).toBeVisible();
  });

  test('a failed payment is reported as failed — never as a success', async ({ page }) => {
    await addProductToBag(page, 'luxe-merino-polo-midnight', 'L');
    await openStore(page, '/checkout');
    await fillCheckout(page, 'Card');
    await page.getByRole('button', { name: /PLACE ORDER/ }).click();
    await page.getByRole('button', { name: /SIMULATE FAILURE/ }).click();
    await expect(page.getByText('PAYMENT FAILED')).toBeVisible();
    await expect(page.getByText('ORDER PLACED')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /BACK TO YOUR BAG/ })).toBeVisible();
  });

  test('checkout validates input and requires explicit consent (terms are not pre-ticked)', async ({ page }) => {
    await addProductToBag(page, 'everyday-regular-fit-tee-sage', 'M');
    await openStore(page, '/checkout');
    await fillCheckout(page, 'UPI', { acceptTerms: false });
    await expect(page.getByLabel(/I agree to the terms of sale/)).not.toBeChecked();
    await page.getByRole('button', { name: /PLACE ORDER/ }).click();
    await expect(page.locator('.form-error-banner')).toContainText('Terms');

    await page.getByLabel(/I agree to the terms of sale/).check();
    await page.getByLabel('Mobile number').fill('12345');
    await page.getByRole('button', { name: /PLACE ORDER/ }).click();
    await expect(page.locator('.form-error-banner')).toContainText('Mobile number');
    await expect(page).toHaveURL(/\/checkout/);
  });

  test('stock limits are enforced by the server and reflected in the UI', async ({ page }) => {
    // Atelier Textured Sweatshirt, size M has 2 units in the mock catalogue
    await addProductToBag(page, 'atelier-textured-sweatshirt-ecru', 'M');
    await openStore(page, '/bag');
    const increase = page.getByRole('button', { name: 'Increase quantity' });
    await increase.click();
    await expect(page.locator('.quantity-control span')).toHaveText('2');
    await expect(increase).toBeDisabled();
  });

  test('delivery check is answered by the API (not hard-coded)', async ({ page }) => {
    await openStore(page, '/products/essential-box-fit-tee-black');
    await page.getByPlaceholder('Enter 6-digit pincode').fill('560001');
    await page.getByRole('button', { name: /^CHECK/ }).click();
    await expect(page.locator('.delivery-response')).toContainText('delivery available to 560001');
    await page.getByPlaceholder('Enter 6-digit pincode').fill('900001');
    await page.getByRole('button', { name: /^CHECK/ }).click();
    await expect(page.locator('.delivery-response')).toContainText(/do not deliver|can't deliver/);
  });

  test('choosing a size is required before adding to bag', async ({ page }) => {
    await openStore(page, '/products/essential-box-fit-tee-black');
    await page.getByRole('button', { name: /ADD TO BAG/ }).first().click();
    await expect(page.locator('.toast-message')).toContainText('Choose your size');
  });
});
