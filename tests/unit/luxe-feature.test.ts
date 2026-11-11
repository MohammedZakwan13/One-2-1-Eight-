import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminLuxeFeatureSchema, luxeFeatureSchema, storefrontContentSchema } from '@/lib/api/schemas';
import { LUXE_FEATURE_DEFAULTS, luxeFallbackImage, resolveLuxeFeature, splitHeading } from '@/lib/luxe-feature';

const NL = String.fromCharCode(10);
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const IMG = 'https://x.supabase.co/storage/v1/object/public/p/uploads/2026/11/a.jpg';
const saved = { enabled: true, image: IMG, imageAlt: 'Autumn edit', eyebrow: 'NEW SEASON', heading: 'AUTUMN\nEDIT', bodyLine1: 'Line one.', bodyLine2: 'Line two.', ctaLabel: 'SHOP NOW', ctaHref: '/collections/new-arrivals' };

describe('built-in copy (what the live band showed before it became editable)', () => {
  it('is exactly the original text, label and destination', () => {
    expect(LUXE_FEATURE_DEFAULTS).toEqual({
      enabled: true, image: '', imageAlt: 'One 2 1 Eight Luxe collection', eyebrow: 'THE PRIVATE EDIT', heading: 'ONE 2 1 EIGHT\nLUXE',
      bodyLine1: 'Elevated textures. Understated confidence.', bodyLine2: 'A more considered kind of statement.', ctaLabel: 'ENTER THE LUXE EDIT', ctaHref: '/collections/one-2-1-eight-luxe',
    });
  });
  it('the defaults satisfy the schema (so a save of the unchanged defaults is accepted)', () => expect(luxeFeatureSchema.safeParse(LUXE_FEATURE_DEFAULTS).success).toBe(true));
});

describe('resolveLuxeFeature (missing configuration uses safe fallbacks)', () => {
  it('null / undefined = built-in copy with the banner picture', () => {
    for (const none of [null, undefined]) expect(resolveLuxeFeature(none, '/banner.webp')).toEqual({ ...LUXE_FEATURE_DEFAULTS, image: '/banner.webp' });
  });
  it('saved values are used as saved', () => expect(resolveLuxeFeature(saved, '/banner.webp')).toEqual(saved));
  it('a saved configuration without a picture falls back to the banner picture only for the image', () => {
    expect(resolveLuxeFeature({ ...saved, image: '' }, '/banner.webp')).toEqual({ ...saved, image: '/banner.webp' });
  });
  it('picture fallback matches the original rule: third banner, else the first banner that has a picture', () => {
    const s = (desktopImage: string) => ({ desktopImage });
    expect(luxeFallbackImage([s('a'), s('b'), s('c'), s('d')])).toBe('c');
    expect(luxeFallbackImage([s('a'), s('b')])).toBe('a');
    expect(luxeFallbackImage([s(''), s('b')])).toBe('b');
    expect(luxeFallbackImage([])).toBe('');
  });
});

describe('heading', () => {
  it('splits the plain first line from the italic accent', () => {
    expect(splitHeading('ONE 2 1 EIGHT\nLUXE')).toEqual({ first: 'ONE 2 1 EIGHT', accent: 'LUXE' });
    expect(splitHeading('ONE LINE')).toEqual({ first: 'ONE LINE', accent: '' });
    expect(splitHeading('A\r\nB\nC')).toEqual({ first: 'A', accent: 'B C' });
  });
});

