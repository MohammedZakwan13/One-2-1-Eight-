import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pageWindow } from '@/lib/pagination';
import { buildPath } from '@/lib/api/http';

describe('pageWindow', () => {
  it('shows every page when there are few', () => { expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]); });
  it('collapses long ranges with ellipses around the current page', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 'gap-right', 20]);
    expect(pageWindow(10, 20)).toEqual([1, 'gap-left', 9, 10, 11, 'gap-right', 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap-left', 19, 20]);
  });
  it('handles 500+ records at 25 per page', () => { expect(pageWindow(1, Math.ceil(537 / 25))).toEqual([1, 2, 'gap-right', 22]); });
});

describe('admin lists page on the server', () => {
  const repo = readFileSync('lib/api/repositories/admin.ts', 'utf8');
  it('orders, returns, reviews and leads send page, pageSize and filters', () => {
    expect(repo).toMatch(/orders: \{\s*list: \(params\?: ListParams\)/);
    expect(repo).toMatch(/leads: \{\s*list: \(params\?: ListParams\)/);
    expect(buildPath('/admin/orders', { page: 3, pageSize: 25, q: undefined, status: 'shipped' })).toBe('/admin/orders?page=3&pageSize=25&status=shipped');
  });
  it('backend orders every paged list by a unique tie-breaker so pages never overlap', () => {
    const backend = readFileSync('lib/backend/routes/admin.ts', 'utf8');
    expect(backend.split(".order('created_at', { ascending: false }).order('id').range(").length - 1).toBeGreaterThanOrEqual(4); // orders, returns, reviews, leads
  });
  it('the Update dropdown is no longer forced to 8px', () => {
    expect(readFileSync('app/globals.css', 'utf8')).toMatch(/select\.admin-status-select[^{]*\{[^}]*height: 40px/);
  });
});
