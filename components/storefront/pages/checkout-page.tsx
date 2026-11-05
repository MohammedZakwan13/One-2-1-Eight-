'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, Check, CreditCard, ShieldCheck, ShoppingBag } from 'lucide-react';
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
import { DELIVERY_FIELD_ORDER, normalizePhone, validateDelivery, validateDeliveryField, type DeliveryField } from '@/lib/checkout-validation';

const METHOD_FOR_OPTION: Record<string, PaymentMethod> = { UPI: 'upi', Card: 'card', 'Cash on delivery': 'cod' };
const FIELD_LABELS: Record<string, string> = {
  'contact.name': 'Full name', 'contact.phone': 'Mobile number', 'contact.email': 'Email address', 'shippingAddress.pincode': 'Pincode',
  'shippingAddress.line1': 'Address', 'shippingAddress.city': 'City', 'shippingAddress.state': 'State', acceptedTerms: 'Terms',
};
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function CheckoutPage() {
  const { legalPages, paymentMethods, settings } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const router = useRouter();
  const { customer, isLoading: authLoading, setCustomer } = useCustomer();
  const { cart, count: cartCount, isLoading, isError, error, refetch, invalidate } = useCart();
  // The server already guards /checkout; this covers a session that ends while the page is open.
  useEffect(() => { if (!authLoading && !customer) router.replace(loginUrl('/checkout')); }, [authLoading, customer, router]);
  const lines = cart?.lines ?? [];
  const payable = lines.filter(line => line.issue !== 'out_of_stock');
  const totals = cart?.totals ?? { subtotal: 0, discount: 0, shipping: 0, total: 0 };

  const codOnlyItems = payable.filter(line => line.codEnabled !== false && line.onlinePaymentEnabled === false);
  const onlineOnlyItems = payable.filter(line => line.codEnabled === false && line.onlinePaymentEnabled !== false);
  const isConflict = Boolean(cart?.paymentConflict) || (codOnlyItems.length > 0 && onlineOnlyItems.length > 0);
  const isOnlineOnlyCart = payable.length > 0 && payable.every(line => line.onlinePaymentEnabled !== false) && !payable.every(line => line.codEnabled !== false);
  const isCodOnlyCart = payable.length > 0 && payable.every(line => line.codEnabled !== false) && !payable.every(line => line.onlinePaymentEnabled !== false);

  const allowedMethods = cart?.allowedPaymentMethods ?? paymentMethods;
  const availableOptions = [{ name: 'UPI', method: 'upi', desc: 'GPay, PhonePe, Paytm', icon: '↗' }, { name: 'Card', method: 'card', desc: 'Credit or debit card', icon: '▰' }, { name: 'Cash on delivery', method: 'cod', desc: 'Pay when your order arrives', icon: '₹' }].filter(option => allowedMethods.includes(option.method as PaymentMethod));
  const [address, setAddress] = useState({ name: '', phone: '', email: '', pin: '', line1: '', city: '', state: '' });
  const [payment, setPayment] = useState(() => availableOptions[0]?.name ?? (paymentMethods.includes('upi') ? 'UPI' : 'Cash on delivery'));
  const [accepted, setAccepted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<DeliveryField, boolean>>>({});
  const [showAllErrors, setShowAllErrors] = useState(false);
  const fieldError = (field: DeliveryField) => (touched[field] || showAllErrors ? validateDeliveryField(field, address[field]) : '');
  const setField = (field: DeliveryField, value: string) => setAddress(current => ({ ...current, [field]: value }));
  const inputProps = (field: DeliveryField) => ({
    value: address[field], onChange: (e: { target: { value: string } }) => setField(field, field === 'pin' ? e.target.value.replace(/D/g, '').slice(0, 6) : e.target.value),
    onBlur: () => setTouched(current => ({ ...current, [field]: true })),
    'aria-invalid': fieldError(field) ? true : undefined, 'aria-describedby': fieldError(field) ? `checkout-${field}-error` : undefined,
  });
  const errorText = (field: DeliveryField) => { const message = fieldError(field); return message ? <small className="field-error" id={`checkout-${field}-error`} role="alert">{message}</small> : null; };
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string[]>([]);
  // One idempotency key per distinct payload, so a retried submit can never create two orders.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

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
    if (isConflict) {
      setFormError(['The items in your bag have conflicting payment options and cannot be checked out together. Please purchase them separately.']);
      return;
    }
    if (!availableOptions.length) {
      setFormError([isOnlineOnlyCart ? 'Online payment is currently being configured. Cash on delivery is unavailable for your selected items.' : 'No payment method is currently available for this order.']);
      return;
    }
    const invalid = validateDelivery(address);
    const firstInvalid = DELIVERY_FIELD_ORDER.find(field => invalid[field]);
    if (firstInvalid) {
      setShowAllErrors(true); setFormError([]);
      document.querySelector<HTMLInputElement>(`[data-checkout-field="${firstInvalid}"]`)?.focus();
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
          try {
            await api.orders.verifyPayment(next.paymentId, outcome.response);
            router.push(confirmationPath(result.order.id, result.lookupToken));
            return;
          } catch (failure) {
            setFormError([errorMessage(failure)]);
            setSubmitting(false);
            notify('Payment verification failed. If your account was debited, it will be reconciled automatically.');
            return;
          }
        }
        if (outcome.status === 'dismissed') {
          setSubmitting(false);
          notify('Payment window was closed. You can complete your order whenever you are ready.');
          return;
        }
        if (outcome.status === 'failed') {
          setSubmitting(false);
          setFormError([outcome.description || 'Payment could not be processed by your bank or UPI provider. Please try again.']);
          notify('Payment failed. Please try again.');
          return;
        }
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
  return <><main className="checkout-page"><div className="checkout-title"><div className="breadcrumbs"><RouteLink href="/bag" onClick={onTransition}>Bag</RouteLink><span>/</span><span>Checkout</span></div><span className="eyebrow">ALMOST YOURS</span><h1>Let's get it<br /><em>to your door.</em></h1></div>{isLoading ? <div className="loading-state" role="status">Loading your bag…</div> : isError ? <div className="error-state" role="alert"><p>{errorMessage(error)}</p><button className="button button-dark" onClick={() => refetch()}>TRY AGAIN</button></div> : !lines.length ? <div className="empty-checkout"><ShoppingBag size={30} /><h2>Your bag is empty</h2><RouteLink href="/collections/all" onClick={onTransition} className="button button-dark">EXPLORE THE COLLECTION <ArrowRight size={16} /></RouteLink></div> : <form className="checkout-layout" onSubmit={submit} noValidate><div className="checkout-form-column"><section className="checkout-card"><span className="checkout-step">01</span><div className="checkout-card-heading"><h2>Delivery details</h2><p>Where should we send your order?</p></div><div className="form-grid-two"><label>Full name<input required autoComplete="name" maxLength={120} placeholder="Name on delivery" data-checkout-field="name" {...inputProps('name')} />{errorText('name')}</label><label>Mobile number<input required type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} placeholder="10-digit mobile" data-checkout-field="phone" {...inputProps('phone')} />{errorText('phone')}</label><label>Email address<input required type="email" autoComplete="email" maxLength={254} placeholder="For order updates" data-checkout-field="email" {...inputProps('email')} />{errorText('email')}</label><label>Pincode<input required inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder="6-digit pincode" data-checkout-field="pin" {...inputProps('pin')} />{errorText('pin')}</label></div><label>Address<input required autoComplete="address-line1" maxLength={200} placeholder="House / flat, street, landmark" data-checkout-field="line1" {...inputProps('line1')} />{errorText('line1')}</label><div className="form-grid-two"><label>City<input required autoComplete="address-level2" maxLength={80} placeholder="City" data-checkout-field="city" {...inputProps('city')} />{errorText('city')}</label><label>State<input required autoComplete="address-level1" maxLength={80} placeholder="State" data-checkout-field="state" {...inputProps('state')} />{errorText('state')}</label></div></section><section className="checkout-card"><span className="checkout-step">02</span><div className="checkout-card-heading"><h2>Payment method</h2><p>Select a payment option.</p></div>
              {isConflict ? (
                <div className="payment-conflict-banner" role="alert">
                  <div className="conflict-badge">
                    <AlertCircle size={18} />
                    <span>Incompatible Payment Methods in Bag</span>
                  </div>
                  <p className="conflict-explanation">
                    The items in your bag have different payment requirements and cannot be purchased together in a single order:
                  </p>
                  <div className="conflict-groups">
                    {codOnlyItems.length > 0 && (
                      <div className="conflict-group">
                        <span className="conflict-group-title">Cash on Delivery (COD) Only:</span>
                        <ul>
                          {codOnlyItems.map(item => (
                            <li key={item.id}>
                              <strong>{item.name}</strong> · Size {item.size}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {onlineOnlyItems.length > 0 && (
                      <div className="conflict-group">
                        <span className="conflict-group-title">Online Payment Only:</span>
                        <ul>
                          {onlineOnlyItems.map(item => (
                            <li key={item.id}>
                              <strong>{item.name}</strong> · Size {item.size}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <p className="conflict-action-text">
                    Please return to your shopping bag to separate these pieces into separate orders.
                  </p>
                  <RouteLink href="/bag" onClick={onTransition} className="button button-outline separate-bag-btn">
                    RETURN TO BAG TO SEPARATE PIECES <ArrowRight size={14} />
                  </RouteLink>
                </div>
              ) : isOnlineOnlyCart && !availableOptions.length ? (
                <div className="payment-configuring-banner" role="status">
                  <div className="configuring-badge">
                    <CreditCard size={18} />
                    <span>Online Payment is Currently Being Configured</span>
                  </div>
                  <p>
                    The pieces in your bag are eligible for Online Payment only (Cash on delivery is unavailable). Our secure online payment gateway is currently being finalized.
                  </p>
                  <p>
                    Please check back shortly, or contact us at <a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a>.
                  </p>
                  <RouteLink href="/bag" onClick={onTransition} className="button button-outline separate-bag-btn">
                    RETURN TO BAG <ArrowRight size={14} />
                  </RouteLink>
                </div>
              ) : availableOptions.length > 0 ? (
                <>
                  {isOnlineOnlyCart && (
                    <div className="payment-method-note">
                      <ShieldCheck size={15} />
                      <span>Online payment only: Cash on delivery is unavailable for the pieces in your bag.</span>
                    </div>
                  )}
                  {isCodOnlyCart && (
                    <div className="payment-method-note">
                      <ShieldCheck size={15} />
                      <span>Cash on delivery only: Online payment is unavailable for the pieces in your bag.</span>
                    </div>
                  )}
                  <div className="payment-options">
                    {availableOptions.map(option => (
                      <button
                        type="button"
                        key={option.name}
                        onClick={() => setPayment(option.name)}
                        className={payment === option.name ? 'selected' : ''}
                      >
                        <span className="payment-option-icon">{option.icon}</span>
                        <span>
                          <strong>{option.name}</strong>
                          <small>{option.desc}</small>
                        </span>
                        <i>{payment === option.name ? <Check size={13} /> : null}</i>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="payment-configuring-banner" role="status">
                  <div className="configuring-badge">
                    <AlertCircle size={18} />
                    <span>No Available Payment Method</span>
                  </div>
                  <p>No valid payment method is currently available for this order. Please review your bag or contact support.</p>
                  <RouteLink href="/bag" onClick={onTransition} className="button button-outline separate-bag-btn">
                    RETURN TO BAG <ArrowRight size={14} />
                  </RouteLink>
                </div>
              )}
            <label className="checkout-terms"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>{legalPages.length ? <>I agree to the {legalPages.map((page, index) => <span key={page.slug}>{index > 0 && ' and '}<RouteLink href={`/policies/${page.slug}`} onClick={onTransition} className="text-link" target="_blank">{page.title}</RouteLink></span>)}.</> : 'I agree to the terms of sale.'}</span></label></section></div><aside className="checkout-summary"><span className="eyebrow">ORDER REVIEW</span><h2>Your pieces <span>({cartCount})</span></h2><div className="checkout-items">{lines.map(item => <div className="checkout-item" key={item.id}><SmartImage src={item.image} alt={item.name} /><div><strong>{item.name}</strong><span>Size {item.size} · Qty {item.quantity}</span>{item.issue === 'out_of_stock' && <span className="cart-issue">Sold out — go back to your bag to remove it.</span>}</div><b>{money(item.lineTotal)}</b></div>)}</div><div className="summary-line"><span>Subtotal</span><strong>{money(totals.subtotal)}</strong></div>{totals.discount > 0 && <div className="summary-line"><span>Discount</span><strong className="positive-value">−{money(totals.discount)}</strong></div>}<div className="summary-line"><span>Shipping</span><strong>{totals.shipping === 0 ? 'FREE' : money(totals.shipping)}</strong></div><div className="summary-total"><span>To pay</span><strong>{money(totals.total)}</strong></div>{formError.length > 0 && <div className="form-error-banner" role="alert">{formError.map(message => <p key={message}>{message}</p>)}</div>}<button className="button button-dark checkout-place-order" type="submit" disabled={submitting || !availableOptions.length || isConflict}>{submitting ? 'PLACING ORDER…' : isConflict ? 'PAYMENT RESTRICTION CONFLICT' : !availableOptions.length ? (isOnlineOnlyCart ? 'ONLINE PAYMENT CONFIGURING' : 'PAYMENT UNAVAILABLE') : 'PLACE ORDER'} <ArrowRight size={17} /></button><div className="checkout-safe"><ShieldCheck size={15} /> Secure checkout</div></aside></form>}</main><Footer /></>;
}
