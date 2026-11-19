import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminProductInputSchema } from '../../lib/api/schemas';
import { resetServerEnvCache } from '../../lib/env';
import { limitedAvailabilityMessage, lineMaxQuantity, MAX_LINE_QUANTITY } from '../../lib/backend/data';
import { productPayload, saveProductError } from '../../lib/backend/product-payload';
import { lowStockSizesOfProduct, planStockSave, stockTextError, summarizeLowStock } from '../../lib/inventory';

const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' });
  resetServerEnvCache();
});
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); });

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const base = {
  name: 'Tee', slug: 'tee', categoryId: '11111111-1111-4111-8111-111111111111', price: 599, compareAt: 0, color: 'Black', colorHex: '#242424',
  images: ['https://example.com/a.jpg'], fit: 'Regular fit', material: '100% Cotton', description: 'A tee', bestSeller: false, newArrival: false, luxe: false, status: 'active' as const,
};
const parse = (extra: object) => adminProductInputSchema.safeParse({ ...base, ...extra });
// Stock as loaded with the editor: S=10, M=3, L=0, XL=7, XXL not offered.
const loaded = { S: 10, M: 3, L: 0, XL: 7 };
const form = (over: Record<string, string> = {}) => ({ S: '10', M: '3', L: '0', XL: '7', XXL: '', ...over });

describe('explicit inventory-change intent (no stale overwrite from ordinary saves)', () => {
  it('a message-only or metadata-only edit sends NO stock at all', () => {
    expect(planStockSave(loaded, form(), SIZES)).toEqual({ send: false });
    const payload = productPayload(parse({ stockMessage: 'left', stockMessageMode: 'real' }).data as never, 'p1');
    expect('variants' in payload).toBe(false);
    expect('expected_stock' in payload).toBe(false);
  });
  it('an intentional stock change sends the new quantities AND the stock snapshot loaded with the editor', () => {
    const plan = planStockSave(loaded, form({ M: '8' }), SIZES);
    expect(plan).toEqual({ send: true, variants: [{ size: 'S', stock: 10 }, { size: 'M', stock: 8 }, { size: 'L', stock: 0 }, { size: 'XL', stock: 7 }], expectedStock: loaded });
    const payload = productPayload(parse({ variants: [{ size: 'M', stock: 8 }], expectedStock: loaded }).data as never, 'p1') as Record<string, unknown>;
    expect(payload.expected_stock).toEqual(loaded);
    expect(payload.variants).toEqual([{ size: 'M', sku: '', stock: 8 }]);
  });
  it('the snapshot is the loaded stock, never the (possibly edited) form values', () => {
    const plan = planStockSave(loaded, form({ S: '99' }), SIZES);
    expect(plan.send && plan.expectedStock?.S).toBe(10);
  });
  it('changing a quantity and changing it back is not a stock change', () => expect(planStockSave(loaded, form({ M: '3' }), SIZES)).toEqual({ send: false }));
  it('adding or removing a size counts as an intentional change; creating always sends stock', () => {
    expect(planStockSave(loaded, form({ XXL: '5' }), SIZES).send).toBe(true);
    expect(planStockSave(loaded, form({ L: '' }), SIZES).send).toBe(true);
    expect(planStockSave(null, form(), SIZES)).toEqual({ send: true, variants: [{ size: 'S', stock: 10 }, { size: 'M', stock: 3 }, { size: 'L', stock: 0 }, { size: 'XL', stock: 7 }] });
  });
  it('create payloads carry stock but no expected_stock', () => {
    const payload = productPayload(parse({ variants: [{ size: 'M', stock: 5 }] }).data as never) as Record<string, unknown>;
    expect(payload.variants).toEqual([{ size: 'M', sku: '', stock: 5 }]);
    expect('expected_stock' in payload).toBe(false);
  });
  it('an order changing stock between editor load and save is reported as a 409 conflict, not overwritten', () => {
    const error = saveProductError({ message: 'stock_conflict' });
    expect(error?.status).toBe(409);
    expect(error?.code).toBe('stock_conflict');
    expect(error?.message).toMatch(/Nothing was saved/);
    expect(saveProductError({ message: 'variants_required' })?.status).toBe(422);
    expect(saveProductError({ message: 'something else' })).toBeNull();
  });
  it('the database function guards the conflict inside the row lock (contract of migration 0008)', () => {
    const sql = readFileSync('supabase/migrations/0008_stock_message_modes.sql', 'utf8');
    expect(sql).toContain("raise exception 'stock_conflict'");
    expect(sql).toMatch(/where product_id = v_id and size = v->>'size' for update/);
    expect(sql).toContain('if v_has_variants then'); // no variants key -> the whole inventory section is skipped
    expect(sql).toContain('Unchanged by the admin: never write stock');
  });
});

