import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminProductInputSchema } from '@/lib/api/schemas';
import { productPayload } from '@/lib/backend/product-payload';
import {
  SIZE_GUIDE_LIMITS, SIZE_GUIDE_TEMPLATES, blankSizeGuide, isUsableGuide, nextColumnKey, pruneValues, sizeGuideFromRow, sizeGuideFromTemplate, sizeGuideProblems, sizeGuideSchema, suggestTemplate, type SizeGuide,
} from '@/lib/size-guide';

const read = (path: string) => readFileSync(path, 'utf8');
const complete = (): SizeGuide => ({ enabled: true, unit: 'cm', columns: [{ key: 'c1', label: 'Chest' }, { key: 'c2', label: 'Length' }], rows: [{ size: 'S', values: { c1: '92-96', c2: '68' } }, { size: 'M', values: { c1: '97-101', c2: '70' } }] });

describe('size guide validation', () => {
  it('accepts a complete guide in inches or centimetres and rejects another unit', () => {
    expect(sizeGuideSchema.safeParse(complete()).success).toBe(true);
    expect(sizeGuideSchema.safeParse({ ...complete(), unit: 'in' }).success).toBe(true);
    expect(sizeGuideSchema.safeParse({ ...complete(), unit: 'mm' }).success).toBe(false);
  });
  it('enforces 8 columns and 12 rows', () => {
    const columns = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `c${i + 1}`, label: `C${i + 1}` }));
    const rows = (n: number, cols: number) => Array.from({ length: n }, (_, i) => ({ size: `S${i}`, values: Object.fromEntries(columns(cols).map(c => [c.key, '1'])) }));
    expect(sizeGuideSchema.safeParse({ enabled: true, unit: 'in', columns: columns(SIZE_GUIDE_LIMITS.columns), rows: rows(SIZE_GUIDE_LIMITS.rows, SIZE_GUIDE_LIMITS.columns) }).success).toBe(true);
    expect(sizeGuideSchema.safeParse({ enabled: true, unit: 'in', columns: columns(9), rows: rows(1, 9) }).success).toBe(false);
    expect(sizeGuideSchema.safeParse({ enabled: true, unit: 'in', columns: columns(2), rows: rows(13, 2) }).success).toBe(false);
    expect(sizeGuideSchema.safeParse({ enabled: true, unit: 'in', columns: [], rows: rows(1, 0) }).success).toBe(false);
  });
  it('rejects duplicate column keys, unknown row keys and long text', () => {
    expect(sizeGuideSchema.safeParse({ ...complete(), columns: [{ key: 'c1', label: 'A' }, { key: 'c1', label: 'B' }] }).success).toBe(false);
    expect(sizeGuideSchema.safeParse({ ...complete(), rows: [{ size: 'S', values: { c1: '1', c2: '2', zz: '3' } }] }).success).toBe(false);
    expect(sizeGuideSchema.safeParse({ ...complete(), columns: [{ key: 'c1', label: 'x'.repeat(25) }, { key: 'c2', label: 'L' }] }).success).toBe(false);
  });
  it('an enabled guide must be a complete table; a disabled one may be unfinished', () => {
    const empty = sizeGuideFromTemplate('tshirt');
    expect(sizeGuideProblems(empty).length).toBeGreaterThan(0);
    expect(sizeGuideProblems({ ...empty, enabled: false })).toEqual([]);
    expect(sizeGuideProblems(complete())).toEqual([]);
  });
});

