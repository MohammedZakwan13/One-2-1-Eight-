'use client';

import { useEffect, useState } from 'react';
import { pageWindow } from '@/lib/pagination';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export const PAGE_SIZES = [25, 50, 100] as const;

/** Debounces a fast-changing value (search box) so the server is queried once typing pauses. */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const id = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(id); }, [value, delay]);
  return debounced;
}

type Props = { page: number; pageSize: number; total: number; onPage: (page: number) => void; onPageSize?: (size: number) => void; noun: string; busy?: boolean };

/** Server-side pagination footer: range summary, optional page-size picker and page navigation. */
export function Pagination({ page, pageSize, total, onPage, onPageSize, noun, busy }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // If the list shrinks (filter, status change) while on a later page, move back to the last real page.
  useEffect(() => { if (page > pages) onPage(pages); }, [page, pages, onPage]);
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const go = (next: number) => onPage(Math.min(pages, Math.max(1, next)));
  return <nav className="admin-pagination" aria-label={`${noun} pagination`} aria-busy={busy}>
    <p className="admin-pagination-summary" aria-live="polite">Showing <strong>{from}–{to}</strong> of <strong>{total}</strong> {noun}</p>
    {onPageSize && <label className="admin-pagination-size">Rows<select value={pageSize} onChange={e => onPageSize(Number(e.target.value))} aria-label={`${noun} per page`}>{PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
    {pages > 1 && <div className="admin-pagination-pages">
      <button type="button" onClick={() => go(1)} disabled={page <= 1} aria-label="First page"><ChevronsLeft size={15} /></button>
      <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={15} /></button>
      {pageWindow(page, pages).map(item => (typeof item === 'number'
        ? <button type="button" key={item} className={item === page ? 'active' : ''} aria-current={item === page ? 'page' : undefined} onClick={() => go(item)}>{item}</button>
        : <span key={item} className="admin-pagination-gap" aria-hidden="true">…</span>))}
      <button type="button" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page"><ChevronRight size={15} /></button>
      <button type="button" onClick={() => go(pages)} disabled={page >= pages} aria-label="Last page"><ChevronsRight size={15} /></button>
    </div>}
  </nav>;
}
