import { describe, expect, it } from 'vitest';
import { adminProductInputSchema } from '../../lib/api/schemas';
import { effectiveStockMode, isLowStock, lowStockSizes, stockLine, stockTextError } from '../../lib/inventory';
import { publicAvailability, rowStockMode } from '../../lib/backend/data';

const base = {
  name: 'Tee', slug: 'tee', categoryId: '11111111-1111-4111-8111-111111111111', price: 599, compareAt: 0, color: 'Black', colorHex: '#242424',
  images: ['https://example.com/a.jpg'], fit: 'Regular fit', material: '100% Cotton', description: 'A tee', bestSeller: false, newArrival: false, luxe: false,
  status: 'active' as const, variants: [{ size: 'M', stock: 3 }],
};

describe('low stock rule (single threshold)', () => {
  it('1..threshold is low; 0 is out of stock; above is normal', () => {
    for (const stock of [1, 2, 3]) expect(isLowStock(stock, 3)).toBe(true);
    expect(isLowStock(4, 3)).toBe(false);
    expect(isLowStock(0, 3)).toBe(false);
  });
  it('counts a product once however many sizes are low', () => {
    const products = [
      { name: 'Grey T-Shirt', variants: [{ size: 'M', stock: 3 }, { size: 'XL', stock: 10 }] },
      { name: 'Black Hoodie', variants: [{ size: 'L', stock: 2 }, { size: 'XL', stock: 1 }] },
      { name: 'White Sweatshirt', variants: [{ size: 'S', stock: 1 }] },
      { name: 'Navy T-Shirt', variants: [{ size: 'M', stock: 8 }] },
      { name: 'Sold out', variants: [{ size: 'M', stock: 0 }] },
      { name: 'No sizes', variants: [] },
    ];
    const low = products.filter(product => lowStockSizes(product.variants, 3).length > 0);
    expect(low.map(product => product.name)).toEqual(['Grey T-Shirt', 'Black Hoodie', 'White Sweatshirt']);
    expect(lowStockSizes(products[1].variants, 3).map(variant => `${variant.size}:${variant.stock}`)).toEqual(['L:2', 'XL:1']);
  });
  it('reacts to restock and stock reduction', () => {
    expect(isLowStock(3, 3)).toBe(true);
    expect(isLowStock(7, 3)).toBe(false); // restocked
    expect(isLowStock(1, 3)).toBe(true); // reduced
  });
});

describe('stock message modes', () => {
  const sizes = { S: 10, M: 3, L: 0, XL: 7 };
  it('Real mode shows each size its own quantity and Out of stock at zero', () => {
    expect(stockLine('real', 'left', sizes.S)).toBe('10 left');
    expect(stockLine('real', 'left', sizes.M)).toBe('3 left');
    expect(stockLine('real', 'left', sizes.L)).toBe('Out of stock');
    expect(stockLine('real', 'left', sizes.XL)).toBe('7 left');
    expect(stockLine('real', 'left', 7)).toBe('7 left'); // stock 3 -> 7 updates with no manual step
    expect(stockLine('real', '', 5)).toBe('5 left');
  });
  it('Real mode never fabricates a quantity', () => expect(stockLine('real', 'left', undefined)).toBeNull());
  it('Custom note is text only and none shows nothing', () => {
    expect(stockLine('custom', 'Limited drop', 5)).toBe('Limited drop');
    expect(stockLine('custom', '  ', undefined)).toBeNull();
    expect(stockLine('none', 'left', 5)).toBeNull();
  });
  it('exposes exact quantity ONLY for Real mode products', () => {
    expect(publicAvailability('real', 3, 3)).toEqual({ status: 'low_stock', quantity: 3 });
    expect(publicAvailability('real', 0, 3)).toEqual({ status: 'out_of_stock', quantity: 0 });
    for (const mode of ['none', 'custom', 'duplicate']) expect(publicAvailability(mode, 3, 3)).toEqual({ status: 'low_stock' });
  });
  it('existing messages stay as a Custom Stock Note, never as real inventory', () => {
    expect(rowStockMode({ stock_message: 'Only 1 left' })).toBe('custom'); // column not migrated yet
    expect(rowStockMode({ stock_message: 'Only 1 left', stock_message_mode: 'custom' })).toBe('custom');
    expect(rowStockMode({ stock_message: 'Only 1 left', stock_message_mode: 'none' })).toBe('none');
    expect(rowStockMode({ stock_message: null })).toBe('none');
    expect(effectiveStockMode({ stockMessage: 'Limited drop' })).toBe('custom');
    expect(effectiveStockMode({ stockMessage: '' })).toBe('none');
  });
});

