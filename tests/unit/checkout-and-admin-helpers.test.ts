import { describe, expect, it } from 'vitest';
import { normalizePhone, validateDelivery, validateDeliveryField } from '../../lib/checkout-validation';
import { colorToHex, FIT_OPTIONS, MATERIAL_OPTIONS, matchesMerchFilters } from '../../lib/product-options';

const valid = { name: 'Asha Rao', phone: '9876543210', email: 'asha@example.com', pin: '560001', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka' };

describe('checkout delivery validation', () => {
  it('accepts a legitimate address', () => expect(validateDelivery(valid)).toEqual({}));
  it('accepts legitimate names with apostrophes, hyphens, dots and non-latin letters', () => {
    for (const name of ["D'Souza", 'Anne-Marie', 'Dr. K. Iyer', 'முருகன்', 'José']) expect(validateDeliveryField('name', name)).toBe('');
  });
  it('rejects empty, whitespace-only and digit names', () => {
    for (const name of ['', '   ', 'A', '1234', 'Asha123']) expect(validateDeliveryField('name', name)).not.toBe('');
  });
  it('validates Indian mobile numbers and normalises +91 / 0 prefixes', () => {
    expect(validateDeliveryField('phone', '9876543210')).toBe('');
    expect(validateDeliveryField('phone', '+91 98765 43210')).toBe('');
    expect(validateDeliveryField('phone', '09876543210')).toBe('');
    expect(normalizePhone('+91 98765-43210')).toBe('9876543210');
    for (const phone of ['5876543210', '98765', '98765432101', 'abcdefghij']) expect(validateDeliveryField('phone', phone)).not.toBe('');
  });
  it('validates email, pincode, address, city and state', () => {
    expect(validateDeliveryField('email', 'a@b.co')).toBe('');
    for (const email of ['abc', 'a@b', 'a b@c.com']) expect(validateDeliveryField('email', email)).not.toBe('');
    expect(validateDeliveryField('pin', '110001')).toBe('');
    for (const pin of ['012345', '11000', '1100011']) expect(validateDeliveryField('pin', pin)).not.toBe('');
    expect(validateDeliveryField('line1', '     ')).not.toBe('');
    expect(validateDeliveryField('line1', 'Flat 4')).toBe('');
    expect(validateDeliveryField('city', 'x')).not.toBe('');
    expect(validateDeliveryField('state', '  ')).not.toBe('');
  });
});

describe('product editor helpers', () => {
  it('maps colour names, aliases and hex codes to #rrggbb', () => {
    expect(colorToHex('Black')).toBe('#242424');
    expect(colorToHex('gray')).toBe(colorToHex('Grey'));
    expect(colorToHex('#abc')).toBe('#aabbcc');
    expect(colorToHex('#1F2A44')).toBe('#1f2a44');
    expect(colorToHex('Mystery shade')).toBeNull();
    expect(colorToHex('')).toBeNull();
  });
  it('offers the requested fit and material options', () => {
    expect(FIT_OPTIONS).toContain('Oversized fit');
    expect(MATERIAL_OPTIONS).toContain('French Terry');
    expect(MATERIAL_OPTIONS).toContain('Spandex / Elastane');
  });
  it('filters merchandising flags independently with OR logic', () => {
    const items = [
      { id: 'a', bestSeller: true, newArrival: false, luxe: false },
      { id: 'b', bestSeller: true, newArrival: true, luxe: false },
      { id: 'c', bestSeller: false, newArrival: false, luxe: true },
      { id: 'd', bestSeller: false, newArrival: false, luxe: false },
    ];
    const ids = (flags: Parameters<typeof matchesMerchFilters>[1]) => items.filter(item => matchesMerchFilters(item, flags)).map(item => item.id);
    expect(ids([])).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(['bestSeller'])).toEqual(['a', 'b']);
    expect(ids(['newArrival'])).toEqual(['b']);
    expect(ids(['luxe'])).toEqual(['c']);
    expect(ids(['newArrival', 'luxe'])).toEqual(['b', 'c']);
  });
});
