'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { Cart } from '@/lib/api/schemas';

export const CART_KEY = ['cart'] as const;

/**
 * Server-owned cart. All prices, discounts, shipping and totals come from the API response;
 * the browser never computes them.
 */
export function useCart() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: CART_KEY, queryFn: ({ signal }) => api.cart.get(signal) });
  const store = (cart: Cart) => client.setQueryData(CART_KEY, cart);

  const addItem = useMutation({ mutationFn: (input: { variantId: string; quantity?: number }) => api.cart.addItem(input.variantId, input.quantity ?? 1), onSuccess: store });
  const updateItem = useMutation({ mutationFn: (input: { lineId: string; quantity: number }) => api.cart.updateItem(input.lineId, input.quantity), onSuccess: store });
  const removeItem = useMutation({ mutationFn: (lineId: string) => api.cart.removeItem(lineId), onSuccess: store });
  const applyCoupon = useMutation({ mutationFn: (code: string) => api.cart.applyCoupon(code), onSuccess: store });
  const removeCoupon = useMutation({ mutationFn: () => api.cart.removeCoupon(), onSuccess: store });

  const cart = query.data ?? null;
  const count = cart ? cart.lines.reduce((sum, line) => sum + (line.issue === 'out_of_stock' ? 0 : line.quantity), 0) : 0;
  return {
    cart, count, isLoading: query.isLoading, isError: query.isError, error: query.error, refetch: query.refetch,
    addItem, updateItem, removeItem, applyCoupon, removeCoupon,
    /** Called after a successful order so the badge and bag empty out. */
    invalidate: () => client.invalidateQueries({ queryKey: CART_KEY }),
  };
}
