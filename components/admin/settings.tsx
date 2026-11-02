'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { LegalPagesEditor } from '@/components/admin/legal-pages';
import { storeSettingsSchema, type StoreSettings } from '@/lib/api/schemas';

export function AdminSettings() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'content'], queryFn: () => api.admin.content.get() });
  const [draft, setDraft] = useState<StoreSettings | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => { if (query.data) setDraft({ ...query.data.settings }); }, [query.data]);
  const save = useMutation({
    mutationFn: (settings: StoreSettings) => api.admin.content.updateSettings(settings),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['admin', 'content'] }); notify('Store settings saved.'); },
    onError: failure => setErrors([errorMessage(failure)]),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const parsed = storeSettingsSchema.safeParse({ ...draft, productOfferCode: draft.productOfferCode || null, productOfferText: draft.productOfferText || null, instagramUrl: draft.instagramUrl || null, whatsappNumber: draft.whatsappNumber || null });
    if (!parsed.success) { setErrors(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return; }
    setErrors([]);
    save.mutate(parsed.data);
  };
  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>{draft && <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">CONFIGURATION / SEARCH VISIBILITY</span><h1>Store & SEO</h1><p>Update brand details, service policy and search metadata. Legal pages (terms, privacy) are edited below.</p></div><span className="admin-save-state"><CheckCircle2 size={15} /> Saved by the server</span></div><form className="admin-settings-layout" onSubmit={submit}><section className="admin-card admin-settings-card"><div className="admin-card-heading"><div><span className="eyebrow">BRAND SYSTEM</span><h2>Store identity</h2><p>Used in page titles, footer details and the service messaging.</p></div><span className="settings-section-icon"><Sparkles size={18} /></span></div><label>Brand name<input value={draft.brandName} onChange={e => setDraft({ ...draft, brandName: e.target.value })} required maxLength={80} /></label><label>Brand line<input value={draft.brandLine} onChange={e => setDraft({ ...draft, brandLine: e.target.value })} maxLength={160} /></label><label>Customer care email<input type="email" value={draft.contactEmail} onChange={e => setDraft({ ...draft, contactEmail: e.target.value })} /></label><label>Customer care phone<input value={draft.contactPhone} onChange={e => setDraft({ ...draft, contactPhone: e.target.value })} /></label><label>WhatsApp number (digits, with country code)<input value={draft.whatsappNumber ?? ''} onChange={e => setDraft({ ...draft, whatsappNumber: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 919876543210" /></label><label>Instagram URL<input type="url" value={draft.instagramUrl ?? ''} onChange={e => setDraft({ ...draft, instagramUrl: e.target.value })} placeholder="https://www.instagram.com/your-handle" /></label><label>Free shipping threshold (₹)<input type="number" min="0" value={draft.freeShippingThreshold} onChange={e => setDraft({ ...draft, freeShippingThreshold: Number(e.target.value) })} /></label><label>Shipping fee below the threshold (₹)<input type="number" min="0" value={draft.shippingFee} onChange={e => setDraft({ ...draft, shippingFee: Number(e.target.value) })} /></label><label>Low-stock threshold (units per size)<input type="number" min="0" max="1000" step="1" value={draft.lowStockThreshold} onChange={e => setDraft({ ...draft, lowStockThreshold: Number(e.target.value) })} /><small>Sizes at or below this real quantity appear on the dashboard and as &ldquo;low stock&rdquo; in the storefront.</small></label><label>Product page offer code (optional)<input value={draft.productOfferCode ?? ''} maxLength={40} onChange={e => setDraft({ ...draft, productOfferCode: e.target.value.toUpperCase() })} placeholder="Must exist as a coupon in the backend" /></label><label>Product page offer text<input value={draft.productOfferText ?? ''} maxLength={160} onChange={e => setDraft({ ...draft, productOfferText: e.target.value })} /></label><label>Returns policy<textarea rows={4} maxLength={2000} value={draft.returnPolicy} onChange={e => setDraft({ ...draft, returnPolicy: e.target.value })} /></label></section><section className="admin-card admin-settings-card"><div className="admin-card-heading"><div><span className="eyebrow">SEO / GEO / AI DISCOVERY</span><h2>Search metadata</h2><p>Readable, specific metadata helps search engines and answer systems understand your offer.</p></div><span className="settings-section-icon"><Search size={18} /></span></div><label>Site title<input value={draft.seoTitle} maxLength={120} onChange={e => setDraft({ ...draft, seoTitle: e.target.value })} /><small>Use the brand plus a clear product/category description.</small></label><label>Meta description<textarea rows={4} maxLength={320} value={draft.seoDescription} onChange={e => setDraft({ ...draft, seoDescription: e.target.value })} /><small>{draft.seoDescription.length}/320 characters</small></label><div className="seo-preview"><span className="eyebrow">SEARCH PREVIEW</span><strong>{draft.seoTitle}</strong><span>{typeof window === 'undefined' ? '' : window.location.origin}/</span><p>{draft.seoDescription}</p></div></section><div className="admin-settings-bottom"><p><ShieldCheck size={14} /> Changes are validated and saved by the server; the storefront reflects them after its cache refreshes.</p><button className="admin-primary-btn" type="submit" disabled={save.isPending}><Check size={15} /> {save.isPending ? 'Saving…' : 'Save store settings'}</button></div>{errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}</div>}</form><LegalPagesEditor /></div>}</AdminDataState>;
}
