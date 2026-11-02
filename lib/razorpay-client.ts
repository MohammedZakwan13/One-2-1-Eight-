/** Browser-side Razorpay Checkout launcher. The result is only a hint: the server verifies the signature before marking anything paid. */
type RazorpayInstance = { open: () => void; on: (event: string, handler: () => void) => void };
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

function loadScript(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve((window as unknown as { Razorpay: RazorpayCtor }).Razorpay);
    script.onerror = () => reject(new Error('Could not load the payment window.'));
    document.head.appendChild(script);
  });
}

export type RazorpayOutcome =
  | { status: 'paid'; response: Record<string, unknown> }
  | { status: 'dismissed' };

export async function openRazorpay(payload: Record<string, unknown>, brandName: string): Promise<RazorpayOutcome> {
  const Razorpay = await loadScript();
  return new Promise(resolve => {
    const checkout = new Razorpay({
      key: payload.keyId, order_id: payload.orderId, amount: payload.amount, currency: payload.currency, name: brandName, prefill: payload.prefill,
      handler: (response: Record<string, unknown>) => resolve({ status: 'paid', response }),
      modal: { ondismiss: () => resolve({ status: 'dismissed' }) },
    });
    checkout.open();
  });
}
