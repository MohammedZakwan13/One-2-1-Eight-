'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, CheckCircle2, Heart, MapPin, Minus, Plus, ShieldCheck, Sparkles, Star, X } from 'lucide-react';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { SectionHeading } from '@/components/ui/section-heading';
import { ProductGrid } from '@/components/storefront/product-grid';
import { Footer } from '@/components/storefront/footer';
import { money, slugify } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useWishlistToggle } from '@/lib/hooks/use-wishlist-toggle';
import { useCart } from '@/lib/hooks/use-cart';
import { api } from '@/lib/api/client';
import { errorMessage, isUnauthorized } from '@/lib/api/errors';
import type { Product, ReviewList } from '@/lib/api/schemas';
import { discountPercent, variantForSize } from '@/lib/catalog';

const EMPTY_REVIEWS: ReviewList = { summary: { average: 0, count: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } }, items: [] };

export function ProductDetailPage({ product, related, initialReviews }: { product: Product; related: Product[]; initialReviews: ReviewList | null }) {
  const { settings } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const { wishlist, onToggleWishlist } = useWishlistToggle();
  const router = useRouter();
  const { addItem } = useCart();
  const queryClient = useQueryClient();
  const reviewsQuery = useQuery({ queryKey: ['reviews', product.slug], queryFn: ({ signal }) => api.reviews.list(product.slug, signal), initialData: initialReviews ?? EMPTY_REVIEWS, initialDataUpdatedAt: initialReviews ? Date.now() : 0, staleTime: 30_000 });
  const summary = reviewsQuery.data.summary;
  const [activeImage, setActiveImage] = useState(0);
  const [selectedSize, setSelectedSize] = useState('');
  const [sizeGuide, setSizeGuide] = useState(false);
  const [deliveryPin, setDeliveryPin] = useState('');
  const [deliveryMessage, setDeliveryMessage] = useState('');
  const [activeAccordion, setActiveAccordion] = useState('description');
  const [reviewSort, setReviewSort] = useState('recent');
  const [reviewName, setReviewName] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const reviewCards = reviewsQuery.data.items.map(review => ({
    id: review.id, name: review.author, rating: review.rating, date: review.createdAt, title: review.title, text: review.body, verified: review.verifiedPurchase,
  })).sort((a, b) => reviewSort === 'high' ? b.rating - a.rating : reviewSort === 'low' ? a.rating - b.rating : Date.parse(b.date) - Date.parse(a.date));
  const displayedReviewCount = summary.count;
  const averageRating = summary.average.toFixed(1);
  const submitReview = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingReview) return;
    if (!reviewName.trim() || !reviewTitle.trim() || !reviewText.trim()) {
      setReviewNotice('Please complete your name, review title and review.');
      return;
    }
    setSubmittingReview(true); setNeedsLogin(false);
    try {
      const result = await api.reviews.create(product.slug, { rating: reviewRating, title: reviewTitle, body: reviewText, authorName: reviewName });
      setReviewName(''); setReviewRating(5); setReviewTitle(''); setReviewText('');
      setReviewNotice(result.message || (result.status === 'published' ? 'Thank you — your review is now live.' : 'Thank you — your review will appear once our team has checked it.'));
      notify('Review submitted successfully.');
      await queryClient.invalidateQueries({ queryKey: ['reviews', product.slug] });
    } catch (error) {
      if (isUnauthorized(error)) { setNeedsLogin(true); setReviewNotice('Please sign in to leave a review.'); }
      else setReviewNotice(errorMessage(error));
    } finally {
      setSubmittingReview(false);
    }
  };
  useEffect(() => {
    if (!sizeGuide) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSizeGuide(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', closeOnEscape); };
  }, [sizeGuide]);
  const discount = discountPercent(product);
  const add = (goToCheckout = false) => {
    if (!selectedSize) {
      notify('Choose your size to continue.');
      document.getElementById('size-picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const variant = variantForSize(product, selectedSize);
    if (!variant || variant.availability.status === 'out_of_stock') { notify('That size is sold out.'); return; }
    addItem.mutate({ variantId: variant.id }, {
      onSuccess: () => {
        if (goToCheckout) { onTransition(); router.push('/checkout'); return; }
        notify(`${product.name} · ${selectedSize} added to your bag.`);
      },
      onError: error => notify(errorMessage(error)),
    });
  };
  const checkDelivery = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[1-9]\d{5}$/.test(deliveryPin)) { setDeliveryMessage('Enter a valid 6-digit pincode to check delivery.'); return; }
    setDeliveryMessage('Checking…');
    try {
      const result = await api.catalog.serviceability(deliveryPin);
      setDeliveryMessage(result.serviceable
        ? `Good news — delivery available to ${deliveryPin}.${result.estimatedDays ? ` Estimated ${result.estimatedDays.min}–${result.estimatedDays.max} business days.` : ''}${result.codAvailable ? '' : ' Cash on delivery is not available here.'}`
        : result.message || `Sorry, we can't deliver to ${deliveryPin} yet.`);
    } catch (error) {
      setDeliveryMessage(errorMessage(error));
    }
  };
  const galleryImages = (product.images || []).filter(Boolean);
  const hasMultipleImages = galleryImages.length > 1;
  const currentImage = galleryImages[activeImage % Math.max(1, galleryImages.length)] || '';
  return <><main className="product-page">
    <div className="breadcrumbs product-breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><RouteLink href={`/collections/${slugify(product.category)}`} onClick={onTransition}>{product.category}</RouteLink><span>/</span><span>{product.name}</span></div>
    <div className="product-layout">
      <section className={`product-gallery ${hasMultipleImages ? 'has-thumbnails' : 'single-image'}`} aria-label="Product images">
        <div className="gallery-main">
          <SmartImage src={currentImage} alt={`${product.name} view ${activeImage + 1}`} eager />
          {hasMultipleImages && <span className="gallery-image-number">0{activeImage + 1} <i>/</i> 0{galleryImages.length}</span>}
          <button className={`gallery-wishlist ${wishlist.includes(product.id) ? 'is-saved' : ''}`} onClick={() => onToggleWishlist(product.id)} aria-label="Save product"><Heart size={20} fill={wishlist.includes(product.id) ? 'currentColor' : 'none'} /></button>
        </div>
        {hasMultipleImages && (
          <div className="gallery-thumbnails">
            {galleryImages.map((image, index) => <button key={`${image}-${index}`} className={activeImage === index ? 'active' : ''} onClick={() => setActiveImage(index)} aria-label={`View product image ${index + 1}`}><SmartImage src={image} alt={`${product.name}, view ${index + 1}`} /><span>{['FRONT', 'BACK', 'DETAIL', 'FIT'][index] || `VIEW ${index + 1}`}</span></button>)}
          </div>
        )}
        {hasMultipleImages && (
          <div className="gallery-mobile-dots">
            {galleryImages.map((_, idx) => <button key={idx} className={activeImage === idx ? 'active' : ''} aria-label={`View image ${idx + 1}`} onClick={() => setActiveImage(idx)} />)}
          </div>
        )}
      </section>
      <section className="product-detail-panel"><div className="detail-label-row"><span className="eyebrow">{product.luxe ? 'ONE 2 1 EIGHT LUXE' : product.newArrival ? 'NEW SEASON / 1218' : 'THE 1218 ESSENTIALS'}</span>{product.badge && <span className="detail-badge">{product.badge}</span>}</div><h1>{product.name}</h1><div className="detail-rating-row"><span className="star-rating"><Star size={14} fill="currentColor" /> {averageRating}</span><span>{displayedReviewCount} reviews</span><button onClick={() => document.getElementById('product-reviews')?.scrollIntoView({ behavior: 'smooth' })}>READ REVIEWS <ArrowDownRight size={13} /></button></div><div className="detail-price-row"><strong>{money(product.price)}</strong>{product.compareAt > product.price && <><del>{money(product.compareAt)}</del><span className="detail-discount">SAVE {discount}%</span></>}</div><p className="tax-note">Inclusive of all taxes</p>{settings.productOfferCode && <div className="detail-offer-strip"><span>{settings.productOfferCode}</span><p>{settings.productOfferText}</p><button onClick={() => { const code = settings.productOfferCode ?? ''; navigator.clipboard?.writeText(code).then(() => notify(`${code} copied. Use it in your bag.`), () => notify(`Use code ${code} in your bag.`)); }}>COPY</button></div>}
        <div className="detail-colour-block"><div className="detail-section-label"><span>COLOUR</span><strong>{product.color}</strong></div><div className="detail-colour-swatch"><button className="active" style={{ background: product.colorHex }} aria-label={product.color} /><span>{product.color}</span></div></div>
        <div className="detail-size-block" id="size-picker"><div className="detail-section-label"><span>SELECT SIZE</span><button type="button" className="size-guide-link" onClick={() => setSizeGuide(true)}>SIZE GUIDE <ArrowUpRight size={14} /></button></div><div className="size-options" role="group" aria-label="Choose a size">{product.variants.map(variant => { const soldOut = variant.availability.status === 'out_of_stock'; return <button key={variant.id} type="button" disabled={soldOut} aria-pressed={selectedSize === variant.size} aria-label={soldOut ? `Size ${variant.size}, sold out` : `Size ${variant.size}`} className={`${selectedSize === variant.size ? 'selected' : ''} ${variant.availability.status === 'low_stock' ? 'low-stock' : ''}`} onClick={() => setSelectedSize(variant.size)}>{variant.size}</button>; })}</div>{product.stockMessage && <p className="stock-note" role="status">{product.stockMessage}</p>}<div className="fit-suggestion"><Sparkles size={14} /><span>Designed for a {product.fit.toLowerCase()} silhouette</span></div></div>
        <button className="button button-dark add-to-bag-button" onClick={() => add()}>ADD TO BAG <span>{money(product.price)}</span><ArrowRight size={17} /></button>
        <button className="button buy-now-button" onClick={() => add(true)}>BUY NOW <span>{money(product.price)}</span><ArrowRight size={17} /></button>
        <p className="secure-note"><ShieldCheck size={14} /> Secure checkout · {product.returnable === false ? 'Non-returnable item' : 'Easy returns'}</p>
        <form className="delivery-check" onSubmit={checkDelivery}><label htmlFor="delivery-pin"><MapPin size={15} /> DELIVERY CHECK</label><div className="pin-input-row"><input id="delivery-pin" inputMode="numeric" maxLength={6} value={deliveryPin} onChange={e => { setDeliveryPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setDeliveryMessage(''); }} placeholder="Enter 6-digit pincode" /><button type="submit">CHECK <ArrowRight size={14} /></button></div>{deliveryMessage && <p className={`delivery-response ${deliveryMessage.startsWith('Good') ? 'available' : 'unavailable'}`}>{deliveryMessage}</p>}</form>
        <div className="product-accordions">{[
          { id: 'description', title: 'DESCRIPTION & FIT', content: <><p>{product.description}</p><ul><li>Fit: {product.fit}</li><li>Material: {product.material}</li><li>Model is styled for an editorial look; use the size guide to select your preferred fit.</li></ul></> },
          { id: 'shipping', title: 'SHIPPING & RETURNS', content: <p>{product.returnable === false ? 'This product is non-returnable and cannot be returned once delivered. ' : ''}{settings.returnPolicy} Complimentary shipping over {money(settings.freeShippingThreshold)}. Delivery timelines shown after a valid pincode check are estimates.</p> },
          { id: 'care', title: 'CARE GUIDE', content: <p>Wash inside out with similar colours. Use a gentle cold wash, avoid bleach and tumble drying, and dry in shade to help preserve colour and shape.</p> },
        ].map(item => <div className={`product-accordion ${activeAccordion === item.id ? 'open' : ''}`} key={item.id}><button onClick={() => setActiveAccordion(current => current === item.id ? '' : item.id)}><span>{item.title}</span>{activeAccordion === item.id ? <Minus size={17} /> : <Plus size={17} />}</button>{activeAccordion === item.id && <div className="accordion-content">{item.content}</div>}</div>)}</div>
      </section>
    </div>
    <section className="reviews-section" id="product-reviews">
      <div className="reviews-heading">
        <div><span className="eyebrow">THE COMMUNITY SAYS</span><h2>Reviews &amp; ratings</h2><p className="reviews-intro">Honest feedback helps you choose your fit with confidence.</p></div>
        <div className="reviews-score"><strong>{averageRating}</strong><div><div className="stars-five">★★★★★</div><span>Based on {displayedReviewCount} reviews</span></div></div>
      </div>
      <div className="reviews-summary-bar">
        <div><strong>Customer ratings</strong><span>{displayedReviewCount ? `Based on ${displayedReviewCount} review${displayedReviewCount === 1 ? '' : 's'}` : 'No reviews yet.'}</span></div>
        <div className="review-rating-bars">{[5, 4, 3, 2, 1].map(num => {
          const count = summary.distribution[String(num) as '1' | '2' | '3' | '4' | '5'];
          const pct = Math.round(count / Math.max(1, displayedReviewCount) * 100);
          return <div key={num}><span>{num}★</span><i><b style={{ width: `${pct}%` }} /></i><em>{pct}%</em></div>;
        })}</div>
        <label>Sort by <select value={reviewSort} onChange={e => setReviewSort(e.target.value)}><option value="recent">Most recent</option><option value="high">Highest rating</option><option value="low">Lowest rating</option></select></label>
      </div>
      <section className="review-submission-panel" aria-labelledby="review-submit-title">
        <div className="review-submission-heading"><span className="eyebrow">YOUR EXPERIENCE MATTERS</span><h3 id="review-submit-title">Leave a review</h3><p>Tell other customers about the fit, feel and finish.</p></div>
        <form className="review-submit-form" onSubmit={submitReview}>
          <label className="review-name-field">YOUR NAME<input value={reviewName} onChange={e => setReviewName(e.target.value)} maxLength={70} required placeholder="Enter your name" /></label>
          <fieldset className="review-rating-field"><legend>YOUR RATING</legend><div className="review-star-picker" role="group" aria-label="Choose a rating">{[1, 2, 3, 4, 5].map(star => <button key={star} type="button" className={star <= reviewRating ? 'selected' : ''} aria-label={`${star} star${star === 1 ? '' : 's'}`} aria-pressed={reviewRating === star} onClick={() => setReviewRating(star)}>★</button>)}</div></fieldset>
          <label className="review-title-field">REVIEW TITLE<input value={reviewTitle} onChange={e => setReviewTitle(e.target.value)} maxLength={100} required placeholder="What stood out?" /></label>
          <label className="review-copy-field">YOUR REVIEW<textarea value={reviewText} onChange={e => setReviewText(e.target.value)} minLength={8} maxLength={1200} required rows={3} placeholder="Share your thoughts about this product..." /></label>
          <div className="review-submit-bottom"><span>Reviews appear once our team has checked them.</span><button className="button button-dark" type="submit" disabled={submittingReview}>{submittingReview ? 'SUBMITTING…' : 'SUBMIT REVIEW'} <ArrowRight size={15} /></button></div>
          {reviewNotice && <p className="review-submit-notice" role="status">{reviewNotice}{needsLogin && <> <RouteLink href="/login" onClick={onTransition} className="text-link">SIGN IN</RouteLink></>}</p>}
        </form>
      </section>
      <div className="review-list">{!reviewCards.length && <p className="review-disclaimer">No reviews yet — be the first to share your thoughts.</p>}{reviewCards.map(review => <article key={review.id} className="review-card"><div className="review-card-top"><span className="reviewer-initial">{review.name.charAt(0)}</span><div><strong>{review.name}</strong><span>{review.verified ? 'Verified purchase' : 'Customer review'} · {new Date(review.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span></div><div className="review-stars" aria-label={`${review.rating} out of 5 stars`}>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div></div><h3>{review.title}</h3><p>{review.text}</p><span className="review-helpful"><CheckCircle2 size={13} />{review.verified ? 'Verified purchase' : 'Published review'}</span></article>)}</div>
    </section>
    <section className="related-products-section"><SectionHeading eyebrow="KEEP THE ROTATION GOING" title="You may also like" description="A few pieces that work well with this one." href={`/collections/${slugify(product.category)}`} onTransition={onTransition} /><ProductGrid products={related} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} /></section>
  </main>
    {sizeGuide && typeof document !== 'undefined' && createPortal(<div className="modal-layer size-guide-layer" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setSizeGuide(false); }}><section className="size-guide-modal" role="dialog" aria-modal="true" aria-labelledby="size-guide-title"><div className="modal-head"><div><span className="eyebrow">FIND YOUR FIT</span><h2 id="size-guide-title">Size guide</h2></div><button type="button" className="icon-button" onClick={() => setSizeGuide(false)} aria-label="Close size guide"><X /></button></div><p>Use these garment measurements as a guide. For a more relaxed silhouette, consider sizing up.</p><div className="size-guide-table-wrap"><table><thead><tr><th>Size</th><th>Chest</th><th>Shoulder</th><th>Length</th></tr></thead><tbody>{[['S', '36–38 in', '16.5 in', '27 in'], ['M', '38–40 in', '17.5 in', '28 in'], ['L', '40–42 in', '18.5 in', '29 in'], ['XL', '42–44 in', '19.5 in', '30 in'], ['XXL', '44–46 in', '20.5 in', '31 in']].map(row => <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td><td>{row[3]}</td></tr>)}</tbody></table></div><button type="button" className="button button-dark" onClick={() => setSizeGuide(false)}>GOT IT <Check size={15} /></button></section></div>, document.body)}
    <div className="mobile-sticky-buy"><div><span>{money(product.price)}</span><small>{selectedSize ? `Size ${selectedSize}` : 'Choose your size'}</small></div><button onClick={() => add()}>ADD TO BAG <ArrowRight size={15} /></button></div>
    <Footer /></>;
}
