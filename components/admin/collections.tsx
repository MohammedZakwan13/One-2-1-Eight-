'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, Filter, X } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { SmartImage } from '@/components/ui/smart-image';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Category } from '@/lib/api/schemas';

export function AdminCollections() {
  const { notify } = useUi();
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
  const clearLuxe = useMutation({
    mutationFn: () => api.admin.products.bulkFlag('luxe', false),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['admin', 'products'] }); notify('Luxe flags cleared.'); },
    onError: failure => notify(errorMessage(failure)),
  });
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    updateCategory.mutate(draft, { onSuccess: () => { setDraft(null); notify('Category saved — storefront updated.'); } });
  };

  return <AdminDataState isLoading={categoriesQuery.isLoading || productsQuery.isLoading} error={categoriesQuery.error ?? productsQuery.error} retry={() => { void categoriesQuery.refetch(); void productsQuery.refetch(); }}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">MERCHANDISING / NAVIGATION</span><h1>Categories & edits</h1><p>Manage the category tiles and curated collections displayed to shoppers.</p></div><button className="admin-secondary-btn" disabled={clearLuxe.isPending} onClick={() => { if (window.confirm('Remove the Luxe flag from every product?')) clearLuxe.mutate(); }}>CLEAR LUXE FLAGS</button></div><div className="admin-category-manager"><section className="admin-card admin-category-list"><div className="admin-card-heading"><div><span className="eyebrow">SHOP BY CATEGORY</span><h2>Category tiles</h2></div><span className="admin-count-chip">{categories.length}</span></div><div className="admin-category-rows">{categories.map(category => <div className="admin-category-row" key={category.id}><SmartImage src={category.image} alt={category.name} /><div><strong>{category.name}</strong><small>/collections/{category.slug}</small></div><label className="admin-toggle"><input type="checkbox" checked={category.active} disabled={updateCategory.isPending} onChange={e => updateCategory.mutate({ ...category, active: e.target.checked })} /><span /><em>{category.active ? 'LIVE' : 'HIDDEN'}</em></label><button className="admin-icon-btn" onClick={() => setDraft({ ...category })} aria-label={`Edit ${category.name}`}><ArrowUpRight size={16} /></button></div>)}</div></section><section className="admin-card admin-edit-category"><div className="admin-card-heading"><div><span className="eyebrow">CATEGORY EDITOR</span><h2>{draft ? `Edit ${draft.name}` : 'Select a tile'}</h2></div>{draft && <button className="admin-icon-btn" onClick={() => setDraft(null)} aria-label="Cancel edit"><X size={17} /></button>}</div>{draft ? <form className="admin-edit-form" onSubmit={save}><label>Category name<input value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })} required /></label><label>Category image URL<input value={draft.image} onChange={e => setDraft({ ...draft, image: e.target.value })} required /></label><div className="admin-category-preview"><SmartImage src={draft.image} alt={draft.name} /><span>Tile preview / portrait crop</span></div><label className="admin-checkbox-line"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Visible in storefront</label><button className="admin-primary-btn" type="submit" disabled={updateCategory.isPending}><Check size={15} /> Save category</button></form> : <div className="admin-editor-empty"><Filter size={28} /><h3>Choose a category</h3><p>Change the tile name, image or storefront visibility. The URL stays stable when a category is renamed.</p></div>}</section></div><section className="admin-card collection-flags-card"><div className="admin-card-heading"><div><span className="eyebrow">CURATED EDITS</span><h2>Collection status</h2><p>Products enter these collections when their merchandising flags are enabled in the Product editor.</p></div></div><div className="collection-status-grid">{[{ title: 'Best sellers', key: 'bestSeller' as const }, { title: 'New arrivals', key: 'newArrival' as const }, { title: 'One 2 1 Eight Luxe', key: 'luxe' as const }].map(item => <div key={item.key}><strong>{item.title}</strong><b>{products.filter(p => p[item.key]).length.toString().padStart(2, '0')}</b><span>active pieces</span><small>{item.key === 'luxe' ? 'Premium capsule' : item.key === 'newArrival' ? 'Latest drops' : 'Top rotation'}</small></div>)}</div></section></div>
  </AdminDataState>;
}
