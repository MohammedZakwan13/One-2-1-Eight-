'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, Mail, Search } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState, titleCase } from '@/components/admin/data-state';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { leadStatusSchema } from '@/lib/api/schemas';
import { slugify } from '@/lib/format';

export function AdminLeads() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'leads'], queryFn: () => api.admin.leads.list() });
  const leads = query.data?.items ?? [];
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = leads.filter(lead => `${lead.name} ${lead.email} ${lead.phone} ${lead.type}`.toLowerCase().includes(search.toLowerCase()));
  const active = leads.find(lead => lead.id === (selected ?? leads[0]?.id));
  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: 'new' | 'contacted' | 'qualified' | 'closed' }) => api.admin.leads.updateStatus(input.id, input.status),
    onSuccess: async (_lead, input) => { await Promise.all([client.invalidateQueries({ queryKey: ['admin', 'leads'] }), client.invalidateQueries({ queryKey: ['admin', 'dashboard'] })]); notify(`Enquiry marked ${input.status}.`); },
    onError: failure => notify(errorMessage(failure)),
  });
  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>
    <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">CLIENT RELATIONS / B2B</span><h1>Bulk enquiries <span className="admin-count-chip">{leads.length}</span></h1><p>Every bulk, custom merchandise and corporate project enquiry submitted from the storefront.</p></div><a className="admin-secondary-btn" href={api.admin.leads.exportUrl} download><ArrowDownRight size={15} /> Export leads</a></div><div className="admin-leads-layout"><section className="admin-card admin-lead-list-card"><div className="admin-list-toolbar"><div className="admin-input-icon"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search enquiries" aria-label="Search enquiries" /></div><span>{filtered.length} requests</span></div>{filtered.length ? filtered.map(lead => <button className={`admin-lead-list-row ${active?.id === lead.id ? 'active' : ''}`} key={lead.id} onClick={() => setSelected(lead.id)}><span className="admin-lead-avatar">{lead.name.charAt(0)}</span><span><strong>{lead.name}</strong><small>{lead.type} · {lead.createdAt.slice(0, 10)}</small><em>{lead.quantity}</em></span><span className={`status-pill status-${slugify(lead.status)}`}>{titleCase(lead.status)}</span></button>) : <div className="admin-table-empty">No enquiries yet. The next storefront form submission will show up here.</div>}</section><section className="admin-card admin-lead-detail"><div className="admin-card-heading"><div><span className="eyebrow">ENQUIRY DETAILS</span><h2>{active?.name || 'No enquiry selected'}</h2></div>{active && <span className={`status-pill status-${slugify(active.status)}`}>{titleCase(active.status)}</span>}</div>{active ? <><div className="lead-detail-grid"><div><span>CONTACT</span><strong>{active.email}</strong><strong>{active.phone}</strong></div><div><span>PROJECT TYPE</span><strong>{active.type}</strong><strong>{active.quantity}</strong></div><div><span>RECEIVED</span><strong>{active.createdAt.slice(0, 10)}</strong><strong>{active.id}</strong></div></div><div className="lead-message"><span className="eyebrow">PROJECT NOTES</span><p>{active.message || 'No additional details were shared.'}</p></div><div className="lead-actions"><label>Status<select value={active.status} disabled={statusMutation.isPending} onChange={e => statusMutation.mutate({ id: active.id, status: e.target.value as 'new' | 'contacted' | 'qualified' | 'closed' })}>{leadStatusSchema.options.map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select></label><a className="admin-primary-btn" href={`mailto:${active.email}?subject=${encodeURIComponent(`Re: ${active.type} enquiry — ONE 2 1 EIGHT`)}`}><Mail size={15} /> Reply by email</a></div></> : <div className="admin-editor-empty"><Mail size={26} /><h3>Your next good project starts here.</h3><p>Enquiries submitted through the home page appear here automatically.</p></div>}</section></div></div>
  </AdminDataState>;
}