describe('starter templates', () => {
  it('give editable columns and sizes with EMPTY measurements (never invented numbers)', () => {
    const tops = ['Chest', 'Shoulder', 'Sleeve', 'Length'];
    for (const [id, columns] of [['tshirt', tops], ['polo', tops], ['shirt', tops], ['sweatshirt', tops], ['hoodie', tops], ['trackpant', ['Waist', 'Hip', 'Thigh', 'Length']], ['trousers', ['Waist', 'Hip', 'Thigh', 'Length']], ['jeans', ['Waist', 'Hip', 'Thigh', 'Inseam']], ['shorts', ['Waist', 'Hip', 'Length']]] as const) {
      const guide = sizeGuideFromTemplate(id);
      expect(guide.columns.map(c => c.label)).toEqual(columns);
      expect(guide.rows.length).toBeGreaterThan(0);
      expect(guide.rows.every(row => Object.values(row.values).every(value => value === ''))).toBe(true);
    }
  });
  it('a layout is only ever applied by an explicit button click, and only while the product has no guide', () => {
    const editor = read('components/admin/size-guide-editor.tsx');
    expect(editor).toContain('const start = (id: SizeGuideTemplateId) => onEdit(sizeGuideFromTemplate(id));');
    expect(editor).toContain('onClick={() => start(suggested)}');
    expect(editor).toContain("onClick={() => start('custom')}");
    expect(editor).not.toMatch(/useEffect/);
    expect(editor).not.toMatch(/<select[^>]*Starter/); // no starter dropdown any more
    expect(editor.indexOf('{!guide && <>')).toBeLessThan(editor.indexOf('{guide && <>')); // layout buttons live only in the "no guide" branch
    expect(read('lib/product-editor.ts')).toContain('sizeGuide: null, sizeGuideDirty: false, sizeGuideRemoved: false');
  });
});

describe('storefront fallback rules', () => {
  it('only an enabled guide with columns and rows is used; none or disabled falls back to the generic guide', () => {
    expect(isUsableGuide(complete())).toBe(true);
    expect(isUsableGuide(null)).toBe(false);
    expect(isUsableGuide(undefined)).toBe(false);
    expect(isUsableGuide({ ...complete(), enabled: false })).toBe(false);
  });
  it('a malformed database row is treated as "no guide"', () => {
    expect(sizeGuideFromRow(null)).toBeNull();
    expect(sizeGuideFromRow({ enabled: true, unit: 'xx', columns: [], rows: [] })).toBeNull();
    expect(sizeGuideFromRow(complete())).toEqual(complete());
  });
  it('the product page uses its own table when usable, else keeps the generic table; the SIZE GUIDE link and /size-guide page are unchanged', () => {
    const page = read('components/storefront/pages/product-detail-page.tsx');
    expect(page).toContain('isUsableGuide(product.sizeGuide) ? <SizeGuideTable guide={product.sizeGuide} /> : <table>');
    expect(page).toContain("['S', '36–38 in', '16.5 in', '27 in']");
    expect(page).toContain('size-guide-link');
    // The standalone /size-guide page keeps its own generic content and is independent of product guides.
    const generic = read('components/storefront/pages/size-guide-page.tsx');
    expect(generic).toContain('Size & fit guide');
    expect(generic).toContain('FIND YOUR OWN FIT');
    expect(generic).toContain('36–38 in');
    expect(generic).toContain('A FEW GOOD RULES');
    expect(generic).not.toMatch(/sizeGuide|isUsableGuide|SizeGuideTable|product_size_guides/);
  });
});

describe('editor helpers', () => {
  it('column keys stay unique and removing a column drops its values', () => {
    expect(nextColumnKey([{ key: 'c1', label: 'A' }, { key: 'c3', label: 'B' }])).toBe('c4');
    const guide = pruneValues({ ...complete(), columns: [{ key: 'c1', label: 'Chest' }] });
    expect(guide.rows.every(row => Object.keys(row.values).join() === 'c1')).toBe(true);
    expect(blankSizeGuide().rows).toHaveLength(1);
  });
});

