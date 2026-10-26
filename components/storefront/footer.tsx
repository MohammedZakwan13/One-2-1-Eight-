'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, Instagram, Mail, MessageCircle, Phone } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { BrandMark } from '@/components/ui/brand-mark';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

export function Footer() {
  const { settings, legalPages } = useStorefrontData();
  const { transition: onTransition } = useUi();
  const [email, setEmail] = useState('');
  const [subscription, setSubscription] = useState<'idle' | 'sending' | 'pending_confirmation' | 'subscribed'>('idle');
  const [subscribeError, setSubscribeError] = useState('');
  const contactNumber = settings.whatsappNumber ?? '';
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
    <div className="footer-top"><div className="footer-brand"><BrandMark /><p>Elevated everyday menswear.<br />Made for your own standard.</p><div className="social-links">{settings.instagramUrl && <a href={settings.instagramUrl} target="_blank" rel="noreferrer noopener" aria-label="Instagram"><Instagram size={18} /></a>}<a href={`mailto:${settings.contactEmail}`} aria-label="Email us"><Mail size={18} /></a>{contactNumber && <a href={`https://wa.me/${contactNumber}`} target="_blank" rel="noreferrer noopener" aria-label="WhatsApp"><MessageCircle size={18} /></a>}<a href={`tel:${settings.contactPhone.replace(/[^\d+]/g, '')}`} aria-label="Call us"><Phone size={17} /></a></div></div>
      <div className="footer-column"><h3>EXPLORE</h3><RouteLink href="/collections/new-arrivals" onClick={onTransition}>New arrivals</RouteLink><RouteLink href="/collections/best-sellers" onClick={onTransition}>Best sellers</RouteLink><RouteLink href="/collections/one-2-1-eight-luxe" onClick={onTransition}>One 2 1 Eight Luxe</RouteLink><RouteLink href="/collections/all" onClick={onTransition}>Shop all</RouteLink></div>
      <div className="footer-column"><h3>THE DETAILS</h3><RouteLink href="/policies/returns" onClick={onTransition}>Shipping & returns</RouteLink><RouteLink href="/size-guide" onClick={onTransition}>Size & fit guide</RouteLink>{legalPages.map(page => <RouteLink key={page.slug} href={`/policies/${page.slug}`} onClick={onTransition}>{page.title}</RouteLink>)}<a href={`mailto:${settings.contactEmail}`}>Contact us</a><RouteLink href="/#home-seller" onClick={onTransition}>Bulk & custom orders</RouteLink></div>
      <div className="footer-newsletter"><h3>GOOD THINGS, OCCASIONALLY.</h3><p>New drops, considered edits and first access to what’s next.</p>{subscription === 'pending_confirmation' || subscription === 'subscribed' ? <div className="subscribed-state"><CheckCircle2 size={18} /> {subscription === 'subscribed' ? "You're on the list. Welcome in." : 'Almost there — check your inbox to confirm.'}</div> : <form onSubmit={subscribe}><input type="email" required placeholder="Your email address" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email for newsletter" autoComplete="email" maxLength={254} /><button type="submit" aria-label="Subscribe" disabled={subscription === 'sending'}><ArrowRight /></button></form>}{subscribeError && <p className="field-error" role="alert">{subscribeError}</p>}<small>By subscribing, you agree to receive occasional updates from us.</small></div>
    </div>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} {settings.brandName}. All rights reserved.</span><span>Designed with intention. Worn your way.</span><span className="payment-labels">UPI · VISA · MASTERCARD</span></div>
  </footer>;
}
