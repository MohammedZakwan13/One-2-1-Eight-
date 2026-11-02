'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, Filter, X } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { ImageUploader } from '@/components/admin/image-uploader';
import { SmartImage } from '@/components/ui/smart-image';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Category } from '@/lib/api/schemas';

export function AdminCollections() {
  const { notify } = useUi();
  const confirm = useConfirm();
  const client = useQueryClient();
  const categoriesQuery = useQuery({ queryKey: ['admin', 'categories'], queryFn: () => api.admin.categories.list() });
  const productsQuery = useQuery({ queryKey: ['admin', 'products'], queryFn: () => api.admin.products.list() });
  const categories = categoriesQuery.data?.items ?? [];
  const products = productsQuery.data?.items ?? [];
  const [draft, setDraft] = useState<Category | null>(null);

  const updateCategory = useMutation({
    mutationFn: (category: Category) => api.admin.categories.update(category.id, { name: category.name, image: category.image, active: category.active }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'categories'] }),
    onError: failure => notify(errorMessage(failure)),
  });
  const createCategory = useMutation({
    mutationFn: (category: Category) => api.admin.categories.create({ name: category.name.trim(), slug: category.slug.trim() || undefined, image: category.image, active: category.active }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'categories'] }),
  });
  const [createError, setCreateError] = useState('');
  const clearLuxe = useMutation({
    mutationFn: () => api.admin.products.bulkFlag('luxe', false),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['admin', 'products'] }); notify('Luxe flags cleared.'); },
    onError: failure => notify(errorMessage(failure)),
  });
  const deleteCategory = useMutation({
    mutationFn: (id: string) => api.admin.categories.remove(id),
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey: ['admin', 'categories'] }); notify('Category deleted.'); },
  });
  const askDelete = (category: Category) => confirm({
    title: 'Delete category?',
    message: <>Are you sure you want to delete “{category.name}”? Its products are never deleted: if any still use this category, or a banner links to it, the deletion is refused until you move them. This action cannot be undone.</>,
    confirmLabel: 'Delete category', onConfirm: () => deleteCategory.mutateAsync(category.id),
  });
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (!draft.id) {
      if (createCategory.isPending) return;
      setCreateError('');
      if (!draft.image) { setCreateError('Add a category image before saving.'); return; }
      createCategory.mutate(draft, { onSuccess: created => { setDraft(null); notify(`Category “${created.name}” created${created.active ? ' and live in the storefront' : ' (hidden)'}.`); }, onError: failure => setCreateError(errorMessage(failure)) });
      return;
    }
    updateCategory.mutate(draft, { onSuccess: () => { setDraft(null); notify('Category saved — storefront updated.'); } });
  };

  return <AdminDataState isLoading={categoriesQuery.isLoading || productsQuery.isLoading} error={categoriesQuery.error ?? productsQuery.error} retry={() => { void categoriesQuery.refetch(); void productsQuery.refetch(); }}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">MERCHANDISING / NAVIGATION</span><h1>Categories & edits</h1><p>Manage the category tiles and curated collections displayed to shoppers.</p></div><div className="admin-page-actions"><button className="admin-primary-btn" type="button" onClick={() => { setCreateError(''); setDraft({ id: '', name: '', slug: '', image: '', active: true }); }}>+ Add category</button><button className="admin-secondary-btn" disabled={clearLuxe.isPending} onClick={() => confirm({ title: 'Clear Luxe flags?', message: 'This removes the Luxe flag from every product. Products stay published.', confirmLabel: 'Clear flags', onConfirm: () => clearLuxe.mutateAsync() })}>CLEAR LUXE FLAGS</button></div></div><div className="admin-category-manager"><section className="admin-card admin-category-list"><div className="admin-card-heading"><div><span className="eyebrow">SHOP BY CATEGORY</span><h2>Category tiles</h2></div><span className="admin-count-chip">{categories.length}</span></div><div className="admin-category-rows">{categories.map(category => <div className="admin-category-row" key={category.id}><SmartImage src={category.image} alt={category.name} /><div><strong>{category.name}</strong><small>/collections/{category.slug}</small></div><label className="admin-toggle"><input type="checkbox" checked={category.active} disabled={updateCategory.isPending} onChange={e => updateCategory.mutate({ ...category, active: e.target.checked })} /><span /><em>{category.active ? 'LIVE' : 'HIDDEN'}</em></label><button className="admin-icon-btn" onClick={() => { setCreateError(''); setDraft({ ...category }); }} aria-label={`Edit ${category.name}`}><ArrowUpRight size={16} /></button></div>)}</div></section><section className="admin-card admin-edit-category"><div className="admin-card-heading"><div><span className="eyebrow">{draft && !draft.id ? 'NEW CATEGORY' : 'CATEGORY EDITOR'}</span><h2>{draft ? (draft.id ? `Edit ${draft.name}` : 'Add a category') : 'Select a tile'}</h2></div>{draft && <button className="admin-icon-btn" onClick={() => setDraft(null)} aria-label={draft?.id ? 'Cancel edit' : 'Cancel new category'}><X size={17} /></button>}</div>{draft ? <form className="admin-edit-form" onSubmit={save}><label>Category name<input value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })} required /></label>{!draft.id && <label>URL name (optional)<input value={draft.slug} maxLength={60} placeholder={`/collections/${draft.name ? draft.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'your-category'}`} onChange={e => setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /><small>Lower-case letters, numbers and hyphens. Leave empty to use the name. It cannot be changed later.</small></label>}<ImageUploader label="Category image" max={1} images={draft.image ? [draft.image] : []} onChange={images => setDraft({ ...draft, image: images[0] ?? '' })} hint="Portrait crop works best. JPEG, PNG, WebP or AVIF · up to 4 MB." /><label className="admin-checkbox-line"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Visible in storefront</label>{createError && <p className="form-error-banner" role="alert">{createError}</p>}<div className="admin-form-actions"><button className="admin-primary-btn" type="submit" disabled={updateCategory.isPending || createCategory.isPending}><Check size={15} /> {draft.id ? 'Save category' : createCategory.isPending ? 'Creating…' : 'Create category'}</button>{draft.id ? <button type="button" className="admin-danger-btn" onClick={() => askDelete(draft)}>Delete category</button> : <button type="button" className="admin-secondary-btn" onClick={() => setDraft(null)}>Cancel</button>}</div></form> : <div className="admin-editor-empty"><Filter size={28} /><h3>Choose a category</h3><p>Change the tile name, image or storefront visibility. The URL stays stable when a category is renamed.</p></div>}</section></div><section className="admin-card collection-flags-card"><div className="admin-card-heading"><div><span className="eyebrow">CURATED EDITS</span><h2>Collection status</h2><p>Products enter these collections when their merchandising flags are enabled in the Product editor.</p></div></div><div className="collection-status-grid">{[{ title: 'Best sellers', key: 'bestSeller' as const }, { title: 'New arrivals', key: 'newArrival' as const }, { title: 'One 2 1 Eight Luxe', key: 'luxe' as const }].map(item => <div key={item.key}><strong>{item.title}</strong><b>{products.filter(p => p[item.key]).length.toString().padStart(2, '0')}</b><span>active pieces</span><small>{item.key === 'luxe' ? 'Premium capsule' : item.key === 'newArrival' ? 'Latest drops' : 'Top rotation'}</small></div>)}</div></section></div>
  </AdminDataState>;
}
