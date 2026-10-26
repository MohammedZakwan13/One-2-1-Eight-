import type { Caller } from '@/lib/api/http';
import { createReviewResponseSchema, reviewListSchema, type CreateReviewRequest } from '@/lib/api/schemas';

export const reviewsRepository = (call: Caller) => ({
  list: (slug: string, signal?: AbortSignal) =>
    call(`/products/${encodeURIComponent(slug)}/reviews`, reviewListSchema, { revalidate: 60, tags: [`reviews:${slug}`], signal }),
  /** Requires a signed-in customer. The server decides moderation status and verified-purchase labelling. */
  create: (slug: string, request: CreateReviewRequest) =>
    call(`/products/${encodeURIComponent(slug)}/reviews`, createReviewResponseSchema, { method: 'POST', body: request }),
});
