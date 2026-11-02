'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Order } from '@/lib/api/schemas';
import { money } from '@/lib/format';

const label = (value: string) => value.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const RETURN_STEP: Record<string, string> = {
  requested: 'We are reviewing your request.', approved: 'Approved. Keep the item unused with its tags; we will contact you about pick-up or drop-off.', rejected: 'This request was not approved.',
  received: 'We have your item and are inspecting it.', refund_pending: 'Your refund is being processed. It is not complete yet.', completed: 'Refund completed.',
};

/** Tracking timeline, cancellation and returns for one order. Every rule shown here is decided and enforced by the server. */
export function OrderActions({ order, token }: { order: Order; token: string }) {
  const client = useQueryClient();
  const [panel, setPanel] = useState<'cancel' | 'return' | null>(null);
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['order', order.id] });
  const run = async (action: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await refresh(); setPanel(null); setReason(''); setQuantities({}); setNotice(done); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };

  const eligible = order.lines.filter(line => line.id && line.returnable !== false && line.quantity - (line.returnedQuantity ?? 0) > 0);
  const windowOpen = order.status === 'delivered' && order.returnableUntil && Date.parse(order.returnableUntil) > Date.now();
  const picked = Object.entries(quantities).filter(([, qty]) => qty > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  const nonReturnable = order.lines.filter(line => line.returnable === false);

  return <section className="order-actions" aria-label="Order tracking and actions">
    <h2>Tracking</h2>
    <ol className="order-timeline">{order.history.map(step => <li key={`${step.status}-${step.at}`}><strong>{label(step.status)}</strong><span>{step.at.slice(0, 16).replace('T', ' ')}</span></li>)}</ol>
    {order.shipment && <p>Shipped with <strong>{order.shipment.carrier ?? 'our courier'}</strong>{order.shipment.trackingNumber ? <> · tracking <strong>{order.shipment.trackingNumber}</strong></> : null}{order.shipment.trackingUrl && /^https?:\/\//.test(order.shipment.trackingUrl) ? <> · <a href={order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer">Track with carrier</a></> : null}. Courier updates are on the carrier's site; we do not show live scans.</p>}
    {order.status === 'cancelled' && <p role="status">This order was cancelled{order.cancelReason ? `: ${order.cancelReason}` : ''}.{order.refund ? ` Refund ${order.refund.status === 'completed' ? 'completed' : 'pending'} (${money(order.refund.amount)}).` : order.paymentMethod === 'cod' ? ' No payment was collected, so nothing needs refunding.' : ''}</p>}
    {notice && <p role="status" className="order-notice">{notice}</p>}
    {error && <p role="alert" className="form-error-banner">{error}</p>}

    {order.cancellable && panel !== 'cancel' && <button type="button" className="button button-outline" onClick={() => { setPanel('cancel'); setNotice(null); }}>CANCEL ORDER</button>}
    {panel === 'cancel' && <div className="order-panel" role="group" aria-label="Cancel order">
      <p><strong>Cancel order {order.number}?</strong> Your items go back in stock. This cannot be undone.</p>
      <label>Reason<textarea value={reason} maxLength={300} onChange={e => setReason(e.target.value)} placeholder="Why are you cancelling?" disabled={busy} /></label>
      <div className="order-panel-actions"><button type="button" className="button button-dark" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api.orders.cancel(order.id, reason.trim(), token || undefined), 'Your order has been cancelled.')}>{busy ? 'CANCELLING…' : 'YES, CANCEL ORDER'}</button><button type="button" className="button button-outline" disabled={busy} onClick={() => setPanel(null)}>KEEP ORDER</button></div>
    </div>}
    {!order.cancellable && order.status === 'shipped' && <p className="order-note">This order has shipped, so it can no longer be cancelled. You can request a return after it is delivered.</p>}

    {order.status === 'delivered' && <>
      {windowOpen && eligible.length > 0 && panel !== 'return' && <button type="button" className="button button-outline" onClick={() => { setPanel('return'); setNotice(null); }}>RETURN ITEMS</button>}
      {order.status === 'delivered' && !windowOpen && <p className="order-note">The return window for this order has closed.</p>}
      {nonReturnable.length > 0 && <p className="order-note">Not returnable: {nonReturnable.map(line => line.name).join(', ')}.</p>}
      {panel === 'return' && <div className="order-panel" role="group" aria-label="Request a return">
        <p><strong>Choose items to return</strong> (until {order.returnableUntil?.slice(0, 10)}).</p>
        {eligible.map(line => { const max = line.quantity - (line.returnedQuantity ?? 0); return <label key={line.id}>{line.name} · {line.size} (up to {max})<input type="number" min={0} max={max} value={quantities[line.id!] ?? 0} disabled={busy} onChange={e => setQuantities({ ...quantities, [line.id!]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })} /></label>; })}
        <label>Reason<textarea value={reason} maxLength={500} onChange={e => setReason(e.target.value)} placeholder="Tell us why you are returning this" disabled={busy} /></label>
        <div className="order-panel-actions"><button type="button" className="button button-dark" disabled={busy || !picked.length || reason.trim().length < 3} onClick={() => run(() => api.orders.requestReturn(order.id, { reason: reason.trim(), items: picked }, token || undefined), 'Return request sent. We emailed you a confirmation.')}>{busy ? 'SENDING…' : 'SUBMIT RETURN REQUEST'}</button><button type="button" className="button button-outline" disabled={busy} onClick={() => setPanel(null)}>CLOSE</button></div>
      </div>}
    </>}

    {(order.returns ?? []).map(ret => <div key={ret.id} className="order-return"><strong>Return {ret.number} · {label(ret.status)}</strong><p>{ret.items.map(item => `${item.name} (${item.size}) × ${item.quantity}`).join(', ')}</p><p>{RETURN_STEP[ret.status]}</p>{ret.adminNote && <p>Note from us: {ret.adminNote}</p>}{ret.refund && <p>Refund {money(ret.refund.amount)}: {ret.refund.status === 'completed' ? `completed${ret.refund.reference ? ` (ref ${ret.refund.reference})` : ''}` : ret.refund.status}</p>}</div>)}
  </section>;
}
