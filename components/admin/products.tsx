'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Search, ShieldCheck, Shirt } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { ImageUploader } from '@/components/admin/image-uploader';
import { SmartImage } from '@/components/ui/smart-image';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { adminProductInputSchema, type AdminProduct, type AdminProductInput } from '@/lib/api/schemas';
import { money, slugify } from '@/lib/format';

const SIZE_OPTIONS = ['S', 'M', 'L', 'XL', 'XXL'];
const totalStock = (product: AdminProduct) => product.variants.reduce((sum, variant) => sum + variant.stock, 0);

type Draft = {
  id?: string; name: string; slug: string; categoryId: string; price: number; compareAt: number; color: string; colorHex: string; badge: string;
  images: string[]; stockMessage: string; returnable: boolean; exchangeable: boolean; codEnabled: boolean; onlinePaymentEnabled: boolean;
  fit: string; material: string; description: string; bestSeller: boolean; newArrival: boolean; luxe: boolean;
  status: 'active' | 'draft'; stock: Record<string, string>;
};

const fromProduct = (product: AdminProduct): Draft => ({
  id: product.id, name: product.name, slug: product.slug, categoryId: product.categoryId, price: product.price, compareAt: product.compareAt, color: product.color,
  colorHex: product.colorHex, badge: product.badge ?? '', images: product.images, stockMessage: product.stockMessage ?? '',
  returnable: product.returnable !== false,
  exchangeable: product.exchangeable !== false,
  codEnabled: product.codEnabled !== false,
  onlinePaymentEnabled: product.onlinePaymentEnabled !== false,
  fit: product.fit, material: product.material, description: product.description,
  bestSeller: product.bestSeller, newArrival: product.newArrival, luxe: product.luxe, status: product.status,
  stock: Object.fromEntries(SIZE_OPTIONS.map(size => [size, String(product.variants.find(variant => variant.size === size)?.stock ?? '')])),
});

