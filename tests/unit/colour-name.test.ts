import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colourLabel, nearestColourName, parseHexColour } from '@/lib/colour-name';

describe('colourLabel', () => {
  it('keeps a saved colour name exactly as written', () => {
    for (const name of ['Dusty Mauve', 'bold red', 'RUST RED&WHITE', 'Black', 'White&BLACK', 'Fed', 'Bad']) expect(colourLabel(name)).toBe(name);
  });
  it('turns a hex code (with or without #, any case) into a colour name, never showing the code', () => {
    const expected = colourLabel('81A19F');
    expect(expected).not.toMatch(/[0-9]/);
    expect(expected).toMatch(/Sage|Seafoam|Teal|Steel|Mint|Aqua|Grey/);
    for (const code of ['#81a19f', ' 81a19f ', '81a19f']) expect(colourLabel(code)).toBe(expected);
  });
  it('names the obvious colours correctly', () => {
    expect(colourLabel('#000000')).toMatch(/Black/);
    expect(colourLabel('FFFFFF')).toBe('White');
    expect(colourLabel('#ff0000')).toMatch(/Red/);
    expect(colourLabel('1c2a4a')).toBe('Navy Blue');
    expect(colourLabel('#fff')).toBe('White');
    expect(colourLabel('#2e8b4f')).toBe('Green');
  });
  it('handles empty values and does not treat three plain letters as a code', () => {
    expect(colourLabel('')).toBe('');
    expect(colourLabel(undefined)).toBe('');
    expect(parseHexColour('Fed')).toBeNull();
    expect(parseHexColour('#12')).toBeNull();
    expect(parseHexColour('GG1122')).toBeNull();
    expect(nearestColourName([255, 255, 255])).toBe('White');
  });
});

describe('the storefront uses the label for display only', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  it('product page, card, bag and filter chips show colourLabel; swatch colour and filter values keep the saved data', () => {
    const page = read('components/storefront/pages/product-detail-page.tsx');
    expect(page).toContain('<strong>{colourLabel(product.color)}</strong>');
    expect(page).toContain('style={{ background: product.colorHex }} aria-label={colourLabel(product.color)}');
    expect(page).toContain('<span>{colourLabel(product.color)}</span>');
    expect(read('components/storefront/product-card.tsx')).toContain('<span>{colourLabel(product.color)}</span>');
    expect(read('components/storefront/pages/bag-page.tsx')).toContain('{colourLabel(product.color)}');
    const collection = read('components/storefront/pages/collection-page.tsx');
    expect(collection).toContain('selectedColors.includes(product.color)');
    expect(collection).toContain('{colourLabel(color)}</button>');
  });
});
