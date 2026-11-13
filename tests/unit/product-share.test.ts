import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PRODUCTION_SITE_URL, absoluteImageUrl, canShareFile, copyText, imageFileName, nativeShareData, prefersNativeShare, productSharePayload, productShareUrl, runNativeShare, shareLinks, shareableOrigin, shortDescription, type ShareEnv, type SharePayload } from '@/lib/product-share';

const SITE = 'https://one21eight.com';
const norm = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const hoodie = (overrides: Partial<Parameters<typeof productSharePayload>[0]> = {}): SharePayload => productSharePayload({
  siteUrl: SITE, slug: 'hoodie', name: 'Hoodie', price: 999, description: 'Regular fit. 100% cotton.\nModel is styled for an editorial look.', image: 'https://cdn.example.com/media/hoodie.jpg', brandName: 'ONE 2 1 EIGHT', ...overrides,
});
const file = () => new File([new Uint8Array([1, 2, 3])], 'hoodie.jpg', { type: 'image/jpeg' });

describe('canonical product URL', () => {
  it('is the configured public https origin plus the real product slug (never a hardcoded example)', () => {
    expect(productShareUrl(SITE, 'hoodie')).toBe('https://one21eight.com/products/hoodie');
    expect(productShareUrl(SITE, 'black-oversized-hoodie')).toBe('https://one21eight.com/products/black-oversized-hoodie');
    expect(productShareUrl(`${SITE}/`, 'a')).toBe('https://one21eight.com/products/a');
  });
  it('development and staging origins are replaced by the production domain: no localhost, no http, no private hosts', () => {
    for (const site of ['http://localhost:3000', 'https://localhost', 'http://127.0.0.1:3000', 'http://192.168.1.20:3000', 'http://one21eight.com', 'https://shop.local', 'https://x.test', 'https://intranet', '', undefined, 'not a url']) {
      expect(shareableOrigin(site as string | undefined)).toBe(PRODUCTION_SITE_URL);
      expect(productShareUrl(site as string | undefined, 'hoodie')).toBe('https://one21eight.com/products/hoodie');
    }
  });
  it('differs per product, encodes unusual slugs, and carries nothing private', () => {
    expect(productShareUrl(SITE, 'a')).not.toBe(productShareUrl(SITE, 'b'));
    expect(productShareUrl(SITE, 'a/b?x=1#y')).toBe('https://one21eight.com/products/a%2Fb%3Fx%3D1%23y');
    expect(productShareUrl(SITE, 'hoodie')).not.toMatch(/[?#]|utm_|token|session/i);
  });
});

describe('share payload built from the real product', () => {
  it('has the product name, INR price, short description, canonical URL and an absolute https image', () => {
    const p = hoodie();
    expect(p).toMatchObject({ url: 'https://one21eight.com/products/hoodie', name: 'Hoodie', title: 'Hoodie | ONE 2 1 EIGHT', priceText: '₹999', imageUrl: 'https://cdn.example.com/media/hoodie.jpg' });
    expect(p.description).toBe('Regular fit. 100% cotton. Model is styled for an editorial look.');
  });
  it('another product gets its own data and URL (nothing from the Hoodie leaks in)', () => {
    const p = productSharePayload({ siteUrl: 'http://localhost:3000', slug: 'cargo-pants', name: 'Cargo Pants', price: 1499.5, description: '', image: '/images/products/cargo.webp' });
    expect(p.url).toBe('https://one21eight.com/products/cargo-pants'); expect(p.priceText).toBe('₹1,500'); expect(p.imageUrl).toBe('https://one21eight.com/images/products/cargo.webp');
    expect(JSON.stringify(p)).not.toMatch(/Hoodie|hoodie|localhost/);
  });
  it('missing image or description degrade gracefully; a non-https image is never shared', () => {
    expect(hoodie({ image: undefined }).imageUrl).toBeNull();
    expect(hoodie({ image: 'http://cdn.example.com/a.jpg' }).imageUrl).toBeNull();
    expect(hoodie({ description: undefined }).detailsText).toBe('Hoodie\nPrice: ₹999\n\nhttps://one21eight.com/products/hoodie');
    expect(absoluteImageUrl('data:image/png;base64,AAAA', SITE)).toBeNull();
  });
  it('shortens long descriptions at a word boundary', () => {
    expect(shortDescription('word '.repeat(100), 40).length).toBeLessThanOrEqual(40); expect(shortDescription('word '.repeat(100), 40)).toMatch(/…$/);
  });
});

describe('WhatsApp, Facebook and Email', () => {
  const links = shareLinks(hoodie());
  it('WhatsApp: sentence, price and the URL alone on its own final line, correctly encoded', () => {
    expect(links.whatsapp).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const message = decodeURIComponent(links.whatsapp.split('?text=')[1]);
    expect(message).toBe('Discover Hoodie from ONE 2 1 EIGHT.\n\nPrice: ₹999\n\nShop here:\nhttps://one21eight.com/products/hoodie');
    expect(message.split('\n').at(-1)).toMatch(/^https:\/\/\S+$/); expect(message).not.toMatch(/localhost|["'`<>*]/);
    expect(links.whatsapp).toContain('%0Ahttps%3A%2F%2Fone21eight.com%2Fproducts%2Fhoodie'); // encodeURIComponent'd, URL after a newline
  });
  it('Facebook shares the product URL (the preview comes from the page metadata)', () => {
    expect(links.facebook).toBe('https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fone21eight.com%2Fproducts%2Fhoodie');
  });
  it('Email: product name in the subject; name, price, description and the URL in the body', () => {
    expect(links.email).toMatch(/^mailto:\?subject=/);
    const [, subject, body] = /^mailto:\?subject=([^&]*)&body=(.*)$/.exec(links.email)!;
    expect(decodeURIComponent(subject)).toBe('Hoodie from ONE 2 1 EIGHT');
    expect(decodeURIComponent(body)).toBe('I found this on ONE 2 1 EIGHT:\n\nHoodie\nPrice: ₹999\nRegular fit. 100% cotton. Model is styled for an editorial look.\n\nView it here:\nhttps://one21eight.com/products/hoodie');
    expect(links.email).not.toMatch(/ |\n|"/);
  });
  it('each product produces its own links', () => {
    const other = shareLinks(productSharePayload({ siteUrl: SITE, slug: 'cargo-pants', name: 'Cargo & "Pants" <new>', price: 1499 }));
    expect(decodeURIComponent(other.whatsapp)).toContain('/products/cargo-pants'); expect(decodeURIComponent(other.whatsapp)).not.toContain('/products/hoodie');
    expect(other.facebook).not.toMatch(/[<>" ]/); expect(other.email).not.toMatch(/[<>" ]/);
  });
});

describe('Instagram caption', () => {
  it('has the product name, price, brand and the direct product URL on its own final line', () => {
    const caption = hoodie().instagramCaption;
    expect(caption).toBe('Hoodie — ₹999\nRegular fit. 100% cotton. Model is styled for an editorial look.\n\nShop ONE 2 1 EIGHT:\nhttps://one21eight.com/products/hoodie');
    expect(caption.split('\n').at(-1)).toMatch(/^https:\/\/\S+$/); expect(caption).not.toMatch(/localhost|["'`<>*]/);
    expect(productSharePayload({ siteUrl: 'http://localhost:3000', slug: 'cargo-pants', name: 'Cargo Pants', price: 1499 }).instagramCaption).toBe('Cargo Pants — ₹1,499\n\nShop ONE 2 1 EIGHT:\nhttps://one21eight.com/products/cargo-pants');
  });
});

describe('copy actions', () => {
  it('Copy product details = title, price, description and the standalone URL; Copy link = the URL only', async () => {
    const p = hoodie();
    expect(p.detailsText).toBe('Hoodie\nPrice: ₹999\nRegular fit. 100% cotton. Model is styled for an editorial look.\n\nhttps://one21eight.com/products/hoodie');
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText(p.url, { writeText })).toBe(true); expect(writeText).toHaveBeenCalledWith('https://one21eight.com/products/hoodie');
    expect(p.url).toMatch(/^https:\/\/[^\s"'`*<>]+$/);
  });
  it('a denied clipboard never throws: legacy copy, then an honest false', async () => {
    const denied = { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) };
    expect(await copyText('u', denied, () => true)).toBe(true);
    expect(await copyText('u', denied, () => false)).toBe(false);
    expect(await copyText('u', denied)).toBe(false);
    expect(await copyText('u', undefined, () => { throw new Error('boom'); })).toBe(false);
  });
});

describe('native sharing with the real product image', () => {
  const touch = (share: ShareEnv['share'], canShare?: ShareEnv['canShare']): ShareEnv => ({ share, canShare, coarsePointer: true });
  it('shares the image FILE with title, details and the URL when the browser can share files', async () => {
    const share = vi.fn().mockResolvedValue(undefined); const canShare = vi.fn().mockReturnValue(true); const f = file();
    expect(await runNativeShare(touch(share, canShare), hoodie(), f)).toEqual({ outcome: 'shared', withImage: true });
    expect(canShare).toHaveBeenCalledWith(expect.objectContaining({ files: [f] }));
    const sent = share.mock.calls[0][0];
    expect(sent.files).toEqual([f]); expect(sent.title).toBe('Hoodie | ONE 2 1 EIGHT'); expect(sent.text).toContain('Hoodie — ₹999'); expect(sent.text).toContain('Regular fit.'); expect(sent.text.split('\n').at(-1)).toBe('https://one21eight.com/products/hoodie');
  });
  it('falls back to title, details and URL (no file) when files cannot be shared', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await runNativeShare(touch(share, data => !data.files), hoodie(), file())).toEqual({ outcome: 'shared', withImage: false });
    expect(share).toHaveBeenCalledWith({ title: 'Hoodie | ONE 2 1 EIGHT', text: expect.stringContaining('Hoodie — ₹999'), url: 'https://one21eight.com/products/hoodie' });
    expect(await runNativeShare(touch(vi.fn().mockResolvedValue(undefined)), hoodie(), null)).toEqual({ outcome: 'shared', withImage: false });
  });
  it('is only "shared" after the browser confirms; cancelling is silent; any other failure falls back to the menu', async () => {
    let finish!: () => void;
    const pending = runNativeShare(touch(() => new Promise<void>(resolve => { finish = resolve; })), hoodie(), null);
    const early = await Promise.race([pending, Promise.resolve('not yet')]); expect(early).toBe('not yet'); // nothing reported before the share sheet finishes
    finish(); expect(await pending).toEqual({ outcome: 'shared', withImage: false });
    const cancelled = Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    expect((await runNativeShare(touch(vi.fn().mockRejectedValue(cancelled)), hoodie(), file())).outcome).toBe('cancelled');
    expect((await runNativeShare(touch(vi.fn().mockRejectedValue(new Error('NotAllowedError'))), hoodie(), file())).outcome).toBe('fallback');
  });
  it('desktop browsers get the menu even when navigator.share exists, unless explicitly asked; no API means the menu', async () => {
    const share = vi.fn();
    expect((await runNativeShare({ share, coarsePointer: false }, hoodie(), null)).outcome).toBe('fallback'); expect(share).not.toHaveBeenCalled();
    expect((await runNativeShare({ share: share.mockResolvedValue(undefined), coarsePointer: false }, hoodie(), null, { force: true })).outcome).toBe('shared');
    expect((await runNativeShare({ coarsePointer: true }, hoodie(), null)).outcome).toBe('fallback');
    expect(prefersNativeShare({ share, canShare: () => false, coarsePointer: true }, nativeShareData(hoodie()))).toBe(false);
    expect(canShareFile({ share, coarsePointer: true }, hoodie(), file())).toBe(false); // canShare missing: files are not attempted
  });
  it('names the image file after the product with the right extension', () => {
    expect(imageFileName('hoodie', 'image/webp')).toBe('hoodie.webp'); expect(imageFileName('Black Hoodie!', 'image/jpeg')).toBe('black-hoodie-.jpg'); expect(imageFileName('', 'application/x')).toBe('product.jpg');
  });
});

describe('product page wiring (source guards)', () => {
  const component = norm('components/storefront/product-share.tsx');
  const page = norm('components/storefront/pages/product-detail-page.tsx');
  const route = norm('app/(storefront)/products/[slug]/page.tsx');
  const css = norm('app/globals.css');

  it('Wishlist and Share live together in one overlay container INSIDE the image box, heart first, away from the gallery arrows', () => {
    const main = page.indexOf('<div className="gallery-main"');
    const actions = page.indexOf('<div className="gallery-actions">');
    expect(actions).toBeGreaterThan(main); expect(actions).toBeLessThan(page.indexOf('gallery-arrow-prev'));
    expect(page.indexOf('gallery-wishlist')).toBeGreaterThan(actions); expect(page.indexOf('<ProductShare payload={sharePayload} />')).toBeGreaterThan(page.indexOf('gallery-wishlist'));
    expect(page.slice(actions, page.indexOf('</div>', actions))).toContain('onToggleWishlist(product.id)'); // the wishlist handler is exactly the existing one
  });
  it('the share payload comes from the real product (name, price, description, first image) and the canonical URL', () => {
    expect(page).toContain('productSharePayload({'); for (const field of ['slug: product.slug', 'name: product.name', 'price: product.price', 'description: product.description', 'image: product.images[0]']) expect(page).toContain(field);
    expect(route).toContain('canonicalUrl={productShareUrl(getSiteUrl(), product.slug)}');
    expect(`${route}${component}${page}`).not.toMatch(/https:\/\/one21eight\.com\/products\//); // nothing hardcoded
  });
  it('the menu offers the required actions, renders in a portal (no clipping), and is keyboard accessible', () => {
    for (const label of ['Share with your device', 'Copy link', 'Copy product details', 'WhatsApp', 'Facebook', 'Instagram', 'Email', 'Download product image', 'Copy caption']) expect(component).toContain(label);
    expect(component).toContain('createPortal'); expect(component).toContain("event.key === 'Escape'"); expect(component).toContain('aria-haspopup="dialog"'); expect(component).toContain('data-share-first');
    expect(component).not.toMatch(/\balert\(|\bconfirm\(|Twitter/);
  });
  it('Instagram has its own panel and never invokes the system share dialog by itself; it claims nothing was attached', () => {
    expect(component).toContain("const onInstagram = () => { setView('instagram'); setFallbackText(''); };"); // opens the panel only: no navigator.share, no external site
    expect(component).toContain('Instagram does not accept images or captions from websites'); expect(component).not.toMatch(/instagram\.com/);
    expect(component).toContain('Share image with your device (optional)'); expect(component).toContain('nativeAvailable && touchDevice'); // optional, touch devices only
    expect(component).toContain("copy(payload.instagramCaption, 'caption')");
  });
  it('success is reported only after the operation succeeds (clipboard, native share); cancel is silent; duplicate taps are ignored', () => {
    expect(component).toContain("notify(kind === 'link' ? 'Product link copied' : kind === 'caption' ? 'Caption copied' : 'Product details copied')"); expect(component).toContain("result.outcome === 'shared'");
    expect(component).toContain('if (busy.current) return');
  });
  it('metadata: canonical, Open Graph (title, description, image, url, type) and Twitter card from the real product, with an image fallback', () => {
    expect(route).toContain('alternates: { canonical: `/products/${product.slug}` }');
    expect(route).toContain("openGraph: { type: 'website', siteName: settings.brandName, title: `${product.name} | ${settings.brandName}`, description: shareDescription, url: `/products/${product.slug}`, ...(image ? { images: [{ url: image, alt: product.name }] } : {}) }");
    expect(route).toContain("twitter: { card: 'summary_large_image', title: `${product.name} | ${settings.brandName}`, description: shareDescription, ...(image ? { images: [image] } : {}) }");
    expect(route).toContain('product.images[0] || heroSlides[0]?.desktopImage'); expect(route).toContain("if (!product) return { title: 'Product not found', robots: { index: false } }");
  });
  it('the buttons float top-right INSIDE the image box: 44px circles, 22px icons, 16px from the corner, 8px apart; the image box is the size of the image area', () => {
    expect(css).toMatch(/\.gallery-actions \{\n  position: absolute;\n  top: 16px;\n  right: 16px;[^}]*flex-direction: column;\n  gap: 8px;/);
    expect(css).toMatch(/\.gallery-wishlist, \.gallery-share \{\n  width: 44px;\n  height: 44px;/); expect(css).toMatch(/border-radius: 50%;\n  box-shadow: 0 2px 10px/);
    expect(page).toContain('<Heart size={22}'); expect(component).toContain('<Share2 size={22}');
    expect(css).toMatch(/\.gallery-main \{\n  position: relative;[^}]*aspect-ratio: var\(--gallery-ratio, 1\);\n  width: min\(100%, calc\(580px \* var\(--gallery-ratio, 1\)\)\);\n  margin-inline: auto;/); // the box hugs the picture: no empty gutter
    expect(css.match(/width: min\(100%, calc\(580px \* var\(--gallery-ratio, 1\)\)\);/g)!.length).toBe(3); // base rule + the two later desktop layout rules that used to force 100%
    expect(css).toContain('width: min(100%, calc(min(88vw, 440px) * var(--gallery-ratio, 1)));'); expect(css).toMatch(/\.gallery-actions \{\n    top: 12px;\n    right: 12px;/);
    expect(page).toContain("'--gallery-ratio': imageRatio"); expect(page).toContain('onNaturalSize={onImageSize}');
    expect(css).toContain('.gallery-wishlist:active, .gallery-share:active'); expect(css).toContain('.gallery-wishlist:focus-visible, .gallery-share:focus-visible');
  });
  it('the menu becomes a bottom sheet on phones so it can never overflow the viewport', () => {
    expect(css).toMatch(/@media \(max-width: 760px\) \{\n  \.share-backdrop \{ display: block;[^\n]*\n  \.share-popover \{ left: 8px !important; right: 8px; top: auto !important; bottom: 8px;/);
  });
  it('does not touch wishlist, cart, checkout or auth code', () => {
    for (const file of ['components/storefront/product-share.tsx', 'lib/product-share.ts']) expect(norm(file)).not.toMatch(/useWishlist|useCart|checkout|api\.(wishlist|cart|orders|auth)/);
  });
});
