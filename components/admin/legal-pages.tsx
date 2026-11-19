'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { useUi } from '@/components/providers/app-providers';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { slugify } from '@/lib/format';

const SUGGESTED = ['terms', 'privacy'];

/** Legal pages (terms, privacy, …) shown under /policies/<slug> and linked from the footer once published. */
export function LegalPagesEditor() {
  const { notify } = useUi();
  const confirm = useConfirm();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'pages'], queryFn: () => api.admin.content.pages() });
  const pages = query.data?.items ?? [];
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [published, setPublished] = useState(true);
  const [error, setError] = useState('');

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['admin', 'pages'] })]);
  const save = useMutation({
    mutationFn: () => api.admin.content.savePage(slug, { title: title.trim(), body, published }),
    onSuccess: async () => { await refresh(); notify('Page saved.'); setError(''); },
    onError: failure => setError(errorMessage(failure)),
  });
  const remove = useMutation({
    mutationFn: (target: string) => api.admin.content.removePage(target),
    onSuccess: async () => { await refresh(); notify('Page deleted.'); },
    onError: failure => notify(errorMessage(failure)),
  });
  const edit = (target: string) => {
    const page = pages.find(item => item.slug === target);
    setSlug(target); setTitle(page?.title ?? ''); setBody(page?.body ?? ''); setPublished(page?.published ?? true); setError('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) { setError('Use a URL name with lowercase letters, numbers and dashes.'); return; }
    if (!title.trim()) { setError('Add a page title.'); return; }
    save.mutate();
  };

  return <section className="admin-card admin-settings-card legal-page-editor">
    <div className="admin-card-heading"><div><span className="eyebrow">LEGAL & POLICY PAGES</span><h2>Terms, privacy and more</h2><p>Published pages appear at /policies/&lt;name&gt; and in the footer. Terms and privacy are linked from checkout.</p></div></div>
    <div className="admin-feature-flags"><legend>Edit</legend>{[...new Set([...SUGGESTED, ...pages.map(page => page.slug)])].map(name => <button type="button" className="admin-secondary-btn" key={name} onClick={() => edit(name)}>{name}{pages.find(page => page.slug === name)?.published ? '' : ' (not published)'}</button>)}</div>
    <form className="admin-edit-form" onSubmit={submit}>
      <div className="admin-form-two"><label>URL name<input value={slug} onChange={e => setSlug(slugify(e.target.value))} placeholder="terms" maxLength={60} /></label><label>Title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={160} placeholder="Terms & Conditions" /></label></div>
      <label>Content (blank lines start a new paragraph)<textarea value={body} onChange={e => setBody(e.target.value)} maxLength={100000} /></label>
      <label className="admin-checkbox-line"><input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)} /> Published</label>
      {error && <div className="form-error-banner" role="alert"><p>{error}</p></div>}
      <div className="admin-page-actions">
        <button className="admin-primary-btn" type="submit" disabled={save.isPending}><Check size={15} /> {save.isPending ? 'Saving…' : 'Save page'}</button>
        {pages.some(page => page.slug === slug) && <button type="button" className="admin-danger-quiet" disabled={remove.isPending} onClick={() => confirm({ title: 'Delete page?', message: <>Are you sure you want to delete the “{slug}” page? Its link disappears from the storefront. This action cannot be undone.</>, confirmLabel: 'Delete page', onConfirm: () => remove.mutateAsync(slug) })}><Trash2 size={14} /> DELETE</button>}
      </div>
    </form>
  </section>;
}
