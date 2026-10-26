import type { Caller } from '@/lib/api/http';
import {
  adminCategoriesSchema, adminContentSchema, adminLeadListSchema, adminLeadSchema, adminLoginResponseSchema, adminMeSchema,
  adminOrderListSchema, adminProductListSchema, adminProductSchema, adminReviewListSchema, adminReviewSchema,
  dashboardSummarySchema, heroSlideSchema, orderSchema, storeSettingsSchema, categorySchema,
  type AdminProductInput, type StoreSettings, type HeroSlide,
} from '@/lib/api/schemas';

const ADMIN_PAGE = { page: 1, pageSize: 200 };

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
    update: (id: string, input: { name: string; image: string; active: boolean }) => call(`/admin/categories/${encodeURIComponent(id)}`, categorySchema, { method: 'PUT', body: input }),
  },
  orders: {
    list: () => call('/admin/orders', adminOrderListSchema, { query: ADMIN_PAGE }),
    updateStatus: (id: string, status: string) => call(`/admin/orders/${encodeURIComponent(id)}/status`, orderSchema, { method: 'PATCH', body: { status } }),
    exportUrl: '/api/v1/admin/orders/export.csv',
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
  },
});
