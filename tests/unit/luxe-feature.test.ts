import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminLuxeFeatureSchema, luxeFeatureSchema, storefrontContentSchema } from '@/lib/api/schemas';
import { LUXE_FEATURE_DEFAULTS, luxeFallbackImage, resolveLuxeFeature } from '@/lib/luxe-feature';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const IMG = 'https://x.supabase.co/storage/v1/object/public/p/uploads/2026/11/a.jpg';
const saved = { enabled: true, image: IMG, imageAlt: 'Autumn edit', description: 'Autumn is here.', ctaLabel: 'SHOP NOW', ctaHref: '/collections/new-arrivals' };

describe('built-in defaults (picture fallback and button; the band has no editable text)', () => {
  it('is exactly the default alt text, button label and destination', () => {
    expect(LUXE_FEATURE_DEFAULTS).toEqual({ enabled: true, image: '', imageAlt: 'One 2 1 Eight Luxe collection', description: '', ctaLabel: 'ENTER THE LUXE EDIT', ctaHref: '/collections/one-2-1-eight-luxe' });
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

describe('validation', () => {
  it('accepts a full configuration and an empty picture', () => {
    expect(luxeFeatureSchema.safeParse(saved).success).toBe(true);
    expect(luxeFeatureSchema.safeParse({ ...saved, image: '' }).success).toBe(true);
  });
  it('alt text is optional: empty, whitespace-only or absent all save, and a provided value is kept', () => {
    expect(luxeFeatureSchema.safeParse({ ...saved, imageAlt: '' }).data?.imageAlt).toBe('');
    expect(luxeFeatureSchema.safeParse({ ...saved, imageAlt: '   ' }).data?.imageAlt).toBe('');
    const { imageAlt: _omitted, ...withoutAlt } = saved;
    expect(luxeFeatureSchema.safeParse(withoutAlt).data?.imageAlt).toBe('');
    expect(luxeFeatureSchema.safeParse({ ...saved, imageAlt: ' Autumn edit ' }).data?.imageAlt).toBe('Autumn edit');
  });
  it('visible description is optional (empty or absent saves as empty), trimmed, capped at 300 characters, and kept separate from alt text', () => {
    const { description: _omitted, ...withoutDescription } = saved;
    expect(luxeFeatureSchema.safeParse(withoutDescription).data?.description).toBe('');
    expect(luxeFeatureSchema.safeParse({ ...saved, description: '  ' }).data?.description).toBe('');
    const both = luxeFeatureSchema.safeParse({ ...saved, imageAlt: 'alt only', description: ' visible only ' }).data;
    expect(both).toMatchObject({ imageAlt: 'alt only', description: 'visible only' });
    expect(luxeFeatureSchema.safeParse({ ...saved, description: 'x'.repeat(300) }).success).toBe(true);
    expect(luxeFeatureSchema.safeParse({ ...saved, description: 'x'.repeat(301) }).success).toBe(false);
  });
  it('older payloads that still carry heading / eyebrow / description text are accepted and the text is dropped', () => {
    const parsed = luxeFeatureSchema.safeParse({ ...saved, eyebrow: 'X', heading: 'Y', bodyLine1: 'a', bodyLine2: 'b' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(saved);
  });
  it('requires a button label and a site-relative destination', () => {
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaLabel: '' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: '' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: 'https://evil.example/' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: '//evil.example' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaHref: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('rejects unsafe picture URLs and over-long text', () => {
    expect(luxeFeatureSchema.safeParse({ ...saved, image: 'javascript:alert(1)' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, image: 'data:image/png;base64,AAAA' }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, imageAlt: 'x'.repeat(161) }).success).toBe(false);
    expect(luxeFeatureSchema.safeParse({ ...saved, ctaLabel: 'x'.repeat(41) }).success).toBe(false);
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

describe('LuxeFeatureBand markup (full-bleed hero: picture, gradient, then description and button at the lower left)', () => {
  const band = read('components/storefront/luxe-feature-band.tsx');
  it('is a full-bleed hero: the picture fills the section, the description and button share one content block, and there is no blurred backdrop or poster stage', () => {
    for (const part of ['<section className="luxe-feature">', '<SmartImage src={feature.image} alt={feature.imageAlt} />', '<div className="luxe-feature-overlay" />', '<div className="luxe-feature-content">', 'className="button button-ivory"', '<div className="luxe-feature-side">LIMITED / CURATED / ESSENTIAL</div>']) {
      expect(band).toContain(part);
    }
    for (const gone of ['luxe-feature-backdrop', 'luxe-feature-stage', 'luxe-feature-media', 'luxe-feature-info', 'luxe-feature-actions', 'aria-hidden']) expect(band).not.toContain(gone);
  });
  it('renders the visible description only when present, and never shows the alt text as text', () => {
    expect(band).toContain('{feature.description && <p className="luxe-feature-description">{feature.description}</p>}');
    expect(band.match(/feature\.imageAlt/g)).toHaveLength(1); // only the picture's alt attribute
  });
  it('no longer renders (or depends on) a configurable eyebrow, heading or two description lines', () => {
    const code = band.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const gone of ['eyebrow', '<h2>', 'feature.heading', 'bodyLine', 'splitHeading']) expect(code).not.toContain(gone);
  });
  it('the live band links to the saved destination; the admin preview button is inert', () => {
    expect(band).toContain('<RouteLink href={feature.ctaHref}');
    expect(band).toContain('onClick={onTransition}');
    expect(band).toContain('<span className="button button-ivory" aria-disabled="true">');
  });
  it('the band is a cover-fit full-bleed hero with no blurred extension: cover + focal point, gradient overlay, no filter/blur, mobile height rule', () => {
    const css = read('app/globals.css');
    const rules = css.slice(css.indexOf('.luxe-feature {'), css.indexOf('.service-section {'));
    const rule = (selector: string) => rules.slice(rules.indexOf(selector + ' {'), rules.indexOf('}', rules.indexOf(selector + ' {')));
    expect(rule('.luxe-feature>.smart-image img')).toContain('object-fit: cover');
    expect(rule('.luxe-feature>.smart-image img')).toMatch(/object-position: center \d+%/);
    expect(rule('.luxe-feature>.smart-image')).toContain('inset: 0');
    expect(rule('.luxe-feature')).toContain('min-height: clamp(430px, 54vw, 700px)');
    expect(rule('.luxe-feature-overlay')).toContain('pointer-events: none');
    expect(rules).not.toMatch(/blur\(|filter:|backdrop|isolation|scale\(/);
    expect(rules).not.toContain('orientation');
    expect(css).not.toMatch(/\.luxe-feature-(media|stage|info|actions|backdrop)/);
    expect(css).not.toMatch(/\.luxe-feature::before/);
    // the content block is in normal flow (a long description grows the band instead of overflowing it) and has no heading rules left
    expect(rule('.luxe-feature-content')).toContain('position: relative');
    expect(css).not.toMatch(/\.luxe-feature-content (h2|\.eyebrow)/);
    // mobile: a portrait-friendly height inside the existing 760px breakpoint
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.luxe-feature \{\s*min-height: min\(133vw, 640px\)/);
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
    for (const gone of ['Small heading above the title', 'Main heading', 'Description, line', 'draft.eyebrow', 'bodyLine', 'draft.heading']) expect(editor).not.toContain(gone);
    expect(editor).toContain('Image alt text (optional)');
    expect(editor).toContain('Visible description (optional)');
    expect(editor).toContain('set({ description: event.target.value })');
    expect(editor).toContain("client.setQueryData(['admin', 'luxe-feature'], { luxeFeature: saved, available: true })");
  });
  it('no existing section or unrelated admin area was altered by the integration', () => {
    const home = read('components/storefront/pages/home-page.tsx');
    for (const keep of ['<HeroCarousel slides={activeSlides}', '<LuxeRail products={luxe}', 'className="category-section section-shell"', 'arrivals-section']) expect(home).toContain(keep);
  });
});
