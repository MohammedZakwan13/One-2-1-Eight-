export type PageItem = number | 'gap-left' | 'gap-right';

/** Page numbers with ellipses: always first, last and a window around the current page. */
export function pageWindow(page: number, pages: number): PageItem[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: PageItem[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) out.push('gap-left');
  for (let n = start; n <= end; n += 1) out.push(n);
  if (end < pages - 1) out.push('gap-right');
  out.push(pages);
  return out;
}