describe('size guide is independent of inventory and of the critical save path', () => {
  it('productPayload (and the save_product payload) carries no size guide and no stock fields from it', () => {
    const input = adminProductInputSchema.parse({ name: 'T', slug: 't', categoryId: '11111111-1111-4111-8111-111111111111', price: 100, compareAt: 200, color: 'Red', colorHex: '#ff0000', images: [], fit: 'Regular', material: 'Cotton', description: 'd', bestSeller: false, newArrival: false, luxe: false, status: 'active', sizeGuide: complete() });
    const payload = productPayload(input, undefined, []) as Record<string, unknown>;
    expect(Object.keys(payload).join(' ')).not.toMatch(/guide|measure/i);
    expect(payload.variants).toBeUndefined();
  });
  it('product-payload.ts, save_product and PRODUCT_SELECT stay free of size guide data', () => {
    // product-payload.ts (what save_product receives) knows nothing about guides.
    expect(read('lib/backend/product-payload.ts')).not.toMatch(/size.?guide|measure/i);
    // save_product keeps its own definition (migration 0008) and was never redefined or extended by the size guide migration.
    const saveProduct = read('supabase/migrations/0008_stock_message_modes.sql');
    expect(saveProduct).toContain('create or replace function public.save_product(');
    expect(saveProduct).not.toMatch(/size_guide|sizeGuide/i);
    const guideMigration = read('supabase/migrations/0014_product_size_guides.sql').replace(/--.*$/gm, '');
    expect(guideMigration).not.toMatch(/create or replace function public\.save_product\(/);
    expect(guideMigration).toContain('create or replace function public.save_product_with_size_guide(');
    // PRODUCT_SELECT (shared by the listing, detail, related and admin queries) has no size guide relation.
    const select = /export const PRODUCT_SELECT = '([^']*)';/.exec(read('lib/backend/data.ts'))?.[1] ?? '';
    expect(select).toBe('*, categories(id, name, slug), product_variants(id, sku, size, stock, active, sort_order)');
    expect(select).not.toMatch(/size_guide/);
  });
  it('a save without a guide instruction calls the original save_product; deletion needs an explicit null', () => {
    const admin = read('lib/backend/routes/admin.ts');
    expect(admin).toContain('const guideInstruction = input.sizeGuide !== undefined;');
    expect(admin).toContain("await db().rpc('save_product', { p: productPayload(input, id, images), p_actor: adminId })");
    expect(admin).toContain('p_remove: input.sizeGuide === null');
    const editor = read('components/admin/products.tsx');
    expect(editor).toContain('draft.sizeGuideRemoved ? { sizeGuide: null } : draft.sizeGuideDirty && draft.sizeGuide ? { sizeGuide: draft.sizeGuide } : {}');
  });
  it('the migration is additive: new table + wrapper only, wrapper delegates to save_product, service_role only, RLS on', () => {
    const sql = read('supabase/migrations/0014_product_size_guides.sql').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/alter table public\.(products|product_variants)|create or replace function public\.save_product\(|inventory_movements/i);
    expect(sql).toContain('v_id := public.save_product(p, p_actor);');
    expect(sql).toContain('references public.products(id) on delete cascade');
    expect(sql).toContain('enable row level security');
    expect(sql).toMatch(/revoke all on function public\.save_product_with_size_guide\(jsonb, uuid, jsonb, boolean\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.save_product_with_size_guide\(jsonb, uuid, jsonb, boolean\) to service_role;/);
  });
  it('the section sits after "Real stock by size" and before "Returns & Exchanges"', () => {
    const editor = read('components/admin/products.tsx');
    const stock = editor.indexOf('Real stock by size');
    const guide = editor.indexOf('<SizeGuideEditor');
    const returns = editor.indexOf('<legend>Returns & Exchanges</legend>');
    expect(stock).toBeGreaterThan(0);
    expect(guide).toBeGreaterThan(stock);
    expect(returns).toBeGreaterThan(guide);
  });
});

