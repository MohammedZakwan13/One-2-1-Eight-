'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, Instagram, Mail, Phone } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { BrandMark } from '@/components/ui/brand-mark';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

function WhatsAppIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

export function Footer() {
  const { settings, legalPages } = useStorefrontData();
  const { transition: onTransition } = useUi();
  const [email, setEmail] = useState('');
  const [subscription, setSubscription] = useState<'idle' | 'sending' | 'pending_confirmation' | 'subscribed'>('idle');
  const [subscribeError, setSubscribeError] = useState('');
  const whatsappUrl = `https://wa.me/${(settings.whatsappNumber || '919344301218').replace(/\D/g, '') || '919344301218'}`;
  const instagramUrl = settings.instagramUrl || 'https://www.instagram.com/one_21eight?cplk=amQ2NXpka3BtbHhy';
  const subscribe = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.includes('@') || subscription === 'sending') return;
    setSubscription('sending'); setSubscribeError('');
    try {
      const result = await api.content.subscribeNewsletter(email.trim());
      setSubscription(result.status);
    } catch (error) {
      setSubscription('idle');
      setSubscribeError(errorMessage(error));
    }
  };
  return <footer className="site-footer">
    <div className="footer-top"><div className="footer-brand"><BrandMark /><p>Elevated everyday menswear.<br />Made for your own standard.</p><div className="social-links"><a href={`mailto:${settings.contactEmail}`} aria-label="Email"><Mail size={18} /></a><a href={`tel:${settings.contactPhone.replace(/[^\d+]/g, '')}`} aria-label="Call us"><Phone size={17} /></a><a href={whatsappUrl} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp"><WhatsAppIcon size={18} /></a><a href={instagramUrl} target="_blank" rel="noopener noreferrer" aria-label="Instagram"><Instagram size={18} /></a></div></div>
      <div className="footer-column"><h3>EXPLORE</h3><RouteLink href="/collections/new-arrivals" onClick={onTransition}>New arrivals</RouteLink><RouteLink href="/collections/best-sellers" onClick={onTransition}>Best sellers</RouteLink><RouteLink href="/collections/one-2-1-eight-luxe" onClick={onTransition}>One 2 1 Eight Luxe</RouteLink><RouteLink href="/collections/all" onClick={onTransition}>Shop all</RouteLink></div>
      <div className="footer-column"><h3>THE DETAILS</h3><RouteLink href="/policies/returns" onClick={onTransition}>Shipping & returns</RouteLink><RouteLink href="/size-guide" onClick={onTransition}>Size & fit guide</RouteLink>{legalPages.map(page => <RouteLink key={page.slug} href={`/policies/${page.slug}`} onClick={onTransition}>{page.title}</RouteLink>)}<a href={`mailto:${settings.contactEmail}`}>Contact us</a><RouteLink href="/#home-seller" onClick={onTransition}>Bulk & custom orders</RouteLink></div>
      <div className="footer-newsletter"><h3>GOOD THINGS, OCCASIONALLY.</h3><p>New drops, considered edits and first access to what’s next.</p>{subscription === 'pending_confirmation' || subscription === 'subscribed' ? <div className="subscribed-state"><CheckCircle2 size={18} /> {subscription === 'subscribed' ? "You're on the list. Welcome in." : 'Almost there — check your inbox to confirm.'}</div> : <form onSubmit={subscribe}><input type="email" required placeholder="Your email address" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email for newsletter" autoComplete="email" maxLength={254} /><button type="submit" aria-label="Subscribe" disabled={subscription === 'sending'}><ArrowRight /></button></form>}{subscribeError && <p className="field-error" role="alert">{subscribeError}</p>}<small>By subscribing, you agree to receive occasional updates from us.</small></div>
    </div>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} {settings.brandName}. All rights reserved.</span><span>Designed with intention. Worn your way.</span><span className="payment-labels">UPI · VISA · MASTERCARD</span></div>
  </footer>;
}
