'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Wishlist. Guests keep it in localStorage (a non-sensitive preference); signed-in customers are synced to the server (see use-wishlist-toggle).
 * (cart, orders and anything price-related are server-owned). Hydration-safe via useSyncExternalStore.
 */
const KEY = 'o218:wishlist:v1';
const EMPTY: string[] = [];
let cache: { raw: string | null; ids: string[] } = { raw: null, ids: EMPTY };
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === cache.raw) return cache.ids;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 200) : EMPTY;
    cache = { raw, ids: ids.length ? ids : EMPTY };
    return cache.ids;
  } catch {
    return EMPTY;
  }
}

function write(ids: string[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* storage unavailable (private mode) – keep in memory only */ }
  cache = { raw: JSON.stringify(ids), ids: ids.length ? ids : EMPTY };
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function useWishlist() {
  const ids = useSyncExternalStore(subscribe, read, () => EMPTY);
  const toggle = useCallback((id: string) => {
    const current = read();
    write(current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }, []);
  const clear = useCallback(() => write([]), []);
  const replace = useCallback((next: string[]) => write(next.slice(0, 200)), []);
  return { ids, toggle, clear, replace };
}
