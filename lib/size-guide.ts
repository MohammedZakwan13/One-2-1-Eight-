import { z } from 'zod';

/**
 * Product-specific size guide: customer-facing garment measurements, shown in the product page's size guide.
 * It is informational only and has NO link to product variants, SKUs or stock: a row's "size" is just a label.
 */
export const SIZE_GUIDE_LIMITS = { columns: 8, rows: 12, label: 24, size: 16, cell: 20 } as const;
export const SIZE_GUIDE_UNITS = ['in', 'cm'] as const;
export type SizeGuideUnit = (typeof SIZE_GUIDE_UNITS)[number];
export const SIZE_GUIDE_UNIT_LABEL: Record<SizeGuideUnit, string> = { in: 'Inches (in)', cm: 'Centimetres (cm)' };

const columnSchema = z.object({ key: z.string().regex(/^[a-z0-9_]{1,12}$/), label: z.string().trim().min(1).max(SIZE_GUIDE_LIMITS.label) });
const rowSchema = z.object({ size: z.string().trim().min(1).max(SIZE_GUIDE_LIMITS.size), values: z.record(z.string(), z.string().trim().max(SIZE_GUIDE_LIMITS.cell)) });

export const sizeGuideSchema = z.object({
  enabled: z.boolean(),
  unit: z.enum(SIZE_GUIDE_UNITS),
  columns: z.array(columnSchema).min(1).max(SIZE_GUIDE_LIMITS.columns),
  rows: z.array(rowSchema).min(1).max(SIZE_GUIDE_LIMITS.rows),
}).superRefine((guide, ctx) => {
  const keys = guide.columns.map(column => column.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Measurement columns must have unique keys.', path: ['columns'] });
  guide.rows.forEach((row, index) => {
    if (Object.keys(row.values).some(key => !keys.includes(key))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A row has a measurement for a column that does not exist.', path: ['rows', index, 'values'] });
    // A guide that customers can see must be a complete table. A disabled guide may stay unfinished.
    if (guide.enabled && keys.some(key => !(row.values[key] ?? '').trim())) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Fill every measurement for size "${row.size}", or remove the row.`, path: ['rows', index, 'values'] });
  });
});
export type SizeGuide = z.infer<typeof sizeGuideSchema>;

/** What the storefront shows its own table for: enabled, with at least one column and one row. Anything else falls back to the generic guide. */
export const isUsableGuide = (guide: SizeGuide | null | undefined): guide is SizeGuide => Boolean(guide && guide.enabled && guide.columns.length > 0 && guide.rows.length > 0);

/** Validation messages for the editor (the same schema the server applies). */
export function sizeGuideProblems(guide: SizeGuide): string[] {
  const result = sizeGuideSchema.safeParse(guide);
  return result.success ? [] : Array.from(new Set(result.error.issues.map(issue => issue.message)));
}

/** The next free column key ("c1", "c2", ...). */
export const nextColumnKey = (columns: SizeGuide['columns']) => { let n = columns.length + 1; while (columns.some(column => column.key === `c${n}`)) n += 1; return `c${n}`; };

const TOP_SIZES = ['S', 'M', 'L', 'XL', 'XXL'] as const;
const WAIST_SIZES = ['28', '30', '32', '34', '36', '38'] as const;
const TOP_COLUMNS = ['Chest', 'Shoulder', 'Sleeve', 'Length'] as const;

const TEMPLATES = {
  tshirt: { label: 'T-shirt', columns: TOP_COLUMNS, sizes: TOP_SIZES },
  polo: { label: 'Polo', columns: TOP_COLUMNS, sizes: TOP_SIZES },
  shirt: { label: 'Shirt', columns: TOP_COLUMNS, sizes: TOP_SIZES },
  sweatshirt: { label: 'Sweatshirt', columns: TOP_COLUMNS, sizes: TOP_SIZES },
  hoodie: { label: 'Hoodie', columns: TOP_COLUMNS, sizes: TOP_SIZES },
  trackpant: { label: 'Track pants / Joggers', columns: ['Waist', 'Hip', 'Thigh', 'Length'], sizes: TOP_SIZES },
  trousers: { label: 'Trousers', columns: ['Waist', 'Hip', 'Thigh', 'Length'], sizes: WAIST_SIZES },
  jeans: { label: 'Jeans', columns: ['Waist', 'Hip', 'Thigh', 'Inseam'], sizes: WAIST_SIZES },
  shorts: { label: 'Shorts', columns: ['Waist', 'Hip', 'Length'], sizes: WAIST_SIZES },
} as const;
type ConcreteTemplateId = keyof typeof TEMPLATES;
/** "custom" is the safe fallback: one empty column and one empty row for the admin to define. */
export type SizeGuideTemplateId = ConcreteTemplateId | 'custom';
export const SIZE_GUIDE_TEMPLATES: ReadonlyArray<{ id: SizeGuideTemplateId; label: string }> = [
  ...(Object.keys(TEMPLATES) as ConcreteTemplateId[]).map(id => ({ id, label: TEMPLATES[id].label })),
  { id: 'custom', label: 'Custom (define your own)' },
];

/**
 * Category -> suggested starter template. EXACT slugs and explicit aliases only (no keyword guessing), so a marketing or unfamiliar category
 * can never be matched by accident. "regular-fit" is deliberately Custom: it describes a fit, not a garment. Anything not listed is Custom.
 */
const CATEGORY_ALIASES: Readonly<Record<string, SizeGuideTemplateId>> = {
  't-shirt': 'tshirt', 't-shirts': 'tshirt', tshirt: 'tshirt', tshirts: 'tshirt', tee: 'tshirt', tees: 'tshirt',
  'drop-shoulder': 'tshirt', 'drop-shoulder-t-shirt': 'tshirt', 'drop-shoulder-tee': 'tshirt',
  polo: 'polo', polos: 'polo', 'polo-shirt': 'polo', 'polo-t-shirt': 'polo',
  shirt: 'shirt', shirts: 'shirt',
  sweatshirt: 'sweatshirt', sweatshirts: 'sweatshirt',
  hoodie: 'hoodie', hoodies: 'hoodie',
  'track-pant': 'trackpant', 'track-pants': 'trackpant', trackpant: 'trackpant', trackpants: 'trackpant', joggers: 'trackpant', jogger: 'trackpant',
  trouser: 'trousers', trousers: 'trousers', chinos: 'trousers',
  jean: 'jeans', jeans: 'jeans',
  short: 'shorts', shorts: 'shorts',
  'regular-fit': 'custom',
};
const normalise = (text: string) => text.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The template to SUGGEST for a category (slug first, then the exact normalised name). A suggestion only pre-selects the dropdown; it never applies anything. */
export function suggestTemplate(category: { slug?: string | null; name?: string | null } | null | undefined): SizeGuideTemplateId {
  if (!category) return 'custom';
  for (const text of [category.slug, category.name]) {
    const hit = text ? CATEGORY_ALIASES[normalise(text)] : undefined;
    if (hit) return hit;
  }
  return 'custom';
}

/**
 * An editable starting point with EMPTY measurements (never invented numbers). Only applied when the admin chooses it.
 * "custom" is one unnamed column and one unnamed size for the admin to define.
 */
export function sizeGuideFromTemplate(id: SizeGuideTemplateId, unit: SizeGuideUnit = 'in'): SizeGuide {
  if (id === 'custom') return { enabled: true, unit, columns: [{ key: 'c1', label: '' }], rows: [{ size: '', values: { c1: '' } }] };
  const template = TEMPLATES[id];
  const columns = template.columns.map((label, index) => ({ key: `c${index + 1}`, label }));
  return { enabled: true, unit, columns, rows: template.sizes.map(size => ({ size, values: Object.fromEntries(columns.map(column => [column.key, ''])) })) };
}
export const blankSizeGuide = (): SizeGuide => sizeGuideFromTemplate('custom');

/** Drops row values whose column no longer exists (after a column is removed). */
export const pruneValues = (guide: SizeGuide): SizeGuide => {
  const keys = new Set(guide.columns.map(column => column.key));
  return { ...guide, rows: guide.rows.map(row => ({ ...row, values: Object.fromEntries(Object.entries(row.values).filter(([key]) => keys.has(key))) })) };
};

/** Reads a database row (jsonb columns) into a guide; anything malformed is treated as "no guide" so the storefront falls back to the generic table. */
export function sizeGuideFromRow(row: { enabled?: unknown; unit?: unknown; columns?: unknown; rows?: unknown } | null | undefined): SizeGuide | null {
  if (!row) return null;
  const parsed = z.object({ enabled: z.boolean(), unit: z.enum(SIZE_GUIDE_UNITS), columns: z.array(columnSchema), rows: z.array(rowSchema) }).safeParse(row);
  return parsed.success ? parsed.data : null;
}
