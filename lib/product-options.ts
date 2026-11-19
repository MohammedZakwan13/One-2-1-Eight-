/** Admin-editor helpers. Values are still stored as plain text (fit, material, colour) and #rrggbb (colorHex): no schema change. */

export const FIT_OPTIONS = ['Regular fit', 'Slim fit', 'Relaxed fit', 'Oversized fit', 'Loose fit', 'Classic fit', 'Athletic fit', 'Cropped fit'] as const;

export const MATERIAL_OPTIONS = [
  '100% Cotton', 'Organic Cotton', 'Cotton Blend', 'Polyester', 'Cotton Polyester', 'Linen', 'Rayon', 'Viscose', 'Wool', 'Fleece', 'Denim', 'Nylon', 'Spandex / Elastane', 'French Terry',
] as const;

export const COLOR_SWATCHES: Record<string, string> = {
  Black: '#242424', White: '#ffffff', 'Off White': '#f5f1e8', Ivory: '#fffff0', Cream: '#f3ead3', Beige: '#d9c7a3', Sand: '#c8b28a', Khaki: '#a8996b', Brown: '#6b4a32', Tan: '#b08a5c',
  Grey: '#808080', 'Light Grey': '#c4c4c4', 'Dark Grey': '#4a4a4a', Charcoal: '#36393d', Navy: '#1f2a44', Blue: '#2f5fa7', 'Sky Blue': '#8ec5e8', Teal: '#2a7f80',
  Green: '#3b7d4f', Olive: '#6b6b3a', 'Forest Green': '#2d5a3d', Maroon: '#6e1f2b', Red: '#b3261e', Burgundy: '#722f37', Orange: '#e07a2d', Rust: '#a5482a',
  Yellow: '#e8c547', Mustard: '#c9a227', Pink: '#e8a0b4', Purple: '#6a4c93', Lavender: '#b9a8d6',
};

const ALIASES: Record<string, string> = {
  gray: 'Grey', 'light gray': 'Light Grey', 'dark gray': 'Dark Grey', offwhite: 'Off White', 'off-white': 'Off White', 'navy blue': 'Navy',
  'sky blue': 'Sky Blue', 'bottle green': 'Forest Green', wine: 'Burgundy', 'charcoal grey': 'Charcoal', 'charcoal gray': 'Charcoal',
};
const LOOKUP = new Map<string, string>([
  ...Object.entries(COLOR_SWATCHES).map(([name, hex]) => [name.toLowerCase(), hex] as [string, string]),
  ...Object.entries(ALIASES).map(([alias, name]) => [alias, COLOR_SWATCHES[name]] as [string, string]),
]);

/** Resolves a colour name, alias, or #hex (3 or 6 digits) to #rrggbb. Returns null when the text is not recognised. */
export function colorToHex(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return `#${digits}`;
  }
  return LOOKUP.get(value) ?? null;
}

export type MerchFlag = 'bestSeller' | 'newArrival' | 'luxe';
export const MERCH_FILTERS: { key: MerchFlag; label: string }[] = [
  { key: 'bestSeller', label: 'Best seller' }, { key: 'newArrival', label: 'New arrival' }, { key: 'luxe', label: 'Luxe collection' },
];

/** OR logic: no selection shows everything; otherwise a product matches when it has at least one selected flag. */
export const matchesMerchFilters = (product: Record<MerchFlag, boolean>, selected: MerchFlag[]) =>
  selected.length === 0 || selected.some(flag => product[flag] === true);