describe('validation', () => {
  it('accepts a full configuration and an empty picture / eyebrow / description lines', () => {
    expect(luxeFeatureSchema.safeParse(saved).success).toBe(true);
    expect(luxeFeatureSchema.safeParse({ ...saved, image: '', eyebrow: '', bodyLine1: '', bodyLine2: '' }).success).toBe(true);
  });
  it('requires a heading, a button label and a site-relative destination', () => {
    expect(luxeFeatureSchema.safeParse({ ...saved, heading: '  ' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaLabel: '' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: '' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: 'https://evil.example/' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: '//evil.example' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('rejects unsafe picture URLs and over-long text', () => {
    expect(luxeFeatureSchema.safeParse({ ...saved, image: 'javascript:alert(1)' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, image: 'data:image/png;base64,AAAA' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, heading: 'x'.repeat(101) }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, bodyLine1: 'x'.repeat(121) }).success).toBe(false);
  });
  it('public content stays backward compatible: absent or null luxeFeature still parses', () => {
    const base = { settings: {} as never, heroSlides: [], categories: [], paymentMethods: ['cod'] };
    const shape = storefrontContentSchema.shape;
    expect(shape.luxeFeature.safeParse(undefined).success).toBe(true);
    expect(shape.luxeFeature.safeParse(null).success).toBe(true);
    expect(shape.luxeFeature.safeParse(saved).success).toBe(true);
    expect(base.heroSlides).toEqual([]);
  });
  it('admin view carries availability so the UI can explain a missing migration', () => {
    expect(adminLuxeFeatureSchema.safeParse({ luxeFeature: null, available: false }).success).toBe(true);
    expect(adminLuxeFeatureSchema.safeParse({ luxeFeature: saved, available: true }).success).toBe(true);
  });
});

describe('LuxeFeatureBand markup (same elements and classes the styles already target)', () => {
  const band = read('components/storefront/luxe-feature-band.tsx');
  it('keeps the original structure, class names and fixed side text', () => {
    for (const part of ['<section className="luxe-feature">', '<div className="luxe-feature-overlay" />', '<div className="luxe-feature-content">', 'className="eyebrow"',
      '<h2>{first}{accent && <><br /><em>{accent}</em></>}</h2>', 'className="button button-ivory"', '<div className="luxe-feature-side">LIMITED / CURATED / ESSENTIAL</div>']) {
      expect(band).toContain(part);
    }
  });
  it('omits an empty eyebrow or description instead of leaving gaps', () => {
    expect(band).toContain('{feature.eyebrow && <span className="eyebrow">');
    expect(band).toContain('{(feature.bodyLine1 || feature.bodyLine2) && <p>');
  });
  it('the live band links to the saved destination; the admin preview button is inert', () => {
    expect(band).toContain('<RouteLink href={feature.ctaHref}');
    expect(band).toContain('onClick={onTransition}');
    expect(band).toContain('<span className="button button-ivory" aria-disabled="true">');
  });
  it('the layout styles are untouched: no luxe-feature rule was edited', () => {
    const css = read('app/globals.css');
    expect(css).toContain('.luxe-feature {' + NL + '  height: clamp(430px, 54vw, 700px);');
    expect(css).toContain('.luxe-feature-content {' + NL + '  position: absolute;' + NL + '  left: var(--page-pad);' + NL + '  top: 50%;');
  });
});

describe('wiring, persistence and storage safety (source guards)', () => {
  const admin = read('lib/backend/routes/admin.ts');
  const core = read('lib/backend/core.ts');
  it('migration 0011 is additive only', () => {
    const sql = read('supabase/migrations/0011_luxe_feature.sql').replace(/--.*$/gm, '');
    expect(sql).toContain('add column if not exists luxe_feature jsonb');
    expect(sql).not.toMatch(/drop |rename |truncate |delete |update /i);
  });
  it('the public API returns the saved band; the homepage receives it and renders through the shared component', () => {
    expect(read('lib/backend/routes/storefront.ts')).toContain('luxeFeature: toLuxeFeature(settings)');
    expect(read('app/(storefront)/page.tsx')).toContain('luxeFeature={luxeFeature ?? null}');
    const home = read('components/storefront/pages/home-page.tsx');
    expect(home).toContain('resolveLuxeFeature(luxeFeature, luxeFallbackImage(activeSlides))');
    expect(home).toContain('{luxeBand.enabled && <LuxeFeatureBand feature={luxeBand} onTransition={onTransition} />}');
  });
  it("the owner's commented-out campaign section is preserved exactly as it is", () => {
    const home = read('components/storefront/pages/home-page.tsx');
    expect(home).toContain('{/* <section className="campaign-split section-shell">');
    expect(home).toMatch(/Made to repeat<\/span><\/div><\/div><\/div><\/section> \*\/\}/);
  });
  it('saving is refused cleanly (503) until the migration exists, and the old picture is released only after a successful save', () => {
    const put = admin.slice(admin.indexOf("route('PUT', '/admin/content/luxe-feature'"), admin.indexOf('// Hero banner create'));
    expect(put).toContain("'migration_required'");
    expect(put).toContain("if (!('luxe_feature' in before)) throw migrationRequired();");
    expect(put.indexOf(".from('store_settings').update(")).toBeLessThan(put.indexOf('removeIfUnreferenced('));
    expect(put).toContain('if (error)');
    expect(put).toContain('requireAdmin(ctx');
  });
  it('the Luxe picture counts as "in use" in every cleanup path, and an unknown answer never deletes', () => {
    expect(core).toContain('export async function storedLuxeImage()');
    expect(admin.match(/storedLuxeImage\(\)/g)!.length).toBeGreaterThanOrEqual(3); // reference check, upload delete, cleanup walk
    expect(admin).toContain('luxe.path === path');
    expect(admin).toContain('referenced.add(luxe.path)');
    expect(admin).toContain('!luxe.ok');
    expect(read('lib/backend/routes/hero-banners.ts')).toContain('if (luxe.path) used.add(luxe.path)');
  });
  it('the admin editor is wired into Homepage & banners, saves once at a time, and previews without navigating', () => {
    expect(read('components/admin/content.tsx')).toContain('<LuxeFeatureEditor');
    const editor = read('components/admin/luxe-feature.tsx');
    expect(editor).toContain('if (saveLock.current) return;');
    expect(editor).toContain('disabled={saving || uploading || !available}');
    expect(editor).toContain('<LuxeFeatureBand feature={preview} preview />');
    expect(editor).toContain('luxeFeatureSchema.safeParse(draft)');
    expect(editor).toContain('<ImageUploader label="Section image" max={1}');
  });
  it('no existing section or unrelated admin area was altered by the integration', () => {
    const home = read('components/storefront/pages/home-page.tsx');
    for (const keep of ['<HeroCarousel slides={activeSlides}', '<LuxeRail products={luxe}', 'className="category-section section-shell"', 'arrivals-section']) expect(home).toContain(keep);
  });
});
