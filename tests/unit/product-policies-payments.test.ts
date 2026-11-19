import { describe, expect, it } from 'vitest';
import {
  adminProductInputSchema,
  cartSchema,
  orderLineSchema,
  productSchema,
  type AdminProduct,
} from '@/lib/api/schemas';
import {
  formatProductPaymentNote,
  formatProductPolicyBadge,
  formatProductReturnExchangePolicy,
  formatProductShippingPolicy,
  formatStoreShippingPolicy,
} from '@/lib/format';
import { toOrder } from '@/lib/backend/data';
import { adminProductToDraft } from '@/lib/catalog';

describe('Product Return & Exchange Configuration', () => {
  const storeSettings = {
    returnPolicy:
      'Easy returns within 7 days of delivery. Items must be unworn, unwashed and in their original packaging. Final-sale products are excluded.',
    freeShippingThreshold: 1499,
  };

  it('Scenario A: Returnable enabled + Exchangeable enabled', () => {
    const product = { returnable: true, exchangeable: true };
    const content = formatProductShippingPolicy(product, storeSettings);
    const badge = formatProductPolicyBadge(product);

    expect(badge).toBe('Easy returns & exchanges');
    expect(content).toContain('Eligible for returns and size/colour exchanges.');
    expect(content).toContain(storeSettings.returnPolicy);
    expect(content).toContain('Complimentary shipping over ₹1,499');
    expect(content).not.toContain('non-returnable and non-exchangeable');
  });

  it('Scenario B: Returnable enabled + Exchangeable disabled', () => {
    const product = { returnable: true, exchangeable: false };
    const content = formatProductShippingPolicy(product, storeSettings);
    const badge = formatProductPolicyBadge(product);

    expect(badge).toBe('Easy returns');
    expect(content).toContain('Eligible for returns only (exchanges are not offered for this product).');
    expect(content).toContain(storeSettings.returnPolicy);
    expect(content).not.toContain('Eligible for returns and size/colour exchanges');
    expect(content).not.toContain('non-returnable and non-exchangeable');
  });

  it('Scenario C: Returnable disabled + Exchangeable enabled', () => {
    const product = { returnable: false, exchangeable: true };
    const content = formatProductShippingPolicy(product, storeSettings);
    const badge = formatProductPolicyBadge(product);

    expect(badge).toBe('Exchanges only');
    expect(content).toContain('Eligible for size and colour exchanges only within 7 days of delivery.');
    expect(content).toContain('This product is non-returnable and cannot be returned once delivered.');
    // Must NOT display generic claims such as "Easy returns within 7 days"
    expect(content).not.toContain('Easy returns within 7 days');
    expect(content).not.toContain('non-returnable and non-exchangeable');
  });

  it('Scenario D: Neither enabled (Returnable disabled + Exchangeable disabled)', () => {
    const product = { returnable: false, exchangeable: false };
    const content = formatProductShippingPolicy(product, storeSettings);
    const badge = formatProductPolicyBadge(product);

    expect(badge).toBe('Non-returnable, non-exchangeable');
    expect(content).toContain('This product is non-returnable and non-exchangeable.');
    // Must NOT display generic returns instructions or claims
    expect(content).not.toContain('Easy returns within 7 days');
    expect(content).not.toContain('Eligible for');
    expect(content).toContain('Complimentary shipping over ₹1,499');
  });

  it('defaults undefined exchangeable safely based on returnable flag', () => {
    // Legacy products without explicit exchangeable flag inherit returnable setting
    expect(formatProductPolicyBadge({ returnable: true })).toBe('Easy returns & exchanges');
    expect(formatProductPolicyBadge({ returnable: false })).toBe('Non-returnable, non-exchangeable');
  });

  describe('Independent Product Returns & Exchanges vs Store Shipping Policies', () => {
    it('formatProductReturnExchangePolicy provides only return/exchange copy (no shipping copy)', () => {
      const both = formatProductReturnExchangePolicy({ returnable: true, exchangeable: true }, storeSettings);
      expect(both).toContain('Eligible for returns and size/colour exchanges.');
      expect(both).toContain(storeSettings.returnPolicy);
      expect(both).not.toContain('Complimentary shipping');
      expect(both).not.toContain('shipping');

      const returnsOnly = formatProductReturnExchangePolicy({ returnable: true, exchangeable: false }, storeSettings);
      expect(returnsOnly).toContain('Eligible for returns only (exchanges are not offered for this product).');
      expect(returnsOnly).not.toContain('Complimentary shipping');

      const exchangesOnly = formatProductReturnExchangePolicy({ returnable: false, exchangeable: true }, storeSettings);
      expect(exchangesOnly).toContain('Eligible for size and colour exchanges only within 7 days of delivery.');
      expect(exchangesOnly).toContain('This product is non-returnable and cannot be returned once delivered.');
      expect(exchangesOnly).not.toContain('Complimentary shipping');

      const neither = formatProductReturnExchangePolicy({ returnable: false, exchangeable: false }, storeSettings);
      expect(neither).toBe('This product is non-returnable and non-exchangeable.');
      expect(neither).not.toContain('Complimentary shipping');
    });

    it('formatStoreShippingPolicy provides only shipping copy (no return/exchange copy)', () => {
      const shipping = formatStoreShippingPolicy(storeSettings);
      expect(shipping).toContain('Complimentary shipping over ₹1,499.');
      expect(shipping).not.toContain('return');
      expect(shipping).not.toContain('exchange');
      expect(shipping).not.toContain('unworn');
    });
  });
});