export function AdminProducts() {
  const { notify } = useUi();
  const client = useQueryClient();
  const productsQuery = useQuery({ queryKey: ['admin', 'products'], queryFn: () => api.admin.products.list() });
  const categoriesQuery = useQuery({ queryKey: ['admin', 'categories'], queryFn: () => api.admin.categories.list() });
  const contentQuery = useQuery({ queryKey: ['admin', 'content'], queryFn: () => api.admin.content.get() });
  const lowAt = contentQuery.data?.settings.lowStockThreshold ?? 5;
  const products = useMemo(() => productsQuery.data?.items ?? [], [productsQuery.data]);
  const categories = categoriesQuery.data?.items ?? [];
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const selected = products.find(product => product.id === selectedId);

  useEffect(() => { if (!selectedId && !showForm && products[0]) setSelectedId(products[0].id); }, [products, selectedId, showForm]);
  useEffect(() => { if (selected && !showForm) setDraft(fromProduct(selected)); }, [selected, showForm]);

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['admin', 'products'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] })]);
  const saveMutation = useMutation({
    mutationFn: (input: { id?: string; body: AdminProductInput }) => (input.id ? api.admin.products.update(input.id, input.body) : api.admin.products.create(input.body)),
    onSuccess: async saved => { await refresh(); setSelectedId(saved.id); setShowForm(false); notify('Product saved — storefront updated.'); },
    onError: failure => setFormErrors([errorMessage(failure)]),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => api.admin.products.remove(id),
    onSuccess: async () => { await refresh(); setSelectedId(''); setDraft(null); notify('Product removed from the catalogue.'); },
    onError: failure => notify(errorMessage(failure)),
  });

  const filtered = products.filter(product => `${product.name} ${product.category} ${product.id}`.toLowerCase().includes(query.toLowerCase()));
  const startNew = () => {
    setShowForm(true); setSelectedId(''); setFormErrors([]);
    setDraft({ name: '', slug: '', categoryId: categories[0]?.id ?? '', price: 999, compareAt: 0, color: 'Black', colorHex: '#242424', badge: '', images: [], stockMessage: '', returnable: true, exchangeable: true, codEnabled: true, onlinePaymentEnabled: true, fit: 'Regular fit', material: '100% Cotton', description: '', bestSeller: false, newArrival: true, luxe: false, status: 'draft', stock: Object.fromEntries(SIZE_OPTIONS.map(size => [size, size === 'XXL' ? '' : '10'])) });
  };
  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => (current ? { ...current, [key]: value } : current));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saveMutation.isPending) return;
    if (!draft.codEnabled && !draft.onlinePaymentEnabled) {
      setFormErrors(['At least one payment method (Cash on Delivery or Online Payment) must be enabled.']);
      return;
    }
    const variants = SIZE_OPTIONS.filter(size => draft.stock[size] !== '').map(size => ({ size, stock: Number(draft.stock[size]) }));
    const parsed = adminProductInputSchema.safeParse({
      name: draft.name, slug: (draft.slug || slugify(draft.name)).trim(), categoryId: draft.categoryId, price: draft.price, compareAt: draft.compareAt, color: draft.color, colorHex: draft.colorHex,
      badge: draft.badge || null, images: draft.images, fit: draft.fit, material: draft.material, description: draft.description,
      bestSeller: draft.bestSeller, newArrival: draft.newArrival, luxe: draft.luxe, status: draft.status, stockMessage: draft.stockMessage,
      returnable: draft.returnable, exchangeable: draft.exchangeable, codEnabled: draft.codEnabled, onlinePaymentEnabled: draft.onlinePaymentEnabled,
      variants,
    });
    if (!parsed.success) { setFormErrors(parsed.error.issues.map(issue => `${issue.path.join('.') || 'form'}: ${issue.message}`)); return; }
    setFormErrors([]);
    saveMutation.mutate({ id: draft.id, body: parsed.data });
  };
  const confirm = useConfirm();
  const remove = () => {
    if (!selected) return;
    const target = selected;
    confirm({ title: 'Delete product?', message: <>Are you sure you want to delete “{target.name}”? This action cannot be undone.</>, confirmLabel: 'Delete product', onConfirm: () => removeMutation.mutateAsync(target.id) });
  };

  return <AdminDataState isLoading={productsQuery.isLoading || categoriesQuery.isLoading} error={productsQuery.error ?? categoriesQuery.error} retry={() => { void productsQuery.refetch(); void categoriesQuery.refetch(); }}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">MERCHANDISE / CATALOGUE</span><h1>Products <span className="admin-count-chip">{products.length}</span></h1><p>Manage product details, imagery, pricing, availability and merchandising flags.</p></div><button className="admin-primary-btn" onClick={startNew}><Plus size={16} /> Add product</button></div>
      <div className="admin-products-layout">
        <section className="admin-card admin-product-list-card"><div className="admin-list-toolbar"><div className="admin-input-icon"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search catalogue" aria-label="Search catalogue" /></div><span>{filtered.length} products</span></div><div className="admin-product-list">{filtered.map(product => <button key={product.id} className={`admin-product-list-row ${selectedId === product.id && !showForm ? 'active' : ''}`} onClick={() => { setShowForm(false); setFormErrors([]); setSelectedId(product.id); }}><SmartImage src={product.images[0]} alt={product.name} /><span><strong>{product.name}</strong><small>{product.category} · {product.color}{product.status === 'draft' ? ' · Draft' : ''}</small><em>{money(product.price)}</em></span><span className={`stock-indicator ${product.variants.some(variant => variant.stock <= lowAt) ? 'stock-low' : ''}`}>{totalStock(product)} in stock</span></button>)}</div></section>
        <section className="admin-card admin-product-editor"><div className="admin-card-heading"><div><span className="eyebrow">{showForm ? 'NEW PRODUCT' : 'PRODUCT EDITOR'}</span><h2>{showForm ? 'Create a piece' : selected?.name || 'Select a product'}</h2></div>{!showForm && selected && <button className="admin-danger-quiet" onClick={remove} disabled={removeMutation.isPending}>DELETE</button>}</div>
          {draft && (selected || showForm) ? <form onSubmit={save} className="admin-edit-form">
            <label>Product name<input required maxLength={200} value={draft.name} onChange={e => patch('name', e.target.value)} placeholder="Product name" /></label>
            <div className="admin-form-two"><label>URL slug<input value={draft.slug} onChange={e => patch('slug', e.target.value)} placeholder="auto-generated from the name" /></label><label>Category<select value={draft.categoryId} onChange={e => patch('categoryId', e.target.value)}>{categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select></label></div>
            <div className="admin-form-three"><label>Price (₹)<input type="number" min="0" step="1" value={draft.price} onChange={e => patch('price', Number(e.target.value))} /></label><label>Compare-at (₹)<input type="number" min="0" step="1" value={draft.compareAt} onChange={e => patch('compareAt', Number(e.target.value))} /></label><label>Status<select value={draft.status} onChange={e => patch('status', e.target.value as Draft['status'])}><option value="active">Active (visible)</option><option value="draft">Draft (hidden)</option></select></label></div>
            <fieldset className="admin-feature-flags admin-size-stock"><legend>Real stock by size (leave blank if the size is not offered)</legend>{SIZE_OPTIONS.map(size => <label key={size}>{size}<input type="number" min="0" step="1" value={draft.stock[size]} onChange={e => patch('stock', { ...draft.stock, [size]: e.target.value })} aria-label={`Stock for size ${size}`} /></label>)}</fieldset>
            <fieldset className="admin-feature-flags"><legend>Returns & Exchanges</legend>
              <label className="admin-check"><input type="checkbox" checked={draft.returnable} onChange={e => patch('returnable', e.target.checked)} /> Returnable product<small>When off, customers cannot request a return for this product. Orders already placed keep the setting that applied when they were bought.</small></label>
              <label className="admin-check"><input type="checkbox" checked={draft.exchangeable} onChange={e => patch('exchangeable', e.target.checked)} /> Exchangeable product<small>When off, customers cannot request a size or colour exchange for this product.</small></label>
            </fieldset>
            <fieldset className="admin-feature-flags"><legend>Payment Methods</legend>
              <label className="admin-check"><input type="checkbox" checked={draft.codEnabled} onChange={e => patch('codEnabled', e.target.checked)} /> Cash on Delivery (COD)<small>Allow customers to pay via Cash on Delivery for this product.</small></label>
              <label className="admin-check"><input type="checkbox" checked={draft.onlinePaymentEnabled} onChange={e => patch('onlinePaymentEnabled', e.target.checked)} /> Online Payment<small>Allow customers to pay via UPI, cards, and netbanking for this product.</small></label>
            </fieldset>
            <label>Stock message on the storefront<input maxLength={160} value={draft.stockMessage} onChange={e => patch('stockMessage', e.target.value)} placeholder="Enter the message customers should see on this product" /><small>Display text only, shown on the product page exactly as written. It never changes real stock, availability or low-stock alerts. Leave empty to show nothing.</small></label>
            <div className="admin-form-two"><label>Colour name<input value={draft.color} onChange={e => patch('color', e.target.value)} /></label><label>Colour swatch<input type="color" value={draft.colorHex} onChange={e => patch('colorHex', e.target.value)} /></label></div>
            <ImageUploader label="Product images" images={draft.images} onChange={images => patch('images', images)} hint="The first image is the primary image shown on cards. JPEG, PNG, WebP or AVIF · up to 4 MB each." />
            <label>Badge (optional)<input maxLength={40} value={draft.badge} onChange={e => patch('badge', e.target.value)} placeholder="e.g. NEW DROP" /></label>
            <label>Description<textarea rows={4} maxLength={5000} value={draft.description} onChange={e => patch('description', e.target.value)} placeholder="Product description" /></label>
            <div className="admin-form-two"><label>Fit<input value={draft.fit} onChange={e => patch('fit', e.target.value)} /></label><label>Material<input value={draft.material} onChange={e => patch('material', e.target.value)} /></label></div>
            <fieldset className="admin-feature-flags"><legend>Merchandising</legend>{[{ key: 'bestSeller', label: 'Best seller' }, { key: 'newArrival', label: 'New arrival' }, { key: 'luxe', label: 'Luxe collection' }].map(item => <label key={item.key}><input type="checkbox" checked={Boolean(draft[item.key as 'bestSeller'])} onChange={e => patch(item.key as 'bestSeller', e.target.checked)} />{item.label}</label>)}</fieldset>
            {formErrors.length > 0 && <div className="form-error-banner" role="alert">{formErrors.map(message => <p key={message}>{message}</p>)}</div>}
            <button className="admin-primary-btn admin-save-btn" type="submit" disabled={saveMutation.isPending}><Check size={16} /> {saveMutation.isPending ? 'Saving…' : 'Save product & publish'}</button>
            <p className="admin-field-note"><ShieldCheck size={13} /> Changes are validated and saved by the server; the storefront shows them after its cache refreshes.</p>
          </form> : <div className="admin-editor-empty"><Shirt size={27} /><h3>Choose a product to edit</h3><p>Select a product from the catalogue, or create a new one to start merchandising.</p><button className="admin-primary-btn" onClick={startNew}><Plus size={15} /> Create product</button></div>}
        </section>
      </div>
    </div>
  </AdminDataState>;
}