describe('server-side validation of stock message input', () => {
  const parse = (extra: object) => adminProductInputSchema.safeParse({ ...base, ...extra });
  it('accepts none, real and note modes and legacy payloads without a mode', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ stockMessageMode: 'none' }).success).toBe(true);
    expect(parse({ stockMessageMode: 'real', stockMessage: 'left' }).success).toBe(true);
    expect(parse({ stockMessageMode: 'custom', stockMessage: 'Limited drop' }).success).toBe(true);
    expect(parse({ stockMessage: 'Only 1 left' }).success).toBe(true); // legacy client: mode not sent, text untouched
  });
  it('rejects unknown modes, including the removed duplicate mode and "both enabled" encodings', () => {
    expect(parse({ stockMessageMode: 'duplicate' }).success).toBe(false);
    expect(parse({ stockMessageMode: 'both' }).success).toBe(false);
    expect(parse({ stockMessageMode: ['real', 'custom'] }).success).toBe(false);
  });
  it('rejects quantity claims written inside the message text (the number belongs in the number field)', () => {
    for (const text of ['3 left', 'Only 1 left', 'only a few remaining', 'Last piece', 'two items left']) {
      expect(parse({ stockMessageMode: 'custom', stockMessage: text }).success).toBe(false);
      expect(parse({ stockMessageMode: 'real', stockMessage: text }).success).toBe(false);
    }
    expect(parse({ stockMessageMode: 'custom', stockMessage: 'left', stockMessageNumber: 3 }).success).toBe(true);
  });
  it('enforces the message length limit', () => {
    expect(parse({ stockMessageMode: 'custom', stockMessage: 'x'.repeat(161) }).success).toBe(false);
    expect(stockTextError('Limited drop')).toBeNull();
    expect(stockTextError('Ships free')).toBeNull();
  });
  it('stock message input never carries inventory: variants stock is the only stock field', () => {
    const parsed = parse({ stockMessageMode: 'real', stockMessage: 'left', variants: [{ size: 'M', stock: 3 }] });
    expect(parsed.success && parsed.data.variants?.[0].stock).toBe(3);
  });
});

describe('custom display number (promotional, never inventory)', () => {
  const parse = (extra: object) => adminProductInputSchema.safeParse({ ...base, ...extra });
  it('saves the display number and message independently', () => {
    const both = parse({ stockMessageMode: 'custom', stockMessageNumber: 3, stockMessage: 'left' });
    expect(both.success && [both.data.stockMessageNumber, both.data.stockMessage]).toEqual([3, 'left']);
    const numberOnly = parse({ stockMessageMode: 'custom', stockMessageNumber: 3, stockMessage: '' });
    expect(numberOnly.success && numberOnly.data.stockMessageNumber).toBe(3);
    const messageOnly = parse({ stockMessageMode: 'custom', stockMessageNumber: null, stockMessage: 'Limited drop' });
    expect(messageOnly.success && messageOnly.data.stockMessageNumber).toBeNull();
  });
  it('validates the number as a non-negative integer within range', () => {
    for (const bad of [-1, 1.5, 100001, '3', Number.NaN]) expect(parse({ stockMessageMode: 'custom', stockMessageNumber: bad }).success).toBe(false);
    for (const ok of [0, 1, 100000]) expect(parse({ stockMessageMode: 'custom', stockMessageNumber: ok }).success).toBe(true);
  });
  it('never touches stock: variant stock stays exactly what was submitted', () => {
    const parsed = parse({ stockMessageMode: 'custom', stockMessageNumber: 3, stockMessage: 'left', variants: [{ size: 'M', stock: 20 }] });
    expect(parsed.success && parsed.data.variants).toEqual([{ size: 'M', stock: 20 }]);
  });
  it('shows the custom number + message, and never uses it in Real mode', () => {
    expect(stockLine('custom', 'left', 20, 3)).toBe('3 left'); // real stock 20 is ignored
    expect(stockLine('custom', '', undefined, 3)).toBe('3');
    expect(stockLine('custom', 'Limited drop', undefined, null)).toBe('Limited drop');
    expect(stockLine('custom', '', undefined, null)).toBeNull();
    expect(stockLine('real', 'left', 7, 3)).toBe('7 left'); // custom number ignored in Real mode
    expect(stockLine('real', 'left', 0, 3)).toBe('Out of stock');
    expect(stockLine('none', 'left', 7, 3)).toBeNull();
  });
  it('does not change availability: the public availability ignores any display number', () => {
    expect(publicAvailability('custom', 20, 3)).toEqual({ status: 'in_stock' });
    expect(publicAvailability('custom', 0, 3)).toEqual({ status: 'out_of_stock' });
    expect(publicAvailability('real', 20, 3)).toEqual({ status: 'in_stock', quantity: 20 });
  });
});
