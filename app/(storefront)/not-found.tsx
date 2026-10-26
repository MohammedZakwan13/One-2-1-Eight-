import { ArrowRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';

export default function NotFound() {
  return <main className="not-found-page"><span className="eyebrow">404 / OFF THE MAP</span><h1>This page took<br /><em>a different route.</em></h1><RouteLink href="/" className="button button-dark">BACK TO THE STORE <ArrowRight size={16} /></RouteLink></main>;
}
