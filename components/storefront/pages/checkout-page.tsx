'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, ShieldCheck, ShoppingBag } from 'lucide-react';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { money } from '@/lib/format';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useCart } from '@/lib/hooks/use-cart';
import { useCustomer } from '@/lib/hooks/use-customer';
import { loginUrl } from '@/lib/return-to';
import { api } from '@/lib/api/client';
import { errorMessage, isUnauthorized } from '@/lib/api/errors';
import { createOrderRequestSchema, type PaymentMethod } from '@/lib/api/schemas';
import { confirmationPath, planPaymentNext } from '@/lib/payments';
import { openRazorpay } from '@/lib/razorpay-client';

const METHOD_FOR_OPTION: Record<string, PaymentMethod> = { UPI: 'upi', Card: 'card', 'Cash on delivery': 'cod' };
const FIELD_LABELS: Record<string, string> = {
  'contact.name': 'Full name', 'contact.phone': 'Mobile number', 'contact.email': 'Email address', 'shippingAddress.pincode': 'Pincode',
  'shippingAddress.line1': 'Address', 'shippingAddress.city': 'City', 'shippingAddress.state': 'State', acceptedTerms: 'Terms',
};
const normalizePhone = (value: string) => { const digits = value.replace(/\D/g, ''); return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits; };
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function CheckoutPage() {
  const { legalPages, paymentMethods, settings } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const router = useRouter();
  const { customer, isLoading: authLoading, setCustomer } = useCustomer();
  const { cart, count: cartCount, isLoading, isError, error, refetch, invalidate } = useCart();
  // The server already guards /checkout; this covers a session that ends while the page is open.
  useEffect(() => { if (!authLoading && !customer) router.replace(loginUrl('/checkout')); }, [authLoading, customer, router]);
  const allowedMethods = cart?.allowedPaymentMethods ?? paymentMethods;
  const availableOptions = [{ name: 'UPI', method: 'upi', desc: 'GPay, PhonePe, Paytm', icon: '↗' }, { name: 'Card', method: 'card', desc: 'Credit or debit card', icon: '▰' }, { name: 'Cash on delivery', method: 'cod', desc: 'Pay when your order arrives', icon: '₹' }].filter(option => allowedMethods.includes(option.method as PaymentMethod));
  const [address, setAddress] = useState({ name: '', phone: '', email: '', pin: '', line1: '', city: '', state: '' });
  const [payment, setPayment] = useState(() => availableOptions[0]?.name ?? (paymentMethods.includes('upi') ? 'UPI' : 'Cash on delivery'));
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string[]>([]);
  // One idempotency key per distinct payload, so a retried submit can never create two orders.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const lines = cart?.lines ?? [];
  const totals = cart?.totals ?? { subtotal: 0, discount: 0, shipping: 0, total: 0 };

  useEffect(() => {
    if (availableOptions.length === 1 && payment !== availableOptions[0].name) {
      setPayment(availableOptions[0].name);
    } else if (availableOptions.length > 1 && !availableOptions.some(opt => opt.name === payment)) {
      setPayment(availableOptions[0].name);
    }
  }, [availableOptions, payment]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!cartCount) { notify('Your bag is empty.'); router.push('/collections/all'); return; }
    if (!availableOptions.length || cart?.paymentConflict) {
      setFormError(['The items in your bag have conflicting payment options and cannot be checked out together. Please purchase them separately.']);
      return;
    }
    const parsed = createOrderRequestSchema.safeParse({
      contact: { name: address.name, phone: normalizePhone(address.phone), email: address.email },
      shippingAddress: { line1: address.line1, city: address.city, state: address.state, pincode: address.pin },
      paymentMethod: METHOD_FOR_OPTION[payment] ?? 'upi',
      acceptedTerms: accepted,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues.map(issue => { const path = issue.path.join('.'); return `${FIELD_LABELS[path] ?? path}: ${path === 'acceptedTerms' ? 'please accept the terms to continue' : issue.message}`; }));
      return;
    }
    setFormError([]); setSubmitting(true);
    const fingerprint = JSON.stringify(parsed.data);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newKey() };
    try {
      const result = await api.orders.create(parsed.data, attempt.current.key);
      await invalidate();
      const next = planPaymentNext(result);
      if (next.type === 'redirect') { window.location.assign(next.url); return; }
      if (next.type === 'razorpay') {
        const outcome = await openRazorpay(next.payload, settings.brandName);
        if (outcome.status === 'paid') {
          try { await api.orders.verifyPayment(next.paymentId, outcome.response); } catch (failure) { notify(errorMessage(failure)); }
        }
        router.push(confirmationPath(result.order.id, result.lookupToken));
        return;
      }
      if (next.type === 'unsupported') {
        setFormError([`Your order ${result.order.number} was created but this payment method is not available yet. Please contact us to complete payment.`]);
        setSubmitting(false);
        return;
      }
      router.push(confirmationPath(result.order.id, result.lookupToken));
    } catch (failure) {
      if (isUnauthorized(failure)) { setCustomer(null); router.replace(loginUrl('/checkout')); return; }
      setFormError([errorMessage(failure)]);
      setSubmitting(false);
    }
  };
  if (authLoading || !customer) return <main className="checkout-page"><div className="loading-state" role="status">Loading checkout…</div></main>;
  return <><main className="checkout-page"><div className="checkout-title"><div className="breadcrumbs"><RouteLink href="/bag" onClick={onTransition}>Bag</RouteLink><span>/</span><span>Checkout</span></div><span className="eyebrow">ALMOST YOURS</span><h1>Let's get it<br /><em>to your door.</em></h1></div>{isLoading ? <div className="loading-state" role="status">Loading your bag…</div> : isError ? <div className="error-state" role="alert"><p>{errorMessage(error)}</p><button className="button button-dark" onClick={() => refetch()}>TRY AGAIN</button></div> : !lines.length ? <div className="empty-checkout"><ShoppingBag size={30} /><h2>Your bag is empty</h2><RouteLink href="/collections/all" onClick={onTransition} className="button button-dark">EXPLORE THE COLLECTION <ArrowRight size={16} /></RouteLink></div> : <form className="checkout-layout" onSubmit={submit}><div className="checkout-form-column"><section className="checkout-card"><span className="checkout-step">01</span><div className="checkout-card-heading"><h2>Delivery details</h2><p>Where should we send your order?</p></div><div className="form-grid-two"><label>Full name<input required autoComplete="name" maxLength={120} value={address.name} onChange={e => setAddress({ ...address, name: e.target.value })} placeholder="Name on delivery" /></label><label>Mobile number<input required type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} value={address.phone} onChange={e => setAddress({ ...address, phone: e.target.value })} placeholder="10-digit mobile" /></label><label>Email address<input required type="email" autoComplete="email" maxLength={254} value={address.email} onChange={e => setAddress({ ...address, email: e.target.value })} placeholder="For order updates" /></label><label>Pincode<input required inputMode="numeric" maxLength={6} value={address.pin} onChange={e => setAddress({ ...address, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} placeholder="6-digit pincode" /></label></div><label>Address<input required value={address.line1} onChange={e => setAddress({ ...address, line1: e.target.value })} placeholder="House / flat, street, landmark" /></label><div className="form-grid-two"><label>City<input required value={address.city} onChange={e => setAddress({ ...address, city: e.target.value })} placeholder="City" /></label><label>State<input required value={address.state} onChange={e => setAddress({ ...address, state: e.target.value })} placeholder="State" /></label></div></section><section className="checkout-card"><span className="checkout-step">02</span><div className="checkout-card-heading"><h2>Payment method</h2><p>Select a payment option.</p></div>{availableOptions.length ? <div className="payment-options">{availableOptions.map(option => <button type="button" key={option.name} onClick={() => setPayment(option.name)} className={payment === option.name ? 'selected' : ''}><span className="payment-option-icon">{option.icon}</span><span><strong>{option.name}</strong><small>{option.desc}</small></span><i>{payment === option.name ? <Check size={13} /> : null}</i></button>)}</div> : <div className="form-error-banner" role="alert"><p>The items in your bag have conflicting payment options (some allow only Cash on Delivery, while others allow only Online Payment). Please purchase them separately.</p></div>}<label className="checkout-terms"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>{legalPages.length ? <>I agree to the {legalPages.map((page, index) => <span key={page.slug}>{index > 0 && ' and '}<RouteLink href={`/policies/${page.slug}`} onClick={onTransition} className="text-link" target="_blank">{page.title}</RouteLink></span>)}.</> : 'I agree to the terms of sale.'}</span></label></section></div><aside className="checkout-summary"><span className="eyebrow">ORDER REVIEW</span><h2>Your pieces <span>({cartCount})</span></h2><div className="checkout-items">{lines.map(item => <div className="checkout-item" key={item.id}><SmartImage src={item.image} alt={item.name} /><div><strong>{item.name}</strong><span>Size {item.size} · Qty {item.quantity}</span>{item.issue === 'out_of_stock' && <span className="cart-issue">Sold out — go back to your bag to remove it.</span>}</div><b>{money(item.lineTotal)}</b></div>)}</div><div className="summary-line"><span>Subtotal</span><strong>{money(totals.subtotal)}</strong></div>{totals.discount > 0 && <div className="summary-line"><span>Discount</span><strong className="positive-value">−{money(totals.discount)}</strong></div>}<div className="summary-line"><span>Shipping</span><strong>{totals.shipping === 0 ? 'FREE' : money(totals.shipping)}</strong></div><div className="summary-total"><span>To pay</span><strong>{money(totals.total)}</strong></div>{formError.length > 0 && <div className="form-error-banner" role="alert">{formError.map(message => <p key={message}>{message}</p>)}</div>}<button className="button button-dark checkout-place-order" type="submit" disabled={submitting || !availableOptions.length || Boolean(cart?.paymentConflict)}>{submitting ? 'PLACING ORDER…' : 'PLACE ORDER'} <ArrowRight size={17} /></button><div className="checkout-safe"><ShieldCheck size={15} /> Secure checkout</div></aside></form>}</main><Footer /></>;
}
