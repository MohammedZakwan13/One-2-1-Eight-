import 'server-only';
import { db, trackingUrl } from '@/lib/backend/core';
import { getSettingsRow, toOrder, type Row } from '@/lib/backend/data';
import type { Order, OrderReturn } from '@/lib/api/schemas';

const CANCELLABLE = ['pending_payment', 'confirmed', 'processing', 'packed'];
export const isCancellable = (status: string) => CANCELLABLE.includes(status);

const toRefund = (r: Row | undefined | null) => (r ? { amount: Number(r.amount), status: r.status, reference: r.provider_refund_id ?? null, method: r.provider } : null);

/**
 * Adds cancellation/return/refund facts to orders. Returns and refunds live in tables from migration 0005; before it is
 * applied the lookups fail and orders simply carry no returns (never an error), so older databases keep working.
 */
export async function attachReturns(orders: Order[], rows: Row[], returnWindowDays: number): Promise<Order[]> {
  if (!orders.length) return orders;
  const ids = orders.map(o => o.id);
  const [returnsResult, refundsResult] = await Promise.all([
    db().from('returns').select('*, return_items(order_item_id, quantity)').in('order_id', ids).order('created_at'),
    db().from('refunds').select('*').in('order_id', ids),
  ]);
  const returns = returnsResult.error ? [] : (returnsResult.data as Row[]);
  const refunds = refundsResult.error ? [] : (refundsResult.data as Row[]);
  const rowById = new Map(rows.map(r => [r.id, r]));
  return orders.map(order => {
    const row = rowById.get(order.id)!;
    const myReturns = returns.filter(r => r.order_id === order.id);
    const reserved = new Map<string, number>();
    for (const r of myReturns) if (r.status !== 'rejected') for (const i of r.return_items) reserved.set(i.order_item_id, (reserved.get(i.order_item_id) ?? 0) + i.quantity);
    const lines = order.lines.map(line => ({ ...line, returnedQuantity: line.id ? reserved.get(line.id) ?? 0 : 0 }));
    const delivered = row.delivered_at ? new Date(row.delivered_at) : null;
    const until = delivered ? new Date(delivered.getTime() + returnWindowDays * 86_400_000) : null;
    return {
      ...order, lines,
      cancellable: isCancellable(order.status), cancelReason: row.cancel_reason ?? null,
      deliveredAt: delivered ? delivered.toISOString() : null, returnableUntil: until ? until.toISOString() : null,
      returns: myReturns.map(r => toReturnDto(r, lines, order.number, refunds.find(f => f.return_id === r.id))),
      refund: toRefund(refunds.find(f => f.order_id === order.id && !f.return_id)),
    };
  });
}

export function toReturnDto(r: Row, lines: Order['lines'], orderNumber: string, refund?: Row): OrderReturn {
  return {
    id: r.id, number: r.number, orderId: r.order_id, orderNumber, status: r.status, reason: r.reason, adminNote: r.admin_note ?? null, createdAt: r.created_at, restocked: r.restocked,
    items: r.return_items.map((i: Row) => { const line = lines.find(l => l.id === i.order_item_id); return { orderItemId: i.order_item_id, name: line?.name ?? 'Item', size: line?.size ?? '', quantity: i.quantity }; }),
    refund: toRefund(refund),
  };
}

export { trackingUrl };

/** Rows from ORDER_SELECT → full customer/admin order DTOs (cancellation, returns, refunds, deadlines). */
export async function presentOrders(rows: Row[]): Promise<Order[]> {
  const settings = await getSettingsRow();
  return attachReturns(rows.map(toOrder), rows, Number(settings.return_window_days ?? 7));
}
