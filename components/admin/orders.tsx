'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, PackageCheck, Search } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState, titleCase } from '@/components/admin/data-state';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { orderStatusSchema } from '@/lib/api/schemas';
import { money, slugify } from '@/lib/format';

export function AdminOrders() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'orders'], queryFn: () => api.admin.orders.list() });
  const orders = query.data?.items ?? [];
  const [search, setSearch] = useState('');
  const statusMutation = useMutation({
    mutationFn: (input: { id: string; number: string; status: string }) => api.admin.orders.updateStatus(input.id, input.status),
    onSuccess: async (_order, input) => { await client.invalidateQueries({ queryKey: ['admin', 'orders'] }); notify(`Order ${input.number} status updated.`); },
    onError: failure => notify(errorMessage(failure)),
  });
  const filtered = orders.filter(order => `${order.number} ${order.contact.name} ${order.status}`.toLowerCase().includes(search.toLowerCase()));
  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">SELLING / FULFILMENT</span><h1>Orders <span className="admin-count-chip">{query.data?.total ?? orders.length}</span></h1><p>Review orders and update their fulfilment status. Payment status is set by the payment provider, not here.</p></div><div className="admin-page-actions"><a className="admin-secondary-btn" href={api.admin.orders.exportUrl} download><ArrowDownRight size={15} /> Export</a></div></div><section className="admin-card admin-orders-full"><div className="admin-list-toolbar"><div className="admin-input-icon"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order number or customer" aria-label="Search orders" /></div><span>{filtered.length} orders</span></div><div className="admin-table-wrap"><table className="admin-table admin-table-spacious"><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>DATE</th><th>ITEMS</th><th>TOTAL</th><th>PAYMENT</th><th>STATUS</th><th>UPDATE</th></tr></thead><tbody>{filtered.map(order => <tr key={order.id}><td><strong>{order.number}</strong></td><td>{order.contact.name}</td><td>{order.createdAt.slice(0, 10)}</td><td>{order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td><td><strong>{money(order.totals.total)}</strong></td><td>{titleCase(order.paymentStatus)}</td><td><span className={`status-pill status-${slugify(order.status)}`}>{titleCase(order.status)}</span></td><td><select value={order.status} disabled={statusMutation.isPending} onChange={e => statusMutation.mutate({ id: order.id, number: order.number, status: e.target.value })} aria-label={`Update status for ${order.number}`}>{orderStatusSchema.options.map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select></td></tr>)}</tbody></table></div>{!filtered.length && <div className="admin-table-empty">No orders match your search.</div>}</section><div className="admin-callout"><PackageCheck size={18} /><p><strong>Order lifecycle:</strong> orders, payments and shipments are owned by the backend. Status changes made here are validated by the server, which may reject invalid transitions.</p></div></div>
  </AdminDataState>;
}