describe('Product Payment Method Configuration & Validation', () => {
  it('Scenario A: COD only product displays correct customer note', () => {
    const product = { codEnabled: true, onlinePaymentEnabled: false };
    expect(formatProductPaymentNote(product)).toBe('Cash on delivery only');
  });

  it('Scenario B: Online Payment only product displays correct customer note', () => {
    const product = { codEnabled: false, onlinePaymentEnabled: true };
    expect(formatProductPaymentNote(product)).toBe('Online payment only (Cash on delivery unavailable)');
  });

  it('Scenario C: Both methods enabled displays correct customer note', () => {
    const product = { codEnabled: true, onlinePaymentEnabled: true };
    expect(formatProductPaymentNote(product)).toBe('Cash on delivery & online payment available');
  });

  it('Scenario D: Neither method enabled displays unavailable note', () => {
    const product = { codEnabled: false, onlinePaymentEnabled: false };
    expect(formatProductPaymentNote(product)).toBe('Currently unavailable for purchase');
  });

  it('adminProductInputSchema rejects when both payment methods are disabled', () => {
    const baseInput = {
      name: 'Essential Oversized Tee',
      slug: 'essential-oversized-tee',
      categoryId: '11111111-1111-1111-1111-111111111111',
      price: 999,
      compareAt: 1499,
      color: 'Charcoal',
      colorHex: '#333333',
      images: ['https://cdn.example.com/tee.jpg'],
      fit: 'Oversized fit',
      material: '100% French Terry Cotton',
      description: 'Clean silhouette.',
      bestSeller: true,
      newArrival: false,
      luxe: false,
      status: 'active' as const,
      variants: [{ size: 'M', stock: 10 }],
    };

    // Both disabled: must fail validation
    const invalidResult = adminProductInputSchema.safeParse({
      ...baseInput,
      codEnabled: false,
      onlinePaymentEnabled: false,
    });
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues[0]?.message).toContain('At least one payment method');
    }

    // COD only: valid
    expect(
      adminProductInputSchema.safeParse({
        ...baseInput,
        codEnabled: true,
        onlinePaymentEnabled: false,
      }).success
    ).toBe(true);

    // Online only: valid
    expect(
      adminProductInputSchema.safeParse({
        ...baseInput,
        codEnabled: false,
        onlinePaymentEnabled: true,
      }).success
    ).toBe(true);

    // Both enabled: valid
    expect(
      adminProductInputSchema.safeParse({
        ...baseInput,
        codEnabled: true,
        onlinePaymentEnabled: true,
      }).success
    ).toBe(true);
  });
});

