import { ArrowUpRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { SmartImage } from '@/components/ui/smart-image';
import type { LuxeFeature } from '@/lib/api/schemas';
import { splitHeading } from '@/lib/luxe-feature';

/**
 * The homepage "THE PRIVATE EDIT" band. The markup and class names are exactly those the band always had, so the existing styles
 * (image crop, overlay, typography, positions, responsive rules) apply unchanged. The admin preview renders this same component;
 * there the button is inert so a click in the preview never navigates.
 */
export function LuxeFeatureBand({ feature, onTransition, preview = false }: { feature: LuxeFeature; onTransition?: () => void; preview?: boolean }) {
  const { first, accent } = splitHeading(feature.heading);
  const cta = <>{feature.ctaLabel} <ArrowUpRight size={17} /></>;
  return <section className="luxe-feature"><SmartImage src={feature.image} alt={feature.imageAlt} /><div className="luxe-feature-overlay" /><div className="luxe-feature-content">
    {feature.eyebrow && <span className="eyebrow">{feature.eyebrow}</span>}
    <h2>{first}{accent && <><br /><em>{accent}</em></>}</h2>
    {(feature.bodyLine1 || feature.bodyLine2) && <p>{feature.bodyLine1}{feature.bodyLine1 && feature.bodyLine2 && <br />}{feature.bodyLine2}</p>}
    {preview ? <span className="button button-ivory" aria-disabled="true">{cta}</span> : <RouteLink href={feature.ctaHref} className="button button-ivory" onClick={onTransition}>{cta}</RouteLink>}
  </div><div className="luxe-feature-side">LIMITED / CURATED / ESSENTIAL</div></section>;
}
