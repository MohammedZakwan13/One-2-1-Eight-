/** Stock-message modes and the single low-stock rule. Real inventory lives only in product_variants.stock; nothing here changes it. */

export type StockMessageMode = 'none' | 'real' | 'custom';
export const STOCK_MESSAGE_MODES: readonly StockMessageMode[] = ['none', 'real', 'custom'];
export const STOCK_MESSAGE_MAX = 160;
export const DEFAULT_REAL_MESSAGE = 'left';

/** Low stock = 1..threshold units. 0 is out of stock (not low); above the threshold is normal. */
export const isLowStock = (stock: number, threshold: number) => stock > 0 && stock <= threshold;

/** The sizes of one product that are low on stock. */
export const lowStockSizes = <T extends { stock: number }>(variants: readonly T[], threshold: number): T[] => variants.filter(variant => isLowStock(variant.stock, threshold));

/** Only ACTIVE products count (draft/hidden never do). Variants passed in must already be the active ones. A product counts once however many sizes are low. */
export const lowStockSizesOfProduct = <T extends { stock: number }>(product: { status: string; variants: readonly T[] }, threshold: number | undefined): T[] =>
  threshold === undefined || product.status !== 'active' ? [] : lowStockSizes(product.variants, threshold);

/** Products saved before modes existed keep their text as Custom Stock (flagged for review in the admin). */
export const effectiveStockMode = (product: { stockMessageMode?: StockMessageMode | null; stockMessage?: string | null }): StockMessageMode =>
  product.stockMessageMode ?? (product.stockMessage?.trim() ? 'custom' : 'none');

const NUM = '\\d+\\b(?![\\s]*[%°])|one|two|three|four|five|six|seven|eight|nine|ten|few|couple';
const CLAIMS = [
  // "3 left", "two items left", "5 in stock", "few remaining"
  new RegExp(`\\b(?:${NUM})\\s+(?:\\w+\\s+)?(?:left|remaining|available|in\\s+stock)\\b`, 'i'),
  // "only 2", "just a few", "last piece", "final unit"
  new RegExp(`\\b(?:only|just|last|final)\\s+(?:a\\s+)?(?:${NUM}|piece|pieces|unit|units|item|items|size|sizes|stock)\\b`, 'i'),
];

/**
 * Best-effort guard against false-scarcity claims ("3 left", "Only 2 remaining", "Last piece").
 * Ordinary text such as "100% cotton" or "Machine wash at 30°C" is allowed. Returns an error message or null.
 */
export function stockTextError(text: string | null | undefined): string | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  return CLAIMS.some(pattern => pattern.test(value))
    ? 'Stock message cannot state a quantity or scarcity such as "3 left", "Only 2 remaining" or "Last piece". Use Real Stock Message to show actual quantities.'
    : null;
}

/** The line shown under the size picker. `quantity` is the selected size's real stock (present only in Real mode and the only number Real mode ever uses). */
export function stockLine(mode: StockMessageMode, message: string | null | undefined, quantity: number | undefined, customNumber?: number | null): string | null {
  const text = message?.trim() ?? '';
  // Custom mode: admin-entered display number + text. Promotional copy only; it never reads or affects inventory.
  if (mode === 'custom') return [customNumber == null ? '' : String(customNumber), text].filter(Boolean).join(' ') || null;
  if (mode === 'real') {
    if (quantity === undefined) return null;
    if (quantity <= 0) return 'Out of stock';
    return `${quantity} ${text || DEFAULT_REAL_MESSAGE}`;
  }
  return null;
}

export type LowStockRow = { productId: string; name: string; size: string; sku: string; stock: number };

/** Dashboard Low Stock: each affected PRODUCT counts once; the list shows the low sizes (lowest stock first). Rows must come from ACTIVE products and ACTIVE variants. */
export function summarizeLowStock(rows: readonly LowStockRow[], threshold: number, limit = 12) {
  const low = rows.filter(row => isLowStock(row.stock, threshold)).sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name) || a.size.localeCompare(b.size));
  return { count: new Set(low.map(row => row.productId)).size, items: low.slice(0, limit) };
}

export type StockSavePlan =
  | { send: false }
  | { send: true; variants: { size: string; stock: number }[]; expectedStock?: Record<string, number> };

/**
 * Explicit inventory-change intent. Stock is only included in a save when the admin actually changed a size quantity
 * (or is creating a product). `original` is the snapshot loaded with the product; it is sent back as the expected stock
 * so the server can reject the update if an order (or another admin) changed stock in the meantime.
 */
export function planStockSave(original: Record<string, number> | null, stock: Record<string, string>, sizes: readonly string[]): StockSavePlan {
  const variants = sizes.filter(size => (stock[size] ?? '') !== '').map(size => ({ size, stock: Number(stock[size]) }));
  if (original === null) return { send: true, variants };
  const changed = sizes.some(size => (stock[size] ?? '') !== (original[size] === undefined ? '' : String(original[size])));
  return changed ? { send: true, variants, expectedStock: { ...original } } : { send: false };
}