describe('cart never exposes exact stock for non-Real products', () => {
  it('maxQuantity is the plain cap unless the product is in Real mode', () => {
    expect(lineMaxQuantity('real', 3)).toBe(3);
    expect(lineMaxQuantity('real', 500)).toBe(MAX_LINE_QUANTITY);
    for (const mode of ['none', 'custom']) {
      expect(lineMaxQuantity(mode, 3)).toBe(MAX_LINE_QUANTITY);
      expect(lineMaxQuantity(mode, 1)).toBe(MAX_LINE_QUANTITY);
    }
  });
  it('availability messages contain the exact quantity only in Real mode', () => {
    expect(limitedAvailabilityMessage('real', 3, 'Go high', 'M')).toBe('Only 3 of Go high (M) are available.');
    for (const mode of ['none', 'custom']) {
      const message = limitedAvailabilityMessage(mode, 3, 'Go high', 'M');
      expect(message).not.toMatch(/\b3\b/);
      expect(message).toMatch(/limited availability/);
    }
  });
});

describe('Low Stock counts active products only, with a loaded threshold', () => {
  const variants = [{ size: 'M', stock: 2 }, { size: 'L', stock: 0 }, { size: 'XL', stock: 9 }];
  it('excludes draft products and never uses a fallback threshold', () => {
    expect(lowStockSizesOfProduct({ status: 'active', variants }, 3)).toEqual([{ size: 'M', stock: 2 }]);
    expect(lowStockSizesOfProduct({ status: 'draft', variants }, 3)).toEqual([]);
    expect(lowStockSizesOfProduct({ status: 'active', variants }, undefined)).toEqual([]); // settings not loaded yet: no count at all
  });
  it('the product list and the dashboard agree when drafts exist', () => {
    const products = [
      { id: 'a', name: 'A', status: 'active', variants: [{ size: 'M', stock: 2, sku: 'A-M' }] },
      { id: 'b', name: 'B', status: 'draft', variants: [{ size: 'M', stock: 1, sku: 'B-M' }] },
    ];
    const listed = products.filter(product => lowStockSizesOfProduct(product, 3).length > 0).map(product => product.id);
    const dashboardRows = products.filter(product => product.status === 'active').flatMap(product => product.variants.map(v => ({ productId: product.id, name: product.name, size: v.size, sku: v.sku, stock: v.stock })));
    expect(listed).toEqual(['a']);
    expect(summarizeLowStock(dashboardRows, 3).count).toBe(listed.length);
  });
});

describe('stock message text validation and the custom-number rule', () => {
  it('allows ordinary descriptive text', () => {
    for (const text of ['100% cotton', 'Machine wash at 30°C', 'Limited drop', 'Ships free over ₹1499', 'Pack of 3 pieces', 'Back in stock soon', 'New season arrivals']) expect(stockTextError(text)).toBeNull();
  });
  it('rejects clear false-scarcity claims', () => {
    for (const text of ['3 left', 'Only 2 remaining', 'Last piece', 'only a few remaining', 'two items left', '5 in stock', 'Just 1 left', 'Final unit']) expect(stockTextError(text)).not.toBeNull();
  });
  it('applies to the API: custom/real messages are validated, ordinary text passes', () => {
    expect(parse({ stockMessageMode: 'custom', stockMessage: '100% cotton' }).success).toBe(true);
    expect(parse({ stockMessageMode: 'custom', stockMessage: 'Only 2 remaining' }).success).toBe(false);
    expect(parse({ stockMessageMode: 'real', stockMessage: 'Last piece' }).success).toBe(false);
  });
  it('a display number is accepted only in Custom mode', () => {
    expect(parse({ stockMessageMode: 'custom', stockMessageNumber: 3, stockMessage: 'left' }).success).toBe(true);
    expect(parse({ stockMessageMode: 'real', stockMessageNumber: 3, stockMessage: 'left' }).success).toBe(false);
    expect(parse({ stockMessageMode: 'none', stockMessageNumber: 3 }).success).toBe(false);
    expect(parse({ stockMessageNumber: 3 }).success).toBe(false);
    expect(parse({ stockMessageMode: 'real', stockMessageNumber: null, stockMessage: 'left' }).success).toBe(true);
  });
  it('the migration enforces the same rule in the database and clears the number outside Custom mode', () => {
    const sql = readFileSync('supabase/migrations/0008_stock_message_modes.sql', 'utf8');
    expect(sql).toContain("check (stock_message_number is null or stock_message_mode = 'custom')");
    expect(sql).toMatch(/else null end/);
  });
  it('the review flag clears only when the mode or the message text changes', () => {
    const sql = readFileSync('supabase/migrations/0008_stock_message_modes.sql', 'utf8');
    expect(sql).toMatch(/stock_message_review = case\s+when p \? 'stock_message_mode'\s+and \(coalesce\(nullif\(p->>'stock_message_mode', ''\), 'none'\) is distinct from stock_message_mode\s+or nullif\(btrim\(coalesce\(p->>'stock_message', ''\)\), ''\) is distinct from stock_message\)/);
  });
});

