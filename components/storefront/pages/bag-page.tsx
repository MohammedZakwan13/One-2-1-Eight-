'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, Heart, LockKeyhole, Minus, PackageCheck, Plus, ShieldCheck, ShoppingBag, Sparkles, Truck, X } from 'lucide-react';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { money } from '@/lib/format';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useCart } from '@/lib/hooks/use-cart';
import { errorMessage } from '@/lib/api/errors';

export function BagPage() {
  const { settings } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const { cart, count, isLoading, isError, error, refetch, updateItem, removeItem, applyCoupon: applyCouponMutation, removeCoupon } = useCart();
  const [coupon, setCoupon] = useState('');
  const [couponMessage, setCouponMessage] = useState('');
  const [couponIsError, setCouponIsError] = useState(false);
  const [checkoutError, setCheckoutError] = useState(false);
  // Everything below is read from the server-priced cart – the browser never computes money.
  const lines = cart?.lines ?? [];
  const subtotal = cart?.totals.subtotal ?? 0;
  const discount = cart?.totals.discount ?? 0;
  const shipping = cart?.totals.shipping ?? 0;
  const total = cart?.totals.total ?? 0;
  const threshold = cart?.freeShippingThreshold ?? settings.freeShippingThreshold;
  const appliedCoupon = cart?.coupon?.code ?? '';
  const changeQuantity = (lineId: string, quantity: number) => updateItem.mutate({ lineId, quantity }, { onError: failure => notify(errorMessage(failure)) });
  const applyCoupon = () => {
    const code = coupon.trim();
    if (!code) return;
    applyCouponMutation.mutate(code, {
      onSuccess: updated => { setCouponIsError(false); setCouponMessage(`${updated.coupon?.code ?? code} applied.`); setCoupon(''); },
      onError: failure => { setCouponIsError(true); setCouponMessage(errorMessage(failure)); },
    });
  };
  return <><main className="bag-page"><div className="bag-title-row"><div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>Shopping bag</span></div><span className="eyebrow">THE GOOD STUFF, READY WHEN YOU ARE</span><h1>Your bag <span>({count})</span></h1></div>
    {isLoading ? <div className="loading-state" role="status">Loading your bag…</div> : isError ? <div className="error-state" role="alert"><p>{errorMessage(error)}</p><button className="button button-dark" onClick={() => refetch()}>TRY AGAIN</button></div> : !lines.length ? <div className="empty-bag"><div className="empty-bag-art"><ShoppingBag size={43} strokeWidth={1} /><Sparkles size={18} /></div><span className="eyebrow">A LITTLE SPACE FOR SOMETHING GOOD</span><h2>Your bag is waiting.</h2><p>Looks like you haven't found your next favourite yet. Take another look around.</p><div className="empty-bag-actions"><RouteLink href="/collections/new-arrivals" className="button button-dark" onClick={onTransition}>SHOP NEW ARRIVALS <ArrowRight size={15} /></RouteLink><RouteLink href="/wishlist" className="button button-outline" onClick={onTransition}>VIEW WISHLIST <Heart size={15} /></RouteLink></div><div className="empty-bag-benefits"><span><Truck size={16} /> Free shipping over ₹1,499</span><span><ShieldCheck size={16} /> 7-day easy returns</span></div></div> : <div className="bag-layout"><section className="bag-items-column"><div className="bag-section-head"><h2>In your bag <span>{lines.length} styles</span></h2><RouteLink href="/collections/all" className="text-link" onClick={onTransition}>KEEP SHOPPING <ArrowRight size={15} /></RouteLink></div>{lines.map(item => { const product = { slug: item.slug, images: [item.image], name: item.name, color: item.color }; return <article className="bag-item" key={item.id}><RouteLink href={`/products/${product.slug}`} onClick={onTransition} className="bag-item-image"><SmartImage src={product.images[0]} alt={product.name} /></RouteLink><div className="bag-item-detail"><RouteLink href={`/products/${product.slug}`} onClick={onTransition} className="bag-item-name">{product.name}</RouteLink><span className="bag-item-color">{product.color}</span><span className="bag-item-size">Size: {item.size}</span>{item.issue === 'out_of_stock' && <span className="cart-issue">Sold out — remove to continue.</span>}<div className="quantity-control"><button onClick={() => changeQuantity(item.id, item.quantity - 1)} aria-label="Decrease quantity" disabled={updateItem.isPending}><Minus size={14} /></button><span>{item.quantity}</span><button onClick={() => changeQuantity(item.id, item.quantity + 1)} aria-label="Increase quantity" disabled={updateItem.isPending || item.quantity >= item.maxQuantity}><Plus size={14} /></button></div><div className="bag-item-mobile-price">{money(item.lineTotal)}</div></div><div className="bag-item-right"><strong>{money(item.lineTotal)}</strong><button className="remove-item" onClick={() => removeItem.mutate(item.id, { onSuccess: () => notify('Item removed from your bag.'), onError: failure => notify(errorMessage(failure)) })}><X size={14} /> REMOVE</button></div></article>; })}<div className="bag-return-note"><PackageCheck size={19} /><div><strong>Not quite right? No worries.</strong><span>{settings.returnPolicy}</span></div></div></section>
      <aside className="order-summary"><span className="eyebrow">THE NUMBERS</span><h2>Order summary</h2><div className="summary-shipping-progress"><div className="shipping-progress-copy">{subtotal >= threshold ? <><CheckCircle2 size={15} /> You've unlocked complimentary shipping</> : <span>Add {money(threshold - subtotal)} more for free shipping</span>}</div><div className="shipping-progress-track"><i style={{ width: `${Math.min(100, (threshold > 0 ? (subtotal / threshold) * 100 : 100))}%` }} /></div></div><div className="coupon-field"><label htmlFor="coupon">PROMO CODE</label><div><input id="coupon" value={coupon} onChange={e => setCoupon(e.target.value)} placeholder="Enter code" /><button onClick={applyCoupon}>APPLY</button></div>{couponMessage && <p className={couponIsError ? 'coupon-error' : 'coupon-success'} role="status">{couponMessage}</p>}</div>{appliedCoupon && <div className="applied-coupon"><span><CheckCircle2 size={15} /> {appliedCoupon}</span><button onClick={() => removeCoupon.mutate(undefined, { onSuccess: () => setCouponMessage(''), onError: failure => notify(errorMessage(failure)) })}>REMOVE</button></div>}<div className="summary-line"><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div className="summary-line"><span>Discount</span><strong className={discount ? 'positive-value' : ''}>{discount ? `−${money(discount)}` : '—'}</strong></div><div className="summary-line"><span>Shipping</span><strong>{shipping === 0 ? 'FREE' : money(shipping)}</strong></div><div className="summary-total"><span>Total</span><strong>{money(total)}</strong></div><small className="summary-tax">Inclusive of all taxes.</small>{cart && cart.messages.length > 0 && <p className="coupon-error" role="status">{cart.messages.join(' ')}</p>}<RouteLink href="/checkout" className="button button-dark checkout-button" onClick={() => { if (!lines.length) setCheckoutError(true); onTransition(); }}>CONTINUE TO CHECKOUT <ArrowRight size={17} /></RouteLink>{checkoutError && <p className="coupon-error">Add an item to your bag before checkout.</p>}<p className="secure-summary"><LockKeyhole size={13} /> Safe & secure checkout</p><div className="payment-methods">UPI <i /> VISA <i /> MASTERCARD <i /> COD</div></aside></div>}
  </main><Footer /></>;
}
