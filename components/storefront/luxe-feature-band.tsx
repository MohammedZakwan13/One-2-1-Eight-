import { ArrowUpRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { SmartImage } from '@/components/ui/smart-image';
import type { LuxeFeature } from '@/lib/api/schemas';

/**
 * The homepage "THE PRIVATE EDIT" band: a full-bleed hero. The picture fills the whole band (cover, focal point set in the CSS), with a soft
 * gradient for legibility; the optional visible description and the call-to-action sit together at the lower left, over the picture's
 * quiet area. `imageAlt` is accessibility-only and is never displayed. The admin preview renders this same component; there the
 * button is inert so a click in the preview never navigates.
 */
export function LuxeFeatureBand({ feature, onTransition, preview = false }: { feature: LuxeFeature; onTransition?: () => void; preview?: boolean }) {
  const cta = <>{feature.ctaLabel} <ArrowUpRight size={17} /></>;
  return <section className="luxe-feature">
    <SmartImage src={feature.image} alt={feature.imageAlt} />
    <div className="luxe-feature-overlay" />
    <div className="luxe-feature-content">
      {feature.description && <p className="luxe-feature-description">{feature.description}</p>}
      {preview ? <span className="button button-ivory" aria-disabled="true">{cta}</span> : <RouteLink href={feature.ctaHref} className="button button-ivory" onClick={onTransition}>{cta}</RouteLink>}
    </div>
    <div className="luxe-feature-side">LIMITED / CURATED / ESSENTIAL</div>
  </section>;
}
