'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState, titleCase } from '@/components/admin/data-state';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { slugify } from '@/lib/format';

export function AdminReviews() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'reviews'], queryFn: () => api.admin.reviews.list() });
  const reviews = query.data?.items ?? [];
  const moderate = useMutation({
    mutationFn: (input: { id: string; status: 'pending' | 'published' | 'hidden' }) => api.admin.reviews.updateStatus(input.id, input.status),
    onSuccess: async (_review, input) => { await Promise.all([client.invalidateQueries({ queryKey: ['admin', 'reviews'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] })]); notify(`Review status updated to ${input.status}.`); },
    onError: failure => notify(errorMessage(failure)),
  });
  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">CUSTOMER VOICE / TRUST</span><h1>Reviews <span className="admin-count-chip">{reviews.length}</span></h1><p>Moderate what customers see. Only published reviews appear on the storefront and in search results.</p></div></div><section className="admin-card admin-reviews-card"><div className="admin-card-heading"><div><span className="eyebrow">MODERATION QUEUE</span><h2>Customer feedback</h2></div><div className="review-admin-stats"><span>{reviews.filter(r => r.status === 'published').length} published</span><span>{reviews.filter(r => r.status === 'pending').length} pending</span></div></div><div className="admin-review-list">{reviews.map(review => <article key={review.id} className="admin-review-row"><div className="admin-review-avatar">{review.author.charAt(0)}</div><div className="admin-review-copy"><div><strong>{review.author}</strong><span>{review.createdAt.slice(0, 10)}{review.verifiedPurchase ? ' · Verified purchase' : ''}</span></div><span className="admin-review-product">{review.productName}</span><span className="admin-review-stars">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span><p>{review.title ? <strong>{review.title}. </strong> : null}{review.body}</p></div><div className="admin-review-actions"><span className={`status-pill status-${slugify(review.status)}`}>{titleCase(review.status)}</span><select aria-label={`Moderate review by ${review.author}`} value={review.status} disabled={moderate.isPending} onChange={e => moderate.mutate({ id: review.id, status: e.target.value as 'pending' | 'published' | 'hidden' })}><option value="pending">Pending</option><option value="published">Published</option><option value="hidden">Hidden</option></select></div></article>)}</div>{!reviews.length && <div className="admin-table-empty">No reviews yet.</div>}</section><div className="admin-callout"><Star size={18} /><p><strong>Trust note:</strong> verified-purchase labels are set by the server from order data. Never publish reviews you cannot attribute to a real customer.</p></div></div>
  </AdminDataState>;
}