describe('customer-facing Custom stock is never presented as verified inventory', () => {
  const detail = readFileSync('components/storefront/pages/product-detail-page.tsx', 'utf8');
  const card = readFileSync('components/storefront/product-card.tsx', 'utf8');
  it('the product page tags the custom line as a Note and announces a live status only for Real mode', () => {
    expect(detail).toContain("mode === 'custom' && <span className=\"stock-note-tag\">Note</span>");
    expect(detail).toContain("role={mode === 'real' ? 'status' : undefined}");
  });
  it('product cards never show real quantities; custom text carries the same Note tag', () => {
    expect(card).toContain('stock-note-tag');
    expect(card).toContain("effectiveStockMode(product) === 'custom'");
    expect(card).not.toContain("'real'");
  });
  it('the custom number is returned to customers only in Custom mode and never reaches the cart/checkout', () => {
    expect(readFileSync('lib/backend/data.ts', 'utf8')).toContain("stockMessageNumber: mode === 'custom' ? (r.stock_message_number ?? null) : null");
    for (const file of ['components/storefront/pages/bag-page.tsx', 'components/storefront/pages/checkout-page.tsx']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/stockMessage/);
    }
  });
  it('the Real line uses only the selected size quantity from the server, never the custom number', () => {
    expect(detail).toContain('variantForSize(product, selectedSize)?.availability.quantity');
    expect(readFileSync('lib/inventory.ts', 'utf8')).toMatch(/if \(mode === 'real'\) \{[\s\S]{0,200}return `\$\{quantity\} \$\{text \|\| DEFAULT_REAL_MESSAGE\}`;/);
  });
});

describe('strict legacy-payload guard and migration safety (contract of migration 0008)', () => {
  const sql = readFileSync('supabase/migrations/0008_stock_message_modes.sql', 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.save_product'));
  it('an update with variants but no stock snapshot is rejected before anything is written; there is no legacy path', () => {
    expect(fn).toMatch(/if not v_is_create and v_has_variants and not v_has_expected then\s+raise exception 'stock_snapshot_required';/);
    expect(fn.indexOf("raise exception 'stock_snapshot_required'")).toBeLessThan(fn.indexOf('insert into products'));
    expect(fn.indexOf("raise exception 'stock_snapshot_required'")).toBeLessThan(fn.indexOf('update products set'));
    expect(sql).not.toMatch(/original 0007 behaviour|pre-0008 admin code|Caller sent no expected_stock/);
  });
  it('the API maps the guard to a refresh error, never a silent success', () => {
    const error = saveProductError({ message: 'stock_snapshot_required' });
    expect(error?.status).toBe(409);
    expect(error?.code).toBe('stock_snapshot_required');
    expect(error?.message).toMatch(/Refresh/);
  });
  it('runs as one all-or-nothing transaction with lock/statement timeouts', () => {
    expect(sql).toMatch(/^begin;$/m);
    expect(sql).toMatch(/^commit;$/m);
    expect(sql).toMatch(/set local lock_timeout = '\d+s'/);
    expect(sql.indexOf('begin;')).toBeLessThan(sql.indexOf('create or replace function public.save_product'));
    expect(sql.lastIndexOf('commit;')).toBeGreaterThan(sql.indexOf('grant execute on function public.save_product'));
  });
  it('every step is independently re-runnable and the backfill runs only once', () => {
    expect(sql).toContain('add column if not exists stock_message_mode');
    expect(sql).toContain('add column if not exists stock_message_number');
    expect(sql).toContain('add column if not exists stock_message_review');
    expect(sql.match(/if not exists \(select 1 from pg_constraint/g)?.length).toBe(3);
    expect(sql).toMatch(/if v_first_run then\s+update public\.products/);
  });
  it('does not touch order, payment or inventory-movement logic and never edits earlier migrations', () => {
    expect(sql).not.toMatch(/create or replace function public\.(?!save_product)/);
    for (const earlier of ['0004_stock_message', '0005_returns_cancellation', '0006_product_policies_payments']) {
      expect(readFileSync(`supabase/migrations/${earlier}.sql`, 'utf8')).not.toContain('stock_snapshot_required');
    }
  });
});
