import type { z } from 'zod';
import { ApiError, errorFromResponse } from '@/lib/api/errors';
import type { Caller } from '@/lib/api/http';
import {
  adminCategoriesSchema, adminContentSchema, adminLeadListSchema, adminLeadSchema, adminLoginResponseSchema, adminMeSchema,
  adminOrderListSchema, adminPageListSchema, adminPageSchema, adminProductListSchema, adminProductSchema, adminReviewListSchema, adminReviewSchema,
  apiErrorBodySchema, dashboardSummarySchema, heroSlideSchema, orderSchema, storeSettingsSchema, categorySchema, uploadResponseSchema,
  type AdminProductInput, type StoreSettings, type HeroSlide, type UpdateOrderStatus,
  returnListSchema, returnSchema, type UpdateReturn,
} from '@/lib/api/schemas';

const ADMIN_PAGE = { page: 1, pageSize: 200 };

type UploadResult = z.infer<typeof uploadResponseSchema>;

/** Multipart upload via XHR so the UI can show real progress. CSRF token is fetched from the same-origin API. */
async function uploadImage(file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  const csrf = await fetch('/api/v1/csrf-token', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json() as Promise<{ token: string }>);
  return new Promise<UploadResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v1/admin/uploads');
    request.setRequestHeader('X-CSRF-Token', csrf.token);
    request.setRequestHeader('Accept', 'application/json');
    request.withCredentials = true;
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100)); };
    request.onerror = () => reject(new ApiError(503, 'network_error', 'We could not reach the server. Check your connection and try again.'));
    request.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    request.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(request.responseText); } catch { /* non-JSON error body */ }
      if (request.status >= 200 && request.status < 300) {
        const parsed = uploadResponseSchema.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError(502, 'invalid_response', 'We received an unexpected response from the server.'));
      } else {
        const parsed = apiErrorBodySchema.safeParse(body);
        reject(errorFromResponse(request.status, parsed.success ? parsed.data : null));
      }
    };
    signal?.addEventListener('abort', () => request.abort());
    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

/** Everything under `/admin/*` requires a server-validated admin session (HttpOnly cookie) plus a CSRF token on writes. */
export const adminRepository = (call: Caller) => ({
  auth: {
    login: (email: string, password: string) => call('/admin/auth/login', adminLoginResponseSchema, { method: 'POST', body: { email, password } }),
    verifyMfa: (code: string) => call('/admin/auth/mfa', adminMeSchema, { method: 'POST', body: { code } }),
    logout: () => call('/admin/auth/logout', null, { method: 'POST' }),
    me: (options: { forwardCookies?: boolean } = {}) => call('/admin/auth/me', adminMeSchema, { retries: 0, forwardCookies: options.forwardCookies, revalidate: false }),
  },
  dashboard: () => call('/admin/dashboard/summary', dashboardSummarySchema),
  products: {
    list: () => call('/admin/products', adminProductListSchema, { query: ADMIN_PAGE }),
    create: (input: AdminProductInput) => call('/admin/products', adminProductSchema, { method: 'POST', body: input }),
    update: (id: string, input: AdminProductInput) => call(`/admin/products/${encodeURIComponent(id)}`, adminProductSchema, { method: 'PUT', body: input }),
    remove: (id: string) => call(`/admin/products/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    bulkFlag: (flag: 'luxe' | 'bestSeller' | 'newArrival', value: boolean) => call('/admin/products/bulk-flags', null, { method: 'POST', body: { flag, value } }),
  },
  categories: {
    list: () => call('/admin/categories', adminCategoriesSchema),
    create: (input: { name: string; slug?: string; image: string; active: boolean }) => call('/admin/categories', categorySchema, { method: 'POST', body: input }),
    remove: (id: string) => call(`/admin/categories/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    update: (id: string, input: { name: string; image: string; active: boolean }) => call(`/admin/categories/${encodeURIComponent(id)}`, categorySchema, { method: 'PUT', body: input }),
  },
  orders: {
    list: () => call('/admin/orders', adminOrderListSchema, { query: ADMIN_PAGE }),
    updateStatus: (id: string, update: UpdateOrderStatus) => call(`/admin/orders/${encodeURIComponent(id)}/status`, orderSchema, { method: 'PATCH', body: update }),
    exportUrl: '/api/v1/admin/orders/export.csv',
    listReturns: () => call('/admin/returns', returnListSchema, { query: ADMIN_PAGE }),
    updateReturn: (id: string, update: UpdateReturn) => call(`/admin/returns/${encodeURIComponent(id)}`, returnSchema, { method: 'PATCH', body: update }),
  },
  reviews: {
    list: () => call('/admin/reviews', adminReviewListSchema, { query: ADMIN_PAGE }),
    updateStatus: (id: string, status: 'pending' | 'published' | 'hidden') => call(`/admin/reviews/${encodeURIComponent(id)}`, adminReviewSchema, { method: 'PATCH', body: { status } }),
  },
  leads: {
    list: () => call('/admin/leads', adminLeadListSchema, { query: ADMIN_PAGE }),
    updateStatus: (id: string, status: 'new' | 'contacted' | 'qualified' | 'closed') => call(`/admin/leads/${encodeURIComponent(id)}`, adminLeadSchema, { method: 'PATCH', body: { status } }),
    exportUrl: '/api/v1/admin/leads/export.csv',
  },
  content: {
    get: () => call('/admin/content', adminContentSchema),
    updateSettings: (settings: StoreSettings) => call('/admin/content/settings', storeSettingsSchema, { method: 'PUT', body: settings }),
    updateHeroSlide: (id: string, slide: Omit<HeroSlide, 'id'>) => call(`/admin/content/hero-slides/${encodeURIComponent(id)}`, heroSlideSchema, { method: 'PUT', body: slide }),
    pages: () => call('/admin/pages', adminPageListSchema),
    savePage: (slug: string, page: { title: string; body: string; published: boolean }) => call(`/admin/pages/${encodeURIComponent(slug)}`, adminPageSchema, { method: 'PUT', body: page }),
    removePage: (slug: string) => call(`/admin/pages/${encodeURIComponent(slug)}`, null, { method: 'DELETE' }),
  },
  uploads: {
    upload: uploadImage,
    remove: (path: string) => call('/admin/uploads', null, { method: 'DELETE', query: { path } }),
    cleanup: () => call('/admin/uploads/cleanup', null, { method: 'POST' }),
  },
});