describe('Cart Payment Method Intersection and Mixed-Product Handling', () => {
  const storePaymentMethods: Array<'upi' | 'card' | 'cod'> = ['upi', 'card', 'cod'];

  function computeCartPaymentMethods(
    lines: Array<{ codEnabled?: boolean; onlinePaymentEnabled?: boolean }>,
    storeMethods: Array<'upi' | 'card' | 'cod'>
  ) {
    const codAllowed = lines.length > 0 && lines.every(l => l.codEnabled !== false);
    const onlineAllowed = lines.length > 0 && lines.every(l => l.onlinePaymentEnabled !== false);

    const allowedPaymentMethods: Array<'upi' | 'card' | 'cod'> = [];
    if (codAllowed && storeMethods.includes('cod')) {
      allowedPaymentMethods.push('cod');
    }
    if (onlineAllowed) {
      if (storeMethods.includes('upi')) allowedPaymentMethods.push('upi');
      if (storeMethods.includes('card')) allowedPaymentMethods.push('card');
    }

    const paymentConflict = lines.length > 0 && !codAllowed && !onlineAllowed;
    return { allowedPaymentMethods, paymentConflict, codAllowed, onlineAllowed };
  }

  it('Cart with Online-only product when store methods do not include online is not a conflict', () => {
    const lines = [
      { codEnabled: false, onlinePaymentEnabled: true }, // Online only
    ];
    // Store only configured with COD (Razorpay credentials absent)
    const storeCodOnly: Array<'upi' | 'card' | 'cod'> = ['cod'];
    const { allowedPaymentMethods, paymentConflict, onlineAllowed, codAllowed } = computeCartPaymentMethods(lines, storeCodOnly);

    expect(allowedPaymentMethods).toEqual([]);
    expect(paymentConflict).toBe(false);
    expect(onlineAllowed).toBe(true);
    expect(codAllowed).toBe(false);
  });

  it('Cart with COD-only product + Both-methods product results in COD only', () => {
    const lines = [
      { codEnabled: true, onlinePaymentEnabled: false }, // Product A: COD only
      { codEnabled: true, onlinePaymentEnabled: true },  // Product B: COD + Online
    ];
    const { allowedPaymentMethods, paymentConflict } = computeCartPaymentMethods(lines, storePaymentMethods);

    expect(allowedPaymentMethods).toEqual(['cod']);
    expect(paymentConflict).toBe(false);
  });

  it('Cart with Online-only product + Both-methods product results in Online only', () => {
    const lines = [
      { codEnabled: false, onlinePaymentEnabled: true }, // Product A: Online only
      { codEnabled: true, onlinePaymentEnabled: true },  // Product B: COD + Online
    ];
    const { allowedPaymentMethods, paymentConflict } = computeCartPaymentMethods(lines, storePaymentMethods);

    expect(allowedPaymentMethods).toEqual(['upi', 'card']);
    expect(paymentConflict).toBe(false);
  });

  it('Cart with COD-only product + Online-only product has empty intersection and flags conflict', () => {
    const lines = [
      { codEnabled: true, onlinePaymentEnabled: false }, // Product A: COD only
      { codEnabled: false, onlinePaymentEnabled: true }, // Product B: Online only
    ];
    const { allowedPaymentMethods, paymentConflict } = computeCartPaymentMethods(lines, storePaymentMethods);

    expect(allowedPaymentMethods).toEqual([]);
    expect(paymentConflict).toBe(true);
  });

  it('Cart with Both-enabled products allows all store methods', () => {
    const lines = [
      { codEnabled: true, onlinePaymentEnabled: true },
      { codEnabled: true, onlinePaymentEnabled: true },
    ];
    const { allowedPaymentMethods, paymentConflict } = computeCartPaymentMethods(lines, storePaymentMethods);

    expect(allowedPaymentMethods).toEqual(['cod', 'upi', 'card']);
    expect(paymentConflict).toBe(false);
  });

  it('cartSchema validates allowedPaymentMethods and paymentConflict fields', () => {
    const mockCart = {
      id: '22222222-2222-2222-2222-222222222222',
      currency: 'INR' as const,
      lines: [
        {
          id: '33333333-3333-3333-3333-333333333333',
          variantId: '44444444-4444-4444-4444-444444444444',
          productId: '55555555-5555-5555-5555-555555555555',
          slug: 'tee',
          name: 'Tee',
          image: 'https://cdn.example.com/tee.jpg',
          color: 'Black',
          size: 'M',
          quantity: 1,
          unitPrice: 999,
          compareAt: 0,
          lineTotal: 999,
          maxQuantity: 10,
          returnable: true,
          exchangeable: false,
          codEnabled: true,
          onlinePaymentEnabled: false,
        },
      ],
      coupon: null,
      totals: { subtotal: 999, discount: 0, shipping: 79, total: 1078 },
      freeShippingThreshold: 1499,
      messages: [],
      allowedPaymentMethods: ['cod' as const],
      paymentConflict: false,
    };

    const parsed = cartSchema.safeParse(mockCart);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.allowedPaymentMethods).toEqual(['cod']);
      expect(parsed.data.lines[0]?.exchangeable).toBe(false);
      expect(parsed.data.lines[0]?.codEnabled).toBe(true);
    }
  });
});

