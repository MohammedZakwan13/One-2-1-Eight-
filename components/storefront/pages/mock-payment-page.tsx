'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { Footer } from '@/components/storefront/footer';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { confirmationPath } from '@/lib/payments';

/**
 * DEVELOPMENT / TEST ONLY stand-in for a payment provider's hosted page (the route 404s unless API_MODE=mock).
 * It shows the real contract in action: the browser reports an outcome, the SERVER records the payment status,
 * and the confirmation page reads that status back.
 */
export function MockPaymentPage({ paymentId, orderId, token }: { paymentId: string; orderId: string; token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settle = async (outcome: 'success' | 'failure') => {
    setBusy(true); setError('');
    try {
      await api.orders.verifyPayment(paymentId, { outcome });
      router.push(confirmationPath(orderId, token));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  return <><main className="checkout-page">
    <div className="checkout-title"><span className="eyebrow">DEVELOPMENT MOCK</span><h1>Mock payment<br /><em>gateway.</em></h1></div>
    <section className="checkout-card">
      <div className="checkout-card-heading"><h2>Simulate the provider</h2><p>No real payment is taken. Choose what the mock gateway should report to the server.</p></div>
      {error && <p className="form-error-banner" role="alert">{error}</p>}
      <div className="confirmation-actions">
        <button className="button button-dark" disabled={busy} onClick={() => settle('success')}>SIMULATE SUCCESS <ArrowRight size={16} /></button>
        <button className="button button-outline" disabled={busy} onClick={() => settle('failure')}>SIMULATE FAILURE</button>
      </div>
    </section>
  </main><Footer /></>;
}
