import type { HeroSlide, LuxeFeature } from '@/lib/api/schemas';

/**
 * The homepage "THE PRIVATE EDIT" band. These are the values the band had before it became editable, so a store with no saved
 * configuration (or a database where migration 0011 has not been applied yet) looks exactly as it always did.
 * `heading` keeps the hero-banner convention: a line break splits the plain first line from the italic accent line.
 */
export const LUXE_FEATURE_DEFAULTS: LuxeFeature = {
  enabled: true,
  image: '',
  imageAlt: 'One 2 1 Eight Luxe collection',
  eyebrow: 'THE PRIVATE EDIT',
  heading: 'ONE 2 1 EIGHT\nLUXE',
  bodyLine1: 'Elevated textures. Understated confidence.',
  bodyLine2: 'A more considered kind of statement.',
  ctaLabel: 'ENTER THE LUXE EDIT',
  ctaHref: '/collections/one-2-1-eight-luxe',
};

/** The picture the band has always used: the third live banner's desktop image, else the first banner that has one. */
export const luxeFallbackImage = (slides: readonly Pick<HeroSlide, 'desktopImage'>[]): string => slides[2]?.desktopImage || slides.find(slide => slide.desktopImage)?.desktopImage || '';

/**
 * What the storefront renders. A missing configuration gives the defaults; a saved one is used as saved, except that the picture
 * falls back to the banner still when none was uploaded (the band always needs a background).
 */
export function resolveLuxeFeature(saved: LuxeFeature | null | undefined, fallbackImage: string): LuxeFeature & { image: string } {
  const base = saved ?? LUXE_FEATURE_DEFAULTS;
  return { ...base, image: base.image || fallbackImage };
}

/** First line (plain) and the remaining text (shown in the italic accent), split on the first line break. */
export function splitHeading(heading: string): { first: string; accent: string } {
  const [first = '', ...rest] = heading.split(/\r?\n/);
  return { first: first.trim(), accent: rest.join(' ').trim() };
}
