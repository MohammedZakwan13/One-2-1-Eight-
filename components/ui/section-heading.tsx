'use client';

import { ArrowUpRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';

export function SectionHeading({ eyebrow, title, description, href, linkText = 'VIEW ALL', onTransition }: { eyebrow?: string; title: string; description?: string; href?: string; linkText?: string; onTransition?: () => void }) {
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{href && <RouteLink href={href} className="text-link" onClick={onTransition}>{linkText} <ArrowUpRight size={17} /></RouteLink>}</div>;
}
