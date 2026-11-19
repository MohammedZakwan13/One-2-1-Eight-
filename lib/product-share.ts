/**
 * Product sharing rules, kept pure (no React, no DOM globals read at import time) so every case is unit-tested.
 *
 * The URL that is shared is always the product's CANONICAL page: a public https origin (the configured site URL, or the production domain when
 * that is a development address) plus the real product slug. It never carries a database id, a cart/session value, a UTM tag or anything private.
 */

export type ShareLinks = { whatsapp: string; facebook: string; email: string };

/** The public storefront. A link must be one people (and chat apps) can open and recognise, so it is always an absolute https URL on a real domain. */
export const PRODUCTION_SITE_URL = 'https://one21eight.com';
export const SHARE_BRAND = 'ONE 2 1 EIGHT';

/**
 * The origin used in shared links: the configured site URL when it is a real public https origin (production), otherwise the production domain.
 * A development or staging origin (localhost, an IP address, .local/.test hosts, plain http) is never shared: chat apps do not make such text clickable
 * and nobody else could open it.
 */
export function shareableOrigin(siteUrl: string | undefined): string {
  try {
    const url = new URL(siteUrl ?? '');
    const host = url.hostname.toLowerCase();
    const isPrivate = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.internal')
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.');
    if (url.protocol === 'https:' && !isPrivate) return url.origin;
  } catch { /* not a URL: use the production domain */ }
  return PRODUCTION_SITE_URL;
}

/** Canonical product URL: `https://<public domain>/products/<slug>`, nothing else. The slug is encoded so odd slugs cannot break out of the path. */
export function productShareUrl(siteUrl: string | undefined, slug: string): string {
  return `${shareableOrigin(siteUrl)}/products/${encodeURIComponent(slug)}`;
}

/** A single product's complete share content, built once from the real product data. Every channel reads from it. */
export type SharePayload = {
  url: string; name: string; title: string; priceText: string; description: string;
  /** The primary product image as an absolute https URL, or null when the product has none. */
  imageUrl: string | null;
  /** Text for the native sheet when the URL travels in its own field. */
  nativeText: string;
  /** The same content with the URL on its own final line (used when an image file is shared and the URL must travel inside the text). */
  fullText: string;
  whatsappMessage: string;
  /** "Copy product details" and the Instagram caption. */
  detailsText: string;
  /** The Instagram caption: name, price, brand and the direct product URL. */
  instagramCaption: string;
  emailSubject: string; emailBody: string;
};

export const shortDescription = (text: string | undefined, max = 140): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
};

const formatPrice = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;
const lines = (...parts: string[]) => parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

/** Makes an image reference absolute and https: relative paths use the product's own origin; anything that cannot be a public https image is dropped. */
export function absoluteImageUrl(image: string | undefined, origin: string): string | null {
  if (!image) return null;
  try {
    const url = new URL(image, `${origin}/`);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

/** Builds the share content for one product. Pure: the same on the server, in the browser and in tests. */
export function productSharePayload(input: { siteUrl: string | undefined; slug: string; name: string; price: number; description?: string; image?: string; brandName?: string }): SharePayload {
  const origin = shareableOrigin(input.siteUrl);
  const url = productShareUrl(input.siteUrl, input.slug);
  const brand = input.brandName || SHARE_BRAND;
  const priceText = formatPrice(input.price);
  const description = shortDescription(input.description);
  const nativeText = lines(`${input.name} — ${priceText}`, description);
  return {
    url, name: input.name, title: `${input.name} | ${brand}`, priceText, description,
    imageUrl: absoluteImageUrl(input.image, origin),
    nativeText,
    fullText: lines(nativeText, '', 'Shop here:', url),
    whatsappMessage: lines(`Discover ${input.name} from ${brand}.`, '', `Price: ${priceText}`, '', 'Shop here:', url),
    detailsText: lines(input.name, `Price: ${priceText}`, description, '', url),
    instagramCaption: lines(`${input.name} — ${priceText}`, description, '', `Shop ${brand}:`, url),
    emailSubject: `${input.name} from ${brand}`,
    emailBody: lines(`I found this on ${brand}:`, '', input.name, `Price: ${priceText}`, description, '', 'View it here:', url),
  };
}

/** Share-intent links for the popover. Everything is URL-encoded; the product link always stands alone on its own line. */
export function shareLinks(payload: SharePayload): ShareLinks {
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(payload.whatsappMessage)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(payload.url)}`,
    email: `mailto:?subject=${encodeURIComponent(payload.emailSubject)}&body=${encodeURIComponent(payload.emailBody)}`,
  };
}

export type NativeShareData = { title: string; text: string; url?: string; files?: File[] };

export type ShareEnv = {
  share?: (data: NativeShareData) => Promise<void>;
  canShare?: (data: NativeShareData) => boolean;
  /** True on touch-first devices (phones, tablets), where the native sheet is the better experience. */
  coarsePointer: boolean;
};

/** What the native sheet receives: the real image file plus the details (URL inside the text) when files can be shared, otherwise text and the bare URL. */
export function nativeShareData(payload: SharePayload, file?: File | null): NativeShareData {
  return file ? { title: payload.title, text: payload.fullText, files: [file] } : { title: payload.title, text: payload.nativeText, url: payload.url };
}

/** Native sharing is used only where the browser supports it AND (unless forced) the device is touch-first; desktop browsers get the popover. */
export const prefersNativeShare = (env: ShareEnv, data: NativeShareData, force = false): boolean =>
  typeof env.share === 'function' && (force || env.coarsePointer) && (env.canShare ? env.canShare(data) : true);

/** True when the browser can share this image file through the system sheet. */
export const canShareFile = (env: ShareEnv, payload: SharePayload, file: File | null | undefined): boolean =>
  !!file && typeof env.share === 'function' && typeof env.canShare === 'function' && env.canShare(nativeShareData(payload, file));

export type ShareOutcome = 'shared' | 'cancelled' | 'fallback';
export type ShareResult = { outcome: ShareOutcome; withImage: boolean };

/**
 * Runs the native share sheet, with the product image when the browser can share files and otherwise with title, details and URL. Cancelling it
 * (AbortError) is a normal outcome, not an error; "shared" is reported only after the browser confirms the share finished. If the browser refuses
 * for any other reason the caller falls back to the popover, so the customer is never left without a way to share.
 */
export async function runNativeShare(env: ShareEnv, payload: SharePayload, file?: File | null, options: { force?: boolean } = {}): Promise<ShareResult> {
  const withFile = canShareFile(env, payload, file);
  const data = nativeShareData(payload, withFile ? file : null);
  if (!prefersNativeShare(env, data, options.force)) return { outcome: 'fallback', withImage: false };
  try {
    await env.share!(data);
    return { outcome: 'shared', withImage: withFile };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { outcome: 'cancelled', withImage: withFile };
    return { outcome: 'fallback', withImage: false };
  }
}

export type ClipboardLike = { writeText?: (text: string) => Promise<void> } | undefined;

/** Copies text. Resolves false (never throws) when the clipboard is unavailable or permission is denied, so the UI can say so. */
export async function copyText(text: string, clipboard: ClipboardLike, legacyCopy?: (text: string) => boolean): Promise<boolean> {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return true; }
  } catch { /* permission denied or insecure context: try the legacy path below */ }
  try { return legacyCopy ? legacyCopy(text) : false; } catch { return false; }
}

/** File name and extension for a downloaded / shared product image. */
export function imageFileName(slug: string, mime: string): string {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' }[mime.split(';')[0].trim()] ?? 'jpg';
  return `${slug.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'product'}.${ext}`;
}
