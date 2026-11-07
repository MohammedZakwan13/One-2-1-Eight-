'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ChevronDown, PackageCheck, Search } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState, titleCase } from '@/components/admin/data-state';
import { Pagination, useDebounced } from '@/components/admin/pagination';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { OrderReturn, UpdateOrderStatus, UpdateReturn } from '@/lib/api/schemas';
import { money, slugify } from '@/lib/format';
import { parseTrackingUrl, TRACKING_URL_MAX } from '@/lib/tracking-url';

/** Mirrors transition_order in the database; only a UI hint, the server enforces it. */
const NEXT: Record<string, UpdateOrderStatus['status'][]> = {
  pending_payment: ['cancelled'], confirmed: ['processing', 'cancelled'], processing: ['packed', 'cancelled'], packed: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: ['refunded'],
};
const ORDER_STATUSES = ['pending_payment', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;
const RETURN_NEXT: Record<string, string[]> = { requested: ['approved', 'rejected'], approved: ['received'], received: ['refund_pending', 'completed'], refund_pending: ['completed'] };

export function AdminOrders() {
  const { notify } = useUi();
  const confirm = useConfirm();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [returnPage, setReturnPage] = useState(1);
  const q = useDebounced(search.trim());
  // Search, status filter and paging all run on the server, so any number of orders stays fast and complete.
  const query = useQuery({ queryKey: ['admin', 'orders', { page, pageSize, q, status: statusFilter }], queryFn: () => api.admin.orders.list({ page, pageSize, q, status: statusFilter }), placeholderData: keepPreviousData });
  const orders = query.data?.items ?? [];
  const returnsQuery = useQuery({ queryKey: ['admin', 'returns', { page: returnPage }], queryFn: () => api.admin.orders.listReturns({ page: returnPage, pageSize: 25 }), placeholderData: keepPreviousData });
  const [openId, setOpenId] = useState<string | null>(null);
  const statusMutation = useMutation({
    mutationFn: (input: { id: string; number: string; update: UpdateOrderStatus }) => api.admin.orders.updateStatus(input.id, input.update),
    onSuccess: async (_order, input) => { await Promise.all([client.invalidateQueries({ queryKey: ['admin', 'orders'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] }), client.invalidateQueries({ queryKey: ['admin', 'products'] })]); notify(`Order ${input.number} status updated.`); },
    onError: failure => notify(errorMessage(failure)),
  });
  const apply = async (order: { id: string; number: string }, update: UpdateOrderStatus) => {
    await api.admin.orders.updateStatus(order.id, update);
    await Promise.all([client.invalidateQueries({ queryKey: ['admin', 'orders'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] }), client.invalidateQueries({ queryKey: ['admin', 'products'] })]);
    notify(`Order ${order.number} status updated.`);
  };
  const changeStatus = (order: { id: string; number: string }, status: UpdateOrderStatus['status']) => {
    if (status === 'shipped') {
      confirm({
        title: 'Mark order as shipped?', tone: 'default', confirmLabel: 'Mark as shipped',
        message: `Add the courier details for order ${order.number} (optional). Customers see them in their shipping email.`,
        fields: [{ name: 'carrier', label: 'Courier name', maxLength: 80 }, { name: 'trackingNumber', label: 'Tracking number', maxLength: 80 }, { name: 'trackingUrl', label: 'Tracking link (optional, https://…)', maxLength: TRACKING_URL_MAX, type: 'url', placeholder: 'https://courier.example/track/123', validate: value => { const parsed = parseTrackingUrl(value); return parsed.ok ? null : parsed.error; } }],
        onConfirm: values => {
          const link = parseTrackingUrl(values.trackingUrl);
          if (!link.ok) throw new Error(link.error);
          return apply(order, { status, carrier: values.carrier?.trim() || null, trackingNumber: values.trackingNumber?.trim() || null, trackingUrl: link.url });
        },
      });
    } else if (status === 'cancelled') {
      confirm({ title: 'Cancel order?', message: `Are you sure you want to cancel order ${order.number}? Reserved stock is returned to inventory. This action cannot be undone.`, confirmLabel: 'Cancel order', onConfirm: () => apply(order, { status }) });
    } else {
      void apply(order, { status }).catch(failure => notify(errorMessage(failure)));
    }
  };
  const refreshReturns = () => Promise.all([client.invalidateQueries({ queryKey: ['admin', 'returns'] }), client.invalidateQueries({ queryKey: ['admin', 'orders'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] }), client.invalidateQueries({ queryKey: ['admin', 'products'] })]);
  const applyReturn = async (ret: OrderReturn, update: UpdateReturn) => { await api.admin.orders.updateReturn(ret.id, update); await refreshReturns(); notify(`Return ${ret.number} updated.`); };
  const decide = (ret: OrderReturn, status: UpdateReturn['status']) => {
    const note = { name: 'note', label: 'Note for the customer (optional)', maxLength: 300 };
    if (status === 'received') {
      confirm({ title: 'Item received?', tone: 'default', confirmLabel: 'Received, put back in stock', message: `Confirm the returned item for ${ret.number} arrived and passed inspection. Stock is increased by the returned quantity, once.`, fields: [note], onConfirm: v => applyReturn(ret, { status, restock: true, note: v.note?.trim() || null }) });
      return;
    }
    if (status === 'completed') {
      confirm({ title: 'Confirm refund paid?', tone: 'default', confirmLabel: 'Mark refund completed', message: `Only confirm after the money was actually sent. Enter the bank/UPI/provider reference for ${ret.number}.`, fields: [{ name: 'ref', label: 'Refund reference', maxLength: 120 }, note], onConfirm: v => applyReturn(ret, { status, refundReference: v.ref?.trim() || null, note: v.note?.trim() || null }) });
      return;
    }
    confirm({ title: `${titleCase(status)} return?`, tone: status === 'rejected' ? 'danger' : 'default', confirmLabel: titleCase(status), message: `Return ${ret.number} for order ${ret.orderNumber}.`, fields: [note], onConfirm: v => applyReturn(ret, { status, note: v.note?.trim() || null }) });
  };
  const returns = returnsQuery.data?.items ?? [];
  const filtered = orders;
  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">SELLING / FULFILMENT</span><h1>Orders <span className="admin-count-chip">{query.data?.total ?? orders.length}</span></h1><p>Review orders and update their fulfilment status. Payment status is set by the payment provider, not here.</p></div><div className="admin-page-actions"><a className="admin-secondary-btn" href={api.admin.orders.exportUrl} download><ArrowDownRight size={15} /> Export</a></div></div>
    <section className="admin-card admin-orders-full"><div className="admin-list-toolbar"><div className="admin-input-icon"><Search size={16} /><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search order number, customer or mobile" aria-label="Search orders" /></div><select className="admin-filter-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter by status"><option value="">All statuses</option>{ORDER_STATUSES.map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select><span>{query.data?.total ?? 0} orders</span></div>
      <div className="admin-table-wrap"><table className="admin-table admin-table-spacious"><thead><tr><th>ORDER</th><th>CUSTOMER</th><th className="order-col-mobile">MOBILE</th><th>DATE</th><th>ITEMS</th><th>TOTAL</th><th>PAYMENT</th><th>STATUS</th><th>UPDATE</th><th aria-label="Details" /></tr></thead><tbody>{filtered.map(order => {
        const next = NEXT[order.status] ?? [];
        const open = openId === order.id;
        return [<tr key={order.id}>
          <td><strong>{order.number}</strong></td>
          <td className="order-customer"><span className="order-field"><em>Name</em><strong>{order.contact.name}</strong></span><span className="order-field order-field-mobile"><em>Mobile</em><b>{order.contact.phone ? `+91 ${order.contact.phone}` : 'Not recorded'}</b></span></td>
          <td className="order-col-mobile">{order.contact.phone ? `+91 ${order.contact.phone}` : <small>Not recorded</small>}</td>
          <td>{order.createdAt.slice(0, 10)}</td><td>{order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td><td><strong>{money(order.totals.total)}</strong></td><td>{titleCase(order.paymentStatus)}</td>
          <td><span className={`status-pill status-${slugify(order.status)}`}>{titleCase(order.status)}</span></td>
          <td>{next.length ? <select className="admin-status-select" value={order.status} disabled={statusMutation.isPending} onChange={e => changeStatus(order, e.target.value as UpdateOrderStatus['status'])} aria-label={`Update status for ${order.number}`}>{[order.status, ...next].map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select> : <small>No further changes</small>}</td>
          <td><button type="button" className="admin-secondary-btn" aria-expanded={open} onClick={() => setOpenId(open ? null : order.id)}>Details <ChevronDown size={14} /></button></td>
        </tr>,
        open && <tr key={`${order.id}-details`}><td colSpan={10}><div className="order-detail-grid">
          <div><h3>Customer</h3><p>{order.contact.name}<br />{order.contact.phone ? `+91 ${order.contact.phone}` : 'Mobile not recorded (older order)'}<br />{order.contact.email}</p><h3>Deliver to</h3><p>{[order.shippingAddress.line1, order.shippingAddress.line2, order.shippingAddress.city, order.shippingAddress.state, order.shippingAddress.pincode].filter(Boolean).join(', ')}</p></div>
          <div><h3>Items</h3><ul>{order.lines.map(line => <li key={`${line.variantId}`}>{line.name} · {line.size} × {line.quantity} · {money(line.lineTotal)}{line.returnable === false ? ' · non-returnable' : ''}{line.exchangeable === false ? ' · non-exchangeable' : ''}{line.returnedQuantity ? ` · ${line.returnedQuantity} in returns` : ''}</li>)}</ul><h3>Payment</h3><p>{order.paymentMethod === 'cod' ? 'Cash on delivery' : order.paymentMethod.toUpperCase()} · {titleCase(order.paymentStatus)}{order.refund ? ` · cancellation refund ${order.refund.status} (${money(order.refund.amount)})` : ''}</p>{order.shipment && <><h3>Shipping</h3><p>{order.shipment.carrier ?? 'Courier not recorded'} · {order.shipment.trackingNumber ?? 'no tracking number'}</p></>}{order.cancelReason && <><h3>Cancellation reason</h3><p>{order.cancelReason}</p></>}</div>
          <div><h3>History</h3><ol>{order.history.map(h => <li key={`${h.status}-${h.at}`}>{titleCase(h.status)} · {h.at.slice(0, 16).replace('T', ' ')}</li>)}</ol></div>
        </div></td></tr>];
      })}</tbody></table></div>{!filtered.length && <div className="admin-table-empty">{q || statusFilter ? 'No orders match your search and filters.' : 'No orders yet.'}</div>}<Pagination page={page} pageSize={pageSize} total={query.data?.total ?? 0} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} noun="orders" busy={query.isFetching} /></section>
    <section className="admin-card admin-orders-full"><div className="admin-list-toolbar"><h2>Return requests <span className="admin-count-chip">{returnsQuery.data?.total ?? returns.length}</span></h2></div>
      {returns.length === 0 ? <div className="admin-table-empty">No return requests{returnsQuery.isError ? ' (could not load)' : ''}.</div> : <div className="admin-table-wrap"><table className="admin-table admin-table-spacious"><thead><tr><th>RETURN</th><th>ORDER</th><th>CUSTOMER / MOBILE</th><th>ITEMS</th><th>REASON</th><th>STATUS</th><th>REFUND</th><th>ACTIONS</th></tr></thead><tbody>{returns.map(ret => <tr key={ret.id}>
        <td><strong>{ret.number}</strong><br /><small>{ret.createdAt.slice(0, 10)}</small></td><td>{ret.orderNumber}</td>
        <td className="order-customer"><span className="order-field"><em>Name</em><strong>{ret.contact?.name}</strong></span><span className="order-field"><em>Mobile</em><b>{ret.contact?.phone ? `+91 ${ret.contact.phone}` : 'Not recorded'}</b></span></td>
        <td>{ret.items.map(item => <div key={item.orderItemId}>{item.name} · {item.size} × {item.quantity}</div>)}</td><td>{ret.reason}</td>
        <td><span className={`status-pill status-${slugify(ret.status)}`}>{titleCase(ret.status)}</span></td>
        <td>{ret.refund ? `${money(ret.refund.amount)} · ${titleCase(ret.refund.status)}${ret.refund.reference ? ` (${ret.refund.reference})` : ''}` : '—'}</td>
        <td>{(RETURN_NEXT[ret.status] ?? []).map(status => <button key={status} type="button" className="admin-secondary-btn" onClick={() => decide(ret, status as UpdateReturn['status'])}>{status === 'received' ? 'Received' : titleCase(status)}</button>)}</td>
      </tr>)}</tbody></table></div>}
      <Pagination page={returnPage} pageSize={25} total={returnsQuery.data?.total ?? 0} onPage={setReturnPage} noun="returns" busy={returnsQuery.isFetching} />
    </section>
    <div className="admin-callout"><PackageCheck size={18} /><p><strong>Order lifecycle:</strong> orders, payments and shipments are owned by the backend. The server only allows valid transitions (e.g. Packed → Shipped); cancelling returns stock. Fulfilment status never marks an order paid. A return only puts stock back after you mark it Received, and a refund is only Completed once you enter its reference.</p></div></div>
  </AdminDataState>;
}
