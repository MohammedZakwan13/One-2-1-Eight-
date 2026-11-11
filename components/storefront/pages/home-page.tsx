'use client';

import React, { FormEvent, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleHelp, LockKeyhole, Mail, PackageCheck, Truck } from 'lucide-react';
import { HeroCarousel } from '@/components/storefront/hero-carousel';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { SectionHeading } from '@/components/ui/section-heading';
import { ProductGrid } from '@/components/storefront/product-grid';
import { LuxeRail } from '@/components/storefront/luxe-rail';
import { Footer } from '@/components/storefront/footer';
import { money } from '@/lib/format';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useWishlistToggle } from '@/lib/hooks/use-wishlist-toggle';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Category, HeroSlide, Product } from '@/lib/api/schemas';
import { isStorefrontCategory } from '@/lib/catalog';

export function HomePage({ heroSlides, categories, featured, latest, luxe = [] }: { heroSlides: HeroSlide[]; categories: Category[]; featured: Product[]; latest: Product[]; luxe?: Product[] }) {
  const { settings } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const { wishlist, onToggleWishlist } = useWishlistToggle();
  const activeSlides = useMemo(() => heroSlides.filter(slide => slide.active), [heroSlides]);
  const [sellerForm, setSellerForm] = useState({ name: '', email: '', phone: '', type: 'Bulk purchase', quantity: '50–100 pieces', message: '' });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [leadError, setLeadError] = useState('');
  // The Luxe band below reuses a banner still. A video banner may have no poster, so fall back to the first banner that has a picture.
  const luxeImage = activeSlides[2]?.desktopImage || activeSlides.find(slide => slide.desktopImage)?.desktopImage || '';
  const submitLead = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setLeadError('');
    try {
      await api.content.submitLead(sellerForm);
      setSubmitted(true); notify('Thanks — your enquiry is with our team.');
    } catch (error) {
      setLeadError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };
  return <>
    <main className="home-main">
      <HeroCarousel slides={activeSlides} brandLine={settings.brandLine} />

      <LuxeRail products={luxe} onTransition={onTransition} />

      <section className="category-section section-shell"><SectionHeading eyebrow="START WITH YOUR STYLE" title="Shop by category" description="The pieces you'll reach for, on repeat." href="/collections/all" onTransition={onTransition} />
        <div className="category-grid">{categories.filter(isStorefrontCategory).map((category, index) => <RouteLink key={category.id} className={`category-card category-card-${index + 1}`} href={`/collections/${category.slug}`} onClick={onTransition}><SmartImage src={category.image} alt={category.name} /><div className="category-card-shade" /><span className="category-count">0{index + 1}</span><div className="category-card-copy"><h3>{category.name}</h3><span>EXPLORE <ArrowUpRight size={15} /></span></div></RouteLink>)}</div>
      </section>

      <section className="product-section section-shell"><SectionHeading eyebrow="THE PIECES THAT STAY IN ROTATION" title="Best sellers" description="The 1218 signatures. Chosen often, worn everywhere." href="/collections/best-sellers" onTransition={onTransition} /><ProductGrid products={featured} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} /></section>

      {/* <section className="campaign-split section-shell"><div className="campaign-image"><SmartImage
        src="/images/campaign/hoodie-campaign.webp"
        alt="ONE 2 1 EIGHT men's hoodie editorial"
      /><div className="campaign-image-label"></div></div><div className="campaign-copy"><span className="eyebrow">LESS, BUT CONSIDERED</span><h2>Good style<br /><em>is in the details.</em></h2><p>Thoughtful fits. Better hand-feel. Pieces designed to earn their place in your wardrobe, season after season.</p><RouteLink href="/collections/one-2-1-eight-luxe" className="button button-dark" onClick={onTransition}>DISCOVER THE LUXE EDIT <ArrowRight size={16} /></RouteLink><div className="campaign-stats"><div><strong>01</strong><span>Considered fit</span></div><div><strong>02</strong><span>Better materials</span></div><div><strong>03</strong><span>Made to repeat</span></div></div></div></section> */}

      <section className="product-section section-shell arrivals-section"><SectionHeading eyebrow="JUST IN, JUST RIGHT" title="New arrivals" description="Fresh proportions. New favourites waiting to happen." href="/collections/new-arrivals" onTransition={onTransition} /><ProductGrid products={latest} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} /></section>

      <section className="luxe-feature"><SmartImage src={luxeImage} alt="One 2 1 Eight Luxe collection" /><div className="luxe-feature-overlay" /><div className="luxe-feature-content"><span className="eyebrow">THE PRIVATE EDIT</span><h2>ONE 2 1 EIGHT<br /><em>LUXE</em></h2><p>Elevated textures. Understated confidence.<br />A more considered kind of statement.</p><RouteLink href="/collections/one-2-1-eight-luxe" className="button button-ivory" onClick={onTransition}>ENTER THE LUXE EDIT <ArrowUpRight size={17} /></RouteLink></div><div className="luxe-feature-side">LIMITED / CURATED / ESSENTIAL</div></section>

      <section className="service-section section-shell" id="service"><SectionHeading eyebrow="THE STANDARD, BUILT IN" title="Considered from checkout to doorstep" description="The details should feel as good as the fit." /><div className="service-grid"><div className="service-card"><div className="service-icon"><Truck size={23} /></div><h3>Complimentary shipping</h3><p>Free shipping on orders over {money(settings.freeShippingThreshold)}. Clear delivery updates, from us to you.</p><span>01 / DELIVERY</span></div><div className="service-card"><div className="service-icon"><PackageCheck size={23} /></div><h3>7-day easy returns</h3><p>Try it on, find your fit. Eligible pieces can be returned within seven days of delivery.</p><span>02 / PEACE OF MIND</span></div><div className="service-card"><div className="service-icon"><CircleHelp size={23} /></div><h3>Real help, when needed</h3><p>Questions about fit, orders or bulk buying? Reach our team at {settings.contactEmail}.</p><span>03 / HERE TO HELP</span></div></div></section>

      <section className="home-seller-section section-shell" id="home-seller"><div className="seller-intro"><span className="eyebrow">FOR TEAMS, CREWS & GOOD IDEAS</span><h2>Make it<br /><em>your own.</em></h2><p>Looking to buy in bulk, create custom merchandise or work on a special run? Tell us a little about the project. We’ll take it from there.</p><div className="seller-contact-note"><Mail size={17} /><span>Prefer email? <a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a></span></div></div><div className="seller-form-card">{submitted ? <div className="form-success"><div className="success-mark"><Check size={24} /></div><span className="eyebrow">ENQUIRY RECEIVED</span><h3>Let's make something good.</h3><p>Thanks, {sellerForm.name.split(' ')[0] || 'there'}. Our team will follow up using the contact details you shared.</p><button className="button button-dark" onClick={() => { setSubmitted(false); setSellerForm({ name: '', email: '', phone: '', type: 'Bulk purchase', quantity: '50–100 pieces', message: '' }); }}>SEND ANOTHER ENQUIRY</button></div> : <form onSubmit={submitLead}><div className="seller-form-head"><div><span className="eyebrow">PROJECT ENQUIRY</span><h3>Tell us what you're planning.</h3></div><span className="form-step">01 — 03</span></div><div className="form-grid-two"><label>Your name<input required minLength={2} maxLength={120} autoComplete="name" value={sellerForm.name} onChange={e => setSellerForm({ ...sellerForm, name: e.target.value })} placeholder="Full name" /></label><label>Work email<input required type="email" value={sellerForm.email} onChange={e => setSellerForm({ ...sellerForm, email: e.target.value })} placeholder="name@company.com" /></label><label>Phone number<input required type="tel" value={sellerForm.phone} onChange={e => setSellerForm({ ...sellerForm, phone: e.target.value })} placeholder="+91 90000 00000" /></label><label>What do you need?<select value={sellerForm.type} onChange={e => setSellerForm({ ...sellerForm, type: e.target.value })}><option>Bulk purchase</option><option>Custom merchandise</option><option>Corporate gifting</option><option>Collaboration</option><option>Other project</option></select></label></div><label>Approximate quantity<select value={sellerForm.quantity} onChange={e => setSellerForm({ ...sellerForm, quantity: e.target.value })}><option>25–50 pieces</option><option>50–100 pieces</option><option>100–250 pieces</option><option>250+ pieces</option><option>Not sure yet</option></select></label><label>Anything else we should know?<textarea rows={3} maxLength={2000} value={sellerForm.message} onChange={e => setSellerForm({ ...sellerForm, message: e.target.value })} placeholder="Timeline, designs, sizes, ideas..." /></label>{leadError && <p className="form-error-banner" role="alert">{leadError}</p>}<button className="button button-dark seller-submit" type="submit" disabled={submitting}>{submitting ? 'SENDING…' : 'SEND PROJECT ENQUIRY'} <ArrowRight size={16} /></button><p className="form-privacy"><LockKeyhole size={12} /> Your details are only used to respond to this enquiry.</p></form>}</div></section>
    </main>
    <Footer />
  </>;
}
