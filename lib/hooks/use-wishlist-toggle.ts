'use client';

import { useCallback } from 'react';
import { useUi } from '@/components/providers/app-providers';
import { useWishlist } from '@/lib/hooks/use-wishlist';

/** Wishlist state plus the toast-emitting toggle used by every product grid/card. */
export function useWishlistToggle() {
  const { ids, toggle } = useWishlist();
  const { notify } = useUi();
  const onToggleWishlist = useCallback((id: string, name?: string) => {
    const alreadySaved = ids.includes(id);
    toggle(id);
    notify(alreadySaved ? 'Removed from your wishlist.' : `${name || 'Piece'} saved for later.`);
  }, [ids, toggle, notify]);
  return { wishlist: ids, onToggleWishlist };
}
