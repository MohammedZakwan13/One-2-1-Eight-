'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useUi } from '@/components/providers/app-providers';
import { api } from '@/lib/api/client';
import { useCustomer } from '@/lib/hooks/use-customer';
import { useWishlist } from '@/lib/hooks/use-wishlist';

/** Wishlist state plus the toast-emitting toggle used by every product grid/card. Signed-in customers are persisted server-side. */
export function useWishlistToggle() {
  const { ids, toggle, replace } = useWishlist();
  const { customer } = useCustomer();
  const { notify } = useUi();
  const syncedFor = useRef<string | null>(null);

  // On sign-in, merge the guest list with the saved one and push anything new to the server.
  useEffect(() => {
    if (!customer || syncedFor.current === customer.id) return;
    syncedFor.current = customer.id;
    void (async () => {
      try {
        const saved = (await api.wishlist.list()).productIds;
        await Promise.all(ids.filter(id => !saved.includes(id)).map(id => api.wishlist.add(id).catch(() => undefined)));
        replace([...new Set([...saved, ...ids])]);
      } catch { /* keep the local list if the server is unreachable */ }
    })();
  }, [customer, ids, replace]);

  const onToggleWishlist = useCallback((id: string, name?: string) => {
    const alreadySaved = ids.includes(id);
    toggle(id);
    if (customer) void (alreadySaved ? api.wishlist.remove(id) : api.wishlist.add(id)).catch(() => notify('Could not save your wishlist change. Please try again.'));
    notify(alreadySaved ? 'Removed from your wishlist.' : `${name || 'Piece'} saved for later.`);
  }, [ids, toggle, notify, customer]);
  return { wishlist: ids, onToggleWishlist };
}
