import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { INSTAGRAM_URL, PRODUCTION_SITE_URL, copyText, prefersNativeShare, productShareData, productShareUrl, runNativeShare, shareLinks, shareMessage, shareableOrigin, type ShareData, type ShareEnv } from '@/lib/product-share';

const SITE = 'https://one21eight.com';
const data = (slug = 'xyz'): ShareData => productShareData(productShareUrl(SITE, slug), 'Xyz Hoodie', 'ONE 2 1 EIGHT');
const norm = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('canonical product URL', () => {
  it('is the configured site origin plus the real product slug (never a hardcoded example)', () => {
    expect(productShareUrl(SITE, 'xyz')).toBe('https://one21eight.com/products/xyz');
    expect(productShareUrl(SITE, 'black-oversized-hoodie')).toBe('https://one21eight.com/products/black-oversized-hoodie');
  });
  it('differs per product, tolerates a trailing slash on the origin, and encodes unusual slugs', () => {
    expect(productShareUrl(`${SITE}/`, 'a')).toBe('https://one21eight.com/products/a');
    expect(productShareUrl(SITE, 'a')).not.toBe(productShareUrl(SITE, 'b'));
    expect(productShareUrl(SITE, 'a/b?x=1#y')).toBe('https://one21eight.com/products/a%2Fb%3Fx%3D1%23y');
  });
  it('carries nothing private: no id, query string, cart or tracking values', () => {
    expect(new URL(productShareUrl(SITE, 'xyz')).search).toBe('');
    expect(productShareUrl(SITE, 'xyz')).not.toMatch(/[?#]|utm_|token|session/i);
  });
});

describe('the shared link is always a public https URL (clickable in chats)', () => {
  it('development and staging origins are replaced by the production domain', () => {
    for (const site of ['http://localhost:3000', 'https://localhost', 'http://127.0.0.1:3000', 'http://192.168.1.20:3000', 'http://one21eight.com', 'https://shop.local', 'https://x.test', 'https://intranet', '', undefined, 'not a url']) {
      expect(shareableOrigin(site as string | undefined)).toBe(PRODUCTION_SITE_URL);
      expect(productShareUrl(site as string | undefined, 'hoodie')).toBe('https://one21eight.com/products/hoodie');
    }
  });
  it('a real https production origin is used as configured', () => {
    expect(productShareUrl('https://one21eight.com', 'hoodie')).toBe('https://one21eight.com/products/hoodie');
    expect(productShareUrl('https://www.one21eight.com/', 'hoodie')).toBe('https://www.one21eight.com/products/hoodie');
    expect(productShareUrl('https://one21eight.com', 'xyz')).toBe('https://one21eight.com/products/xyz');
  });
  it('the message has the URL alone on its own line, with nothing around it', () => {
    const message = shareMessage('Hoodie', productShareUrl('http://localhost:3000', 'hoodie'));
    expect(message).toBe('Check out this Hoodie from One2Oneight:\nhttps://one21eight.com/products/hoodie');
    expect(message.split('\n').at(-1)).toMatch(/^https:\/\/\S+$/); expect(message).not.toMatch(/["'`<>*_()\[\]]|localhost/);
  });
});

describe('share links for the desktop popover', () => {
  const links = shareLinks(data('xyz'));
  it('WhatsApp, Facebook and Email carry the product link; Instagram opens its messages (the link is copied for pasting)', () => {
    const link = encodeURIComponent('https://one21eight.com/products/xyz');
    expect(links.whatsapp).toMatch(/^https:\/\/wa\.me\/\?text=/); expect(decodeURIComponent(links.whatsapp)).toContain('https://one21eight.com/products/xyz');
    expect(links.facebook).toBe(`https://www.facebook.com/sharer/sharer.php?u=${link}`);
    expect(links.instagram).toBe(INSTAGRAM_URL); expect(links.instagram).toBe('https://www.instagram.com/direct/inbox/'); // no share-intent exists: the link is copied, Instagram opens
    expect(links.email).toMatch(/^mailto:\?subject=/); expect(decodeURIComponent(links.email)).toContain('https://one21eight.com/products/xyz');
  });
  it('uses the right product for different slugs and encodes the text safely', () => {
    const other = shareLinks(productShareData(productShareUrl(SITE, 'cargo-pants'), 'Cargo & "Pants" <new>', 'ONE 2 1 EIGHT'));
    expect(decodeURIComponent(other.whatsapp)).toContain('/products/cargo-pants'); expect(decodeURIComponent(other.whatsapp)).not.toContain('/products/xyz');
    expect(other.facebook).not.toMatch(/[<>"]/); expect(other.email).not.toMatch(/[<>" ]/);
  });
});

describe('native Web Share (touch devices) and the desktop fallback', () => {
  const touch = (share: ShareEnv['share'], canShare?: ShareEnv['canShare']): ShareEnv => ({ share, canShare, coarsePointer: true });
  it('uses the native sheet on a touch device that supports it, passing the canonical URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await runNativeShare(touch(share), data('xyz'))).toBe('shared');
    expect(share).toHaveBeenCalledWith({ url: 'https://one21eight.com/products/xyz', title: 'Xyz Hoodie | ONE 2 1 EIGHT', text: 'Check out this Xyz Hoodie from One2Oneight:' });
  });
  it('falls back to the popover on desktop (fine pointer) even when navigator.share exists, and when the API is missing', async () => {
    const share = vi.fn();
    expect(await runNativeShare({ share, coarsePointer: false }, data())).toBe('fallback'); expect(share).not.toHaveBeenCalled();
    expect(await runNativeShare({ coarsePointer: true }, data())).toBe('fallback');
    expect(prefersNativeShare({ share, canShare: () => false, coarsePointer: true }, data())).toBe(false);
  });
  it('cancelling the sheet is silent (not an error, no popover); another failure falls back to the popover', async () => {
    const cancelled = Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    expect(await runNativeShare(touch(vi.fn().mockRejectedValue(cancelled)), data())).toBe('cancelled');
    expect(await runNativeShare(touch(vi.fn().mockRejectedValue(new Error('NotAllowedError'))), data())).toBe('fallback');
  });
});

describe('copy link', () => {
  it('succeeds with the async clipboard and copies exactly the given URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText('https://one21eight.com/products/xyz', { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://one21eight.com/products/xyz');
  });
  it('handles a denied clipboard without throwing: tries the legacy copy, then reports failure', async () => {
    const denied = { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) };
    expect(await copyText('u', denied, () => true)).toBe(true);
    expect(await copyText('u', denied, () => false)).toBe(false);
    expect(await copyText('u', denied)).toBe(false);
    expect(await copyText('u', undefined, () => { throw new Error('boom'); })).toBe(false);
  });
});

describe('product page wiring (source guards)', () => {
  const component = norm('components/storefront/product-share.tsx');
  const page = norm('components/storefront/pages/product-detail-page.tsx');
  const route = norm('app/(storefront)/products/[slug]/page.tsx');
  const css = norm('app/globals.css');

  it('the share button renders inside the gallery right after the wishlist heart, with an accessible label and popover semantics', () => {
    expect(page.indexOf('<ProductShare')).toBeGreaterThan(page.indexOf('className={`gallery-wishlist'));
    expect(page.indexOf('<ProductShare')).toBeLessThan(page.indexOf('gallery-arrow-prev'));
    expect(component).toContain('aria-label={`Share ${productName}`}'); expect(component).toContain('aria-haspopup="dialog"'); expect(component).toContain('aria-expanded={open}');
  });
  it('the popover offers Copy link, WhatsApp, Facebook, Instagram and Email, closes on Escape / outside click, and shows a success message without alert()', () => {
    for (const label of ['Copy link', 'WhatsApp', 'Facebook', 'Instagram', 'Email']) expect(component).toContain(label);
    expect(component).not.toContain('Twitter'); expect(component).toContain('Paste it in Instagram'); expect(component).toContain('onClick={onInstagram}');
    expect(component).toContain("event.key === 'Escape'"); expect(component).toContain('pointerdown'); expect(component).toContain("notify('Product link copied')");
    expect(component).not.toMatch(/\balert\(|\bconfirm\(/);
  });
  it('a second tap while a share action is running is ignored, and a cancelled native sheet shows nothing', () => {
    expect(component).toContain('if (busy.current) return'); expect(component).toContain("outcome === 'fallback'");
  });
  it('the page passes the canonical URL built on the server from the configured origin and the real slug', () => {
    expect(route).toContain('canonicalUrl={productShareUrl(getSiteUrl(), product.slug)}');
    expect(page).toContain('canonicalUrl');
    expect(`${route}${component}${page}`).not.toMatch(/https:\/\/one21eight\.com\/products\/xyz/); // nothing hardcoded
  });
  it('the shared URL carries no internal id (the route is the slug)', () => {
    expect(route).not.toMatch(/productShareUrl\([^)]*\.id/);
  });
  it('open graph, twitter card and canonical metadata are built from the real product', () => {
    expect(route).toContain('alternates: { canonical: `/products/${product.slug}` }');
    expect(route).toContain("openGraph: { type: 'website', siteName: settings.brandName, title: `${product.name} | ${settings.brandName}`");
    expect(route).toContain("url: `/products/${product.slug}`, images: product.images.slice(0, 1).map(url => ({ url, alt: product.name }))");
    expect(route).toContain("twitter: { card: 'summary_large_image', title: `${product.name} | ${settings.brandName}`, description: shareDescription, images: product.images.slice(0, 1) }");
    expect(route).toContain("if (!product) return { title: 'Product not found', robots: { index: false } }"); // unknown or unpublished products are never indexed
  });
  it('sits just below the wishlist heart on desktop and keeps a 44px touch target on phones', () => {
    expect(css).toMatch(/\.product-share \{ position: absolute; top: 59px; right: 13px;/); // heart: top 13px + 42px tall + 4px gap
    expect(css).toMatch(/@media \(max-width: 760px\) \{\n  \.product-share \{ top: 54px; right: 8px; \}\n  \.gallery-share \{ width: 44px; height: 44px; \}/); // heart: top 8px + 44px tall + 2px gap
  });
  it('heart and share icons are 22px in 42px (desktop) / 44px (phone) buttons with hover, pressed and focus states', () => {
    expect(page).toContain('<Heart size={22}'); expect(component).toContain('<Share2 size={22}');
    expect(css).toMatch(/\.gallery-wishlist \{\n  position: absolute;\n  top: 13px;\n  right: 13px;\n  width: 42px;\n  height: 42px;/);
    expect(css).toMatch(/\.gallery-share \{\n  width: 42px; height: 42px;/);
    expect(css).toContain('.gallery-wishlist:active, .gallery-share:active'); expect(css).toContain('.gallery-wishlist:focus-visible');
    expect(css).toMatch(/  \.gallery-wishlist \{\n    top: 8px;\n    right: 8px;\n    width: 44px;\n    height: 44px;/);
  });
  it('does not touch wishlist, cart, checkout or auth code', () => {
    for (const file of ['components/storefront/product-share.tsx', 'lib/product-share.ts']) expect(norm(file)).not.toMatch(/useWishlist|useCart|checkout|api\.(wishlist|cart|orders|auth)/);
  });
});