describe('Historical Order Protection and Policy Snapshot', () => {
  it('toOrder maps exchangeable alongside returnable snapshot', () => {
    const mockDbRow = {
      id: '66666666-6666-6666-6666-666666666666',
      number: '1218-1001',
      status: 'delivered',
      payment_status: 'paid',
      payment_method: 'upi',
      subtotal: 999,
      discount: 0,
      shipping: 0,
      total: 999,
      contact: { name: 'Aarav Patel', phone: '9876543210', email: 'aarav@example.com' },
      shipping_address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      created_at: '2026-10-01T10:00:00Z',
      order_items: [
        {
          id: '77777777-7777-7777-7777-777777777777',
          product_id: '88888888-8888-8888-8888-888888888888',
          variant_id: '99999999-9999-9999-9999-999999999999',
          name: 'Limited Drop Tee',
          image: '/images/tee.jpg',
          size: 'L',
          color: 'White',
          quantity: 1,
          unit_price: 999,
          line_total: 999,
          returnable: false,
          exchangeable: true,
        },
      ],
      order_status_history: [],
    };

    const order = toOrder(mockDbRow);
    expect(order.lines[0]?.returnable).toBe(false);
    expect(order.lines[0]?.exchangeable).toBe(true);
  });

  it('orderLineSchema validates both returnable and exchangeable flags', () => {
    const line = {
      id: '77777777-7777-7777-7777-777777777777',
      returnable: false,
      exchangeable: true,
      productId: '88888888-8888-8888-8888-888888888888',
      variantId: '99999999-9999-9999-9999-999999999999',
      name: 'Oversized Hoodie',
      image: 'https://cdn.example.com/hoodie.jpg',
      size: 'XL',
      color: 'Charcoal',
      quantity: 1,
      unitPrice: 1999,
      lineTotal: 1999,
    };

    const parsed = orderLineSchema.safeParse(line);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.returnable).toBe(false);
      expect(parsed.data.exchangeable).toBe(true);
    }
  });

  it('productSchema validates returnable, exchangeable, codEnabled, and onlinePaymentEnabled', () => {
    const rawProduct = {
      id: '10101010-1010-1010-1010-101010101010',
      slug: 'qa-tee-1',
      name: 'QA Tee 1',
      category: 'T-Shirts',
      categorySlug: 't-shirts',
      price: 499,
      compareAt: 0,
      color: 'Black',
      colorHex: '#000000',
      rating: 5,
      reviewCount: 1,
      badge: null,
      images: ['https://cdn.example.com/black-tee.jpg'],
      fit: 'Regular fit',
      material: 'Cotton',
      description: 'Quality tee',
      bestSeller: false,
      newArrival: true,
      luxe: false,
      stockMessage: null,
      returnable: true,
      exchangeable: false,
      codEnabled: true,
      onlinePaymentEnabled: false,
      variants: [{ id: '11111111-1111-1111-1111-111111111111', sku: 'SKU-1', size: 'M', availability: { status: 'in_stock' as const } }],
      updatedAt: '2026-11-04T12:00:00Z',
    };

    const parsed = productSchema.safeParse(rawProduct);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.returnable).toBe(true);
      expect(parsed.data.exchangeable).toBe(false);
      expect(parsed.data.codEnabled).toBe(true);
      expect(parsed.data.onlinePaymentEnabled).toBe(false);
    }
  });

  describe('Admin Checkbox Persistence & Unchecked False Roundtrip', () => {
    it('adminProductInputSchema parses and preserves unchecked (false) options', () => {
      const input = {
        name: 'Oversized Tee',
        slug: 'oversized-tee',
        categoryId: '22222222-2222-2222-2222-222222222222',
        price: 799,
        compareAt: 999,
        color: 'Navy',
        colorHex: '#000080',
        images: ['https://cdn.example.com/navy-tee.jpg'],
        fit: 'Oversized',
        material: 'Cotton',
        description: 'Comfortable oversized tee',
        bestSeller: false,
        newArrival: false,
        luxe: false,
        status: 'active' as const,
        returnable: false,
        exchangeable: false,
        codEnabled: false,
        onlinePaymentEnabled: true,
        variants: [{ size: 'M', stock: 10 }],
      };

      const parsed = adminProductInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.returnable).toBe(false);
        expect(parsed.data.exchangeable).toBe(false);
        expect(parsed.data.codEnabled).toBe(false);
        expect(parsed.data.onlinePaymentEnabled).toBe(true);
      }
    });

    it('adminProductInputSchema rejects when both COD and Online Payment are unchecked', () => {
      const input = {
        name: 'Oversized Tee',
        slug: 'oversized-tee',
        categoryId: '22222222-2222-2222-2222-222222222222',
        price: 799,
        compareAt: 999,
        color: 'Navy',
        colorHex: '#000080',
        images: ['https://cdn.example.com/navy-tee.jpg'],
        fit: 'Oversized',
        material: 'Cotton',
        description: 'Comfortable oversized tee',
        bestSeller: false,
        newArrival: false,
        luxe: false,
        status: 'active' as const,
        returnable: true,
        exchangeable: true,
        codEnabled: false,
        onlinePaymentEnabled: false,
        variants: [{ size: 'M', stock: 10 }],
      };

      const parsed = adminProductInputSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(
          'At least one payment method (Cash on Delivery or Online Payment) must be enabled.'
        );
      }
    });

    it('adminProductToDraft preserves explicit false values when initializing draft from saved product', () => {
      const product: AdminProduct = {
        id: '12121212-1212-1212-1212-121212121212',
        slug: 'custom-tee',
        name: 'Custom Tee',
        categoryId: '22222222-2222-2222-2222-222222222222',
        category: 'T-Shirts',
        categorySlug: 't-shirts',
        price: 599,
        compareAt: 799,
        color: 'Black',
        colorHex: '#000000',
        rating: 4.5,
        reviewCount: 10,
        badge: null,
        images: ['https://cdn.example.com/custom.jpg'],
        fit: 'Regular fit',
        material: 'Cotton',
        description: 'Test product',
        bestSeller: false,
        newArrival: true,
        luxe: false,
        status: 'active',
        stockMessage: '1 left',
        returnable: false,
        exchangeable: false,
        codEnabled: false,
        onlinePaymentEnabled: true,
        variants: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            sku: 'CUSTOM-M',
            size: 'M',
            stock: 10,
            availability: { status: 'in_stock' },
          },
        ],
        updatedAt: '2026-11-04T12:00:00Z',
      };

      const draft = adminProductToDraft(product);
      expect(draft.returnable).toBe(false);
      expect(draft.exchangeable).toBe(false);
      expect(draft.codEnabled).toBe(false);
      expect(draft.onlinePaymentEnabled).toBe(true);
    });

    it('toOrder preserves explicit false for returnable and exchangeable on order items', () => {
      const row = {
        id: '44444444-4444-4444-4444-444444444444',
        number: '1218-9999',
        status: 'confirmed',
        payment_status: 'paid',
        payment_method: 'upi',
        subtotal: 999,
        discount: 0,
        shipping: 0,
        total: 999,
        contact: { email: 'buyer@example.com', name: 'Buyer', phone: '9999999999' },
        shipping_address: { address: '123 St', city: 'City', pincode: '560001', state: 'KA' },
        created_at: '2026-11-04T12:00:00Z',
        order_items: [
          {
            id: 'item-1',
            product_id: 'prod-1',
            variant_id: 'var-1',
            name: 'Non-Returnable Tee',
            image: '/images/tee.jpg',
            size: 'L',
            color: 'Black',
            quantity: 1,
            unit_price: 999,
            line_total: 999,
            returnable: false,
            exchangeable: false,
          },
        ],
        order_status_history: [],
      };

      const order = toOrder(row);
      expect(order.lines[0]?.returnable).toBe(false);
      expect(order.lines[0]?.exchangeable).toBe(false);
    });
  });
});
