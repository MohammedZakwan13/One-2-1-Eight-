'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Check, Sparkles } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { HeroBanners } from '@/components/admin/hero-banners';
import { LuxeFeatureEditor } from '@/components/admin/luxe-feature';
import { luxeFallbackImage } from '@/lib/luxe-feature';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

export function AdminContent() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'content'], queryFn: () => api.admin.content.get() });
  const settings = query.data?.settings;
  const [promoDraft, setPromoDraft] = useState('');
  useEffect(() => { if (query.data) setPromoDraft(query.data.settings.promoText); }, [query.data]);

  const settingsMutation = useMutation({
    mutationFn: (next: NonNullable<typeof settings>) => api.admin.content.updateSettings(next),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'content'] }),
    onError: failure => notify(errorMessage(failure)),
  });
  const savePromo = () => { if (settings) settingsMutation.mutate({ ...settings, promoText: promoDraft }, { onSuccess: () => notify('Announcement strip updated on the storefront.') }); };

  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>{settings && <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">STOREFRONT / MERCHANDISING</span><h1>Homepage & banners</h1><p>Shape the first impression. Edit campaign copy, imagery, video, destinations and the moving announcement strip.</p></div><RouteLink href="/" className="admin-secondary-btn" target="_blank"><ArrowUpRight size={15} /> Preview storefront</RouteLink></div><section className="admin-card announcement-editor-card"><div className="admin-card-heading"><div><span className="eyebrow">GLOBAL ANNOUNCEMENT</span><h2>Moving offer strip</h2><p>The message that travels across the top of each storefront page.</p></div><label className="admin-toggle"><input type="checkbox" checked={settings.announcementEnabled} onChange={e => settingsMutation.mutate({ ...settings, announcementEnabled: e.target.checked })} /><span /><em>{settings.announcementEnabled ? 'LIVE' : 'HIDDEN'}</em></label></div><label className="admin-full-label">ANNOUNCEMENT COPY<textarea rows={2} maxLength={400} value={promoDraft} onChange={e => setPromoDraft(e.target.value)} placeholder="Free shipping..." /></label><div className="announcement-live-preview"><span className="eyebrow">LIVE PREVIEW</span><div>{promoDraft || 'Your offer will appear here'} <ArrowRight size={14} /></div></div><button className="admin-primary-btn" onClick={savePromo} disabled={settingsMutation.isPending}><Check size={15} /> Save announcement</button></section><HeroBanners slides={query.data?.heroSlides ?? []} /><LuxeFeatureEditor fallbackImage={luxeFallbackImage((query.data?.heroSlides ?? []).filter(slide => slide.active))} /><div className="admin-callout"><Sparkles size={18} /><p><strong>Creative tip:</strong> Use portrait imagery or video for mobile and a wide campaign image or video for desktop. Keep text in the content layer, not baked into the media, for accessibility and responsive control.</p></div></div>}</AdminDataState>;
}
