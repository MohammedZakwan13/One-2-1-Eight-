'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isUnauthorized } from '@/lib/api/errors';
import type { Customer } from '@/lib/api/schemas';

export const CUSTOMER_KEY = ['customer'] as const;

/** `customer` is null when signed out (401); any other failure surfaces as `error`. */
export function useCustomer() {
  const client = useQueryClient();
  const query = useQuery<Customer | null>({
    queryKey: CUSTOMER_KEY,
    queryFn: async ({ signal }) => {
      try { return await api.auth.me(signal); } catch (error) { if (isUnauthorized(error)) return null; throw error; }
    },
    staleTime: 60_000,
  });
  return {
    customer: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    setCustomer: (customer: Customer | null) => client.setQueryData(CUSTOMER_KEY, customer),
  };
}
