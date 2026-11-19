import { SIZE_OPTIONS, type AdminProductDraft } from '@/lib/catalog';

/** The default values of the "New product / Create a piece" form. Single source for first open and for every post-save reset. */
export const blankProductDraft = (categoryId: string): AdminProductDraft => ({
  name: '', slug: '', categoryId, price: 999, compareAt: 0, color: 'Black', colorHex: '#242424', badge: '', images: [], stockMessage: '', stockMessageMode: 'none', stockMessageNumber: '', stockMessageReview: false,
  returnable: true, exchangeable: true, codEnabled: true, onlinePaymentEnabled: true, fit: 'Regular fit', material: '100% Cotton', description: '', bestSeller: false, newArrival: true, luxe: false, status: 'active',
  stock: Object.fromEntries(SIZE_OPTIONS.map(size => [size, size === 'XXL' ? '' : '10'])),
});

export type EditorState = { selectedId: string; showForm: boolean; draft: AdminProductDraft; errors: string[] };

/** What the editor becomes after the server CONFIRMED a save (create or update): always a blank new-product form, nothing selected. */
export const editorAfterSuccessfulSave = (categoryId: string): EditorState => ({ selectedId: '', showForm: true, draft: blankProductDraft(categoryId), errors: [] });

export const saveSuccessMessage = (wasUpdate: boolean): string => (wasUpdate ? 'Product updated successfully. You can add another product now.' : 'Product created successfully. You can add another product now.');

/** Replace a saved product in the cached list, or prepend it when new — never duplicating an id. */
export function upsertProduct<T extends { id: string }, L extends { items: T[]; total: number }>(old: L, saved: T): L {
  const exists = old.items.some(item => item.id === saved.id);
  return { ...old, items: exists ? old.items.map(item => (item.id === saved.id ? saved : item)) : [saved, ...old.items], total: exists ? old.total : old.total + 1 };
}
