import type { Caller } from '@/lib/api/http';
import { isApiError } from '@/lib/api/errors';
import { legalPageSchema, leadResponseSchema, newsletterResponseSchema, storefrontContentSchema, type LeadRequest } from '@/lib/api/schemas';

export const contentRepository = (call: Caller) => ({
  storefront: () => call('/content/storefront', storefrontContentSchema, { revalidate: 300, tags: ['content'] }),
  /** Returns null when the page has not been published yet (e.g. terms, privacy). */
  async page(slug: string) {
    try {
      return await call(`/content/pages/${encodeURIComponent(slug)}`, legalPageSchema, { revalidate: 3600, tags: ['content', `page:${slug}`] });
    } catch (error) {
      if (isApiError(error) && error.status === 404) return null;
      throw error;
    }
  },
  subscribeNewsletter: (email: string) =>
    call('/newsletter/subscriptions', newsletterResponseSchema, { method: 'POST', body: { email, consent: true } }),
  submitLead: (lead: LeadRequest) => call('/leads', leadResponseSchema, { method: 'POST', body: lead }),
});
