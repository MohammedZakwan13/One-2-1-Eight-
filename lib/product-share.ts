/**
 * Product sharing rules, kept pure (no React, no DOM globals read at import time) so every case is unit-tested.
 *
 * The URL that is shared is always the product's CANONICAL page: the site's configured origin (NEXT_PUBLIC_SITE_URL, resolved on the server)
 * plus the real product slug. It never carries a database id, a cart/session value, a UTM tag or anything private.
 */

export type ShareData = { url: string; title: string; text: string };
export type ShareLinks = { whatsapp: string; facebook: string; instagram: string; email: string };

/**
 * Instagram has no web share link that accepts a URL or text (unlike WhatsApp, Facebook or X), so the Instagram option copies the product link and
 * opens Instagram's messages, where it can be pasted into a chat, story or post.
 */
export const INSTAGRAM_URL = 'https://www.instagram.com/direct/inbox/';

/** The public storefront. A link must be one people (and chat apps) can open and recognise, so it is always an absolute https URL on a real domain. */
export const PRODUCTION_SITE_URL = 'https://one21eight.com';

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

const SHARE_BRAND = 'One2Oneight';
/** The sentence that goes with the link. The URL is always on its own line, with no punctuation touching it, so apps recognise it as a link. */
export const shareLine = (productName: string) => `Check out this ${productName} from ${SHARE_BRAND}:`;
export const shareMessage = (productName: string, url: string) => `${shareLine(productName)}\n${url}`;

/** What the native share sheet receives: title, a short sentence, and the bare URL in its own field. */
export function productShareData(url: string, productName: string, brandName: string): ShareData {
  return { url, title: `${productName} | ${brandName}`, text: shareLine(productName) };
}

/** Share-intent links for the desktop popover. Everything is URL-encoded; the product link is the only thing placed in the target. */
export function shareLinks({ url, title, text }: ShareData): ShareLinks {
  const link = encodeURIComponent(url);
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, // the URL stands alone on its own line
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${link}`,
    instagram: INSTAGRAM_URL,
    email: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${text}\n${url}`)}`,
  };
}

export type ShareEnv = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  /** True on touch-first devices (phones, tablets), where the native sheet is the better experience. */
  coarsePointer: boolean;
};

/** Native sharing is used only where the browser supports it AND the device is touch-first; desktop browsers get the popover. */
export const prefersNativeShare = (env: ShareEnv, data: ShareData): boolean =>
  typeof env.share === 'function' && env.coarsePointer && (env.canShare ? env.canShare(data) : true);

export type ShareOutcome = 'shared' | 'cancelled' | 'fallback' | 'failed';

/**
 * Runs the native share sheet. Cancelling it (AbortError) is a normal outcome, not an error. If the browser refuses for any other reason the
 * caller falls back to the popover, so the customer is never left without a way to share.
 */
export async function runNativeShare(env: ShareEnv, data: ShareData): Promise<ShareOutcome> {
  if (!prefersNativeShare(env, data)) return 'fallback';
  try {
    await env.share!(data);
    return 'shared';
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    return 'fallback';
  }
}

export type ClipboardLike = { writeText?: (text: string) => Promise<void> } | undefined;

/** Copies the link. Resolves false (never throws) when the clipboard is unavailable or permission is denied, so the UI can say so. */
export async function copyText(text: string, clipboard: ClipboardLike, legacyCopy?: (text: string) => boolean): Promise<boolean> {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return true; }
  } catch { /* permission denied or insecure context: try the legacy path below */ }
  try { return legacyCopy ? legacyCopy(text) : false; } catch { return false; }
}
