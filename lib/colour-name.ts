/**
 * Storefront colour labels. The admin saves a colour as free text: usually a name ("Dusty Mauve"), sometimes a hex code ("81A19F" or "#81a19f").
 * A name is shown exactly as saved. A hex code is never shown to customers: it is turned into the closest everyday colour name instead.
 * Display only: the saved value, the swatch colour, filtering and the cart all keep using the original text.
 */

type Rgb = [number, number, number];

// Everyday fashion colour names (sRGB). The nearest one, measured in the CIELAB colour space, labels a hex code.
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['Black', '#111111'], ['Jet Black', '#000000'], ['Charcoal', '#36393d'], ['Dark Grey', '#555a5f'], ['Grey', '#808488'], ['Light Grey', '#bfc2c4'], ['Silver', '#d4d6d8'],
  ['White', '#ffffff'], ['Off White', '#f4f1ea'], ['Ivory', '#f6efdc'], ['Cream', '#efe3c6'],
  ['Beige', '#d9c7a6'], ['Sand', '#cdb78f'], ['Stone', '#b8ae9d'], ['Taupe', '#8f8070'], ['Khaki', '#a8996b'], ['Camel', '#b98a52'], ['Tan', '#a9743f'],
  ['Brown', '#6a4430'], ['Chocolate', '#432a20'], ['Coffee', '#5b3e2f'],
  ['Maroon', '#6e1f2a'], ['Burgundy', '#7a1230'], ['Wine', '#5e1a2d'], ['Red', '#c8202a'], ['Bright Red', '#e0201f'], ['Rust', '#a4472a'], ['Terracotta', '#c0694a'], ['Brick Red', '#9c3a30'],
  ['Coral', '#ee7a6b'], ['Salmon', '#f0988a'], ['Peach', '#f6bfa0'], ['Orange', '#ee7a1f'], ['Burnt Orange', '#c9611f'],
  ['Mustard', '#d3a516'], ['Yellow', '#f2d122'], ['Lemon', '#f4e56a'], ['Gold', '#c9a24a'],
  ['Pink', '#f08fb0'], ['Hot Pink', '#e8458b'], ['Baby Pink', '#f6cfdc'], ['Blush', '#efc4c0'], ['Dusty Rose', '#c78e92'], ['Mauve', '#a58597'], ['Magenta', '#b3267a'],
  ['Purple', '#6c3a99'], ['Violet', '#8a5fc2'], ['Lavender', '#b9a6d9'], ['Lilac', '#cdb4d8'], ['Plum', '#55294f'],
  ['Navy Blue', '#1c2a4a'], ['Midnight Blue', '#121c33'], ['Royal Blue', '#2753b0'], ['Blue', '#2f6fd0'], ['Cobalt Blue', '#0b4fa8'], ['Sky Blue', '#7db8e6'], ['Baby Blue', '#b7d6ee'], ['Powder Blue', '#c6d8e4'], ['Steel Blue', '#5f7f9c'], ['Denim Blue', '#40597d'],
  ['Teal', '#1f7a7a'], ['Turquoise', '#27b5b0'], ['Aqua', '#6fd3d0'], ['Seafoam', '#8cc7b0'], ['Mint', '#b2e0c8'],
  ['Sage Green', '#8fa28b'], ['Olive', '#6f7133'], ['Army Green', '#4b5a3a'], ['Forest Green', '#1f4a31'], ['Bottle Green', '#0e3b2b'], ['Green', '#2e8b4f'], ['Emerald', '#0f9a6a'], ['Lime', '#9ccf3a'],
];

/** "81A19F", "#81a19f" or "#8a9" (the short form needs the "#", so a word like "Fed" is never mistaken for a code). */
const HEX_CODE = /^(?:#([0-9a-f]{3}|[0-9a-f]{6})|([0-9a-f]{6}))$/i;

export function parseHexColour(text: string | null | undefined): Rgb | null {
  const match = HEX_CODE.exec((text ?? '').trim());
  if (!match) return null;
  let hex = (match[1] ?? match[2]) as string;
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toLab([r, g, b]: Rgb): Rgb {
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const LAB_PALETTE = PALETTE.map(([name, hex]) => ({ name, lab: toLab(parseHexColour(hex) as Rgb) }));

/** The everyday name closest to a colour. */
export function nearestColourName(rgb: Rgb): string {
  const lab = toLab(rgb);
  let best = LAB_PALETTE[0]!;
  let bestDistance = Infinity;
  for (const entry of LAB_PALETTE) {
    const d = (entry.lab[0] - lab[0]) ** 2 + (entry.lab[1] - lab[1]) ** 2 + (entry.lab[2] - lab[2]) ** 2;
    if (d < bestDistance) { bestDistance = d; best = entry; }
  }
  return best.name;
}

/** What a customer sees for a product's colour: the saved name as it is, or, when the saved text is a hex code, the matching colour name. */
export function colourLabel(saved: string | null | undefined): string {
  const text = (saved ?? '').trim();
  const rgb = parseHexColour(text);
  return rgb ? nearestColourName(rgb) : text;
}
