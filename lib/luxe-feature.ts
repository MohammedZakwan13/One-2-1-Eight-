import type { HeroSlide, LuxeFeature } from '@/lib/api/schemas';

/**
 * The homepage "THE PRIVATE EDIT" band. A store with no saved configuration (or a database where migration 0011 has not been applied
 * yet) shows the picture fallback and this button. The band carries no editable text of its own: the artwork is the message.
 */
export const LUXE_FEATURE_DEFAULTS: LuxeFeature = {
  enabled: true,
  image: '',
  imageAlt: 'One 2 1 Eight Luxe collection',
  description: '',
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