describe('category-based template suggestions', () => {
  const cat = (slug: string, name = slug) => ({ slug, name });
  it('maps the real categories to the agreed templates', () => {
    expect(suggestTemplate(cat('t-shirt', 'T-Shirt'))).toBe('tshirt');
    expect(suggestTemplate(cat('drop-shoulder', 'Drop Shoulder'))).toBe('tshirt');
    expect(suggestTemplate(cat('sweatshirt', 'Sweatshirt'))).toBe('sweatshirt');
    expect(suggestTemplate(cat('hoodie', 'Hoodie'))).toBe('hoodie');
    expect(suggestTemplate(cat('polo', 'Polo'))).toBe('polo');
    expect(suggestTemplate(cat('track-pant', 'Track Pant'))).toBe('trackpant');
    expect(suggestTemplate(cat('joggers', 'Joggers'))).toBe('trackpant');
  });
  it('maps future categories (trousers, jeans, shorts, shirts) and explicit aliases', () => {
    expect(suggestTemplate(cat('trousers'))).toBe('trousers');
    expect(suggestTemplate(cat('jeans'))).toBe('jeans');
    expect(suggestTemplate(cat('shorts'))).toBe('shorts');
    expect(suggestTemplate(cat('shirts'))).toBe('shirt');
    expect(suggestTemplate(cat('custom-slug-1', 'Hoodies'))).toBe('hoodie'); // exact name alias when the slug is unfamiliar
    expect(suggestTemplate({ slug: 'x', name: 'Track Pants' })).toBe('trackpant');
  });
  it('Regular Fit, unknown, marketing and empty categories all default to Custom', () => {
    expect(suggestTemplate(cat('regular-fit', 'Regular Fit'))).toBe('custom');
    for (const name of ['New Arrivals', 'Best Sellers', 'Offers', 'Sale', 'Luxe', 'Accessories', 'Bags', 'T-Shirt Collection', 'Polo Offers']) expect(suggestTemplate(cat(name.toLowerCase().replace(/ /g, '-'), name))).toBe('custom');
    expect(suggestTemplate(null)).toBe('custom');
    expect(suggestTemplate(undefined)).toBe('custom');
    expect(suggestTemplate({ slug: '', name: '' })).toBe('custom');
  });
  it('Drop Shoulder keeps Chest, Shoulder, Sleeve, Length; track pants and joggers default to S-XXL rows; trousers and jeans use numeric waist sizes', () => {
    const labels = (id: Parameters<typeof sizeGuideFromTemplate>[0]) => sizeGuideFromTemplate(id).columns.map(c => c.label);
    expect(labels(suggestTemplate(cat('drop-shoulder')))).toEqual(['Chest', 'Shoulder', 'Sleeve', 'Length']);
    expect(sizeGuideFromTemplate(suggestTemplate(cat('joggers'))).rows.map(r => r.size)).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
    expect(sizeGuideFromTemplate('trousers').rows.map(r => r.size)).toEqual(['28', '30', '32', '34', '36', '38']);
    expect(sizeGuideFromTemplate('jeans').rows.map(r => r.size)).toEqual(['28', '30', '32', '34', '36', '38']);
  });
  it('Custom is one unnamed column and one unnamed size, with every value empty, and keeps the chosen unit', () => {
    const custom = sizeGuideFromTemplate('custom', 'cm');
    expect(custom).toMatchObject({ unit: 'cm', columns: [{ key: 'c1', label: '' }], rows: [{ size: '', values: { c1: '' } }] });
    expect(sizeGuideProblems(custom).length).toBeGreaterThan(0); // cannot be saved enabled until the admin defines it
    expect(SIZE_GUIDE_TEMPLATES.at(-1)?.id).toBe('custom');
  });
  it('no template ever prefills a measurement value', () => {
    for (const { id } of SIZE_GUIDE_TEMPLATES) expect(sizeGuideFromTemplate(id).rows.every(row => Object.values(row.values).every(value => value === ''))).toBe(true);
  });
  it('a category change only changes which layout is offered first; it never writes to a guide', () => {
    const editor = read('components/admin/size-guide-editor.tsx');
    expect(editor).toContain('const suggested = suggestTemplate(category);');
    expect(editor).toContain('Start with {suggestedLabel} layout');
    // The category is read only to choose the primary button: every onEdit call comes from a button, the table inputs or the layout starter.
    expect(editor.match(/onEdit\(/g)?.length).toBe(2); // start() and edit()
    expect(editor).not.toContain('hasMeasurements'); // layouts are never offered over existing measurements, so nothing can be overwritten
    expect(read('components/admin/products.tsx')).toContain('category={categories.find(category => category.id === draft.categoryId) ?? null}');
  });
  it('saved guides, inventory and the backend are untouched by this change', () => {
    for (const file of ['lib/backend/product-payload.ts', 'supabase/migrations/0014_product_size_guides.sql', 'lib/backend/routes/admin.ts', 'lib/backend/routes/storefront.ts', 'lib/backend/data.ts']) {
      expect(read(file)).not.toMatch(/suggestTemplate|CATEGORY_ALIASES/);
    }
  });
});

describe('migration 0014 hardening (source guards; behaviour is verified against local Supabase)', () => {
  const sql = read('supabase/migrations/0014_product_size_guides.sql').replace(/--.*$/gm, '');
  it('one shared validator, used by the table CHECK and by the save function, never returning null', () => {
    expect(sql).toContain('create or replace function public.size_guide_valid(p_columns jsonb, p_rows jsonb)');
    expect(sql).toContain('constraint product_size_guides_body_valid check (public.size_guide_valid(columns, rows))');
    expect(sql).toContain('not public.size_guide_valid(p_guide->\'columns\', p_guide->\'rows\')');
    expect(sql).toMatch(/jsonb_typeof\(c->'key'\) is distinct from 'string'/);
    expect(sql).toMatch(/jsonb_typeof\(r->'values'\) is distinct from 'object'/);
    expect(sql).toMatch(/jsonb_typeof\(val\) is distinct from 'string' or char_length\(val #>> '\{\}'\) > 20/);
    expect(sql).toContain('if not (k = any (v_keys)) then return false; end if;'); // unknown measurement keys
    expect(sql).toContain("(c->>'key') = any (v_keys)"); // duplicate keys
    expect(sql).toContain('jsonb_array_length(p_columns) not between 1 and 8 or jsonb_array_length(p_rows) not between 1 and 12');
  });
  it('all three functions pin search_path with pg_temp last; the wrapper keeps four arguments and the explicit p_remove', () => {
    expect(sql.match(/set search_path = public, pg_temp/g)?.length).toBe(3); // validator, completeness check and wrapper
    expect(sql).toContain('create or replace function public.save_product_with_size_guide(p jsonb, p_actor uuid, p_guide jsonb, p_remove boolean default false)');
    expect(sql).toContain("jsonb_typeof(p_guide) not in ('object', 'null')");
    expect(sql).toContain('if coalesce(p_remove, false) then');
    expect(sql).toContain('v_id := public.save_product(p, p_actor);');
  });
  it('permissions: service_role only on the wrapper and the validator; RLS on; no explicit transaction statements in the file', () => {
    for (const signature of ['save_product_with_size_guide(jsonb, uuid, jsonb, boolean)', 'size_guide_valid(jsonb, jsonb)']) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(sql).toContain('alter table public.product_size_guides enable row level security;');
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });
});

describe('migration 0014: enabled guides must be complete in the database too (disabled ones may stay blank)', () => {
  const sql = read('supabase/migrations/0014_product_size_guides.sql').replace(/--.*$/gm, '');
  it('a completeness function, a table CHECK that applies only when enabled, and the same rule inside the save function', () => {
    expect(sql).toContain('create or replace function public.size_guide_complete(p_columns jsonb, p_rows jsonb)');
    expect(sql).toContain('if not public.size_guide_valid(p_columns, p_rows) then return false; end if;');
    expect(sql).toMatch(/jsonb_typeof\(r->'values'->\(c->>'key'\)\) is distinct from 'string' or char_length\(btrim\(r->'values'->>\(c->>'key'\)\)\) < 1/);
    expect(sql).toContain('constraint product_size_guides_complete_when_enabled check (not enabled or public.size_guide_complete(columns, rows))');
    expect(sql).toContain("((p_guide->>'enabled')::boolean and not public.size_guide_complete(p_guide->'columns', p_guide->'rows'))");
  });
  it('is created before the table that uses it, and has service_role-only permissions', () => {
    expect(sql.indexOf('function public.size_guide_valid')).toBeLessThan(sql.indexOf('function public.size_guide_complete'));
    expect(sql.indexOf('function public.size_guide_complete')).toBeLessThan(sql.indexOf('create table if not exists public.product_size_guides'));
    expect(sql).toContain('revoke all on function public.size_guide_complete(jsonb, jsonb) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.size_guide_complete(jsonb, jsonb) to service_role;');
  });
  it('the database rule matches the application rule: the editor schema also demands every cell for an enabled guide and allows an unfinished disabled one', () => {
    const base = { unit: 'in', columns: [{ key: 'c1', label: 'A' }], rows: [{ size: 'S', values: { c1: '' } }] } as const;
    expect(sizeGuideSchema.safeParse({ ...base, enabled: true }).success).toBe(false);
    expect(sizeGuideSchema.safeParse({ ...base, enabled: false }).success).toBe(true);
    expect(sizeGuideSchema.safeParse({ ...base, enabled: true, rows: [{ size: 'S', values: { c1: '36' } }] }).success).toBe(true);
  });
});
