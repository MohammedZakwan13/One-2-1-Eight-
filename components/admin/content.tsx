'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Check, Sparkles } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { AdminDataState } from '@/components/admin/data-state';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { adminHeroSlideUpdateSchema, type HeroSlide } from '@/lib/api/schemas';

export function AdminContent() {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'content'], queryFn: () => api.admin.content.get() });
  const settings = query.data?.settings;
  const [promoDraft, setPromoDraft] = useState('');
  const [slides, setSlides] = useState<HeroSlide[]>([]);
  const [savingSlide, setSavingSlide] = useState('');
  const [slideErrors, setSlideErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (query.data) { setPromoDraft(query.data.settings.promoText); setSlides(query.data.heroSlides); } }, [query.data]);

  const settingsMutation = useMutation({
    mutationFn: (next: NonNullable<typeof settings>) => api.admin.content.updateSettings(next),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'content'] }),
    onError: failure => notify(errorMessage(failure)),
  });
  const updateSlide = (id: string, key: keyof HeroSlide, value: string | boolean) => setSlides(current => current.map(slide => slide.id === id ? ({ ...slide, [key]: value } as HeroSlide) : slide));
  const savePromo = () => { if (settings) settingsMutation.mutate({ ...settings, promoText: promoDraft }, { onSuccess: () => notify('Announcement strip updated on the storefront.') }); };
  const saveSlide = async (slide: HeroSlide, index: number) => {
    const { id, ...body } = slide;
    const parsed = adminHeroSlideUpdateSchema.safeParse(body);
    if (!parsed.success) { setSlideErrors(current => ({ ...current, [id]: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') })); return; }
    setSlideErrors(current => ({ ...current, [id]: '' })); setSavingSlide(id);
    try {
      await api.admin.content.updateHeroSlide(id, parsed.data);
      await client.invalidateQueries({ queryKey: ['admin', 'content'] });
      notify(`Campaign ${index + 1} saved — homepage updated.`);
    } catch (failure) {
      setSlideErrors(current => ({ ...current, [id]: errorMessage(failure) }));
    } finally {
      setSavingSlide('');
    }
  };

  return <AdminDataState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()}>{settings && <div className="admin-tab-content"><div className="admin-page-heading"><div><span className="eyebrow">STOREFRONT / MERCHANDISING</span><h1>Homepage & banners</h1><p>Shape the first impression. Edit campaign copy, imagery, destinations and the moving announcement strip.</p></div><RouteLink href="/" className="admin-secondary-btn" target="_blank"><ArrowUpRight size={15} /> Preview storefront</RouteLink></div><section className="admin-card announcement-editor-card"><div className="admin-card-heading"><div><span className="eyebrow">GLOBAL ANNOUNCEMENT</span><h2>Moving offer strip</h2><p>The message that travels across the top of each storefront page.</p></div><label className="admin-toggle"><input type="checkbox" checked={settings.announcementEnabled} onChange={e => settingsMutation.mutate({ ...settings, announcementEnabled: e.target.checked })} /><span /><em>{settings.announcementEnabled ? 'LIVE' : 'HIDDEN'}</em></label></div><label className="admin-full-label">ANNOUNCEMENT COPY<textarea rows={2} maxLength={400} value={promoDraft} onChange={e => setPromoDraft(e.target.value)} placeholder="Free shipping..." /></label><div className="announcement-live-preview"><span className="eyebrow">LIVE PREVIEW</span><div>{promoDraft || 'Your offer will appear here'} <ArrowRight size={14} /></div></div><button className="admin-primary-btn" onClick={savePromo} disabled={settingsMutation.isPending}><Check size={15} /> Save announcement</button></section><div className="admin-content-section-head"><div><span className="eyebrow">HOME / CAMPAIGN CAROUSEL</span><h2>Hero slides <span>{slides.filter(slide => slide.active).length} live</span></h2><p>Slides move gently every 5.4 seconds. The full image links to the destination below; use wide campaign art for desktop and portrait crops for mobile.</p></div></div><div className="hero-editor-grid">{slides.map((slide, index) => <section className="admin-card hero-editor-card" key={slide.id}><div className="hero-editor-preview"><SmartImage src={slide.desktopImage} alt={slide.title} /><span className="slide-number">0{index + 1}</span><label className="admin-toggle"><input type="checkbox" checked={slide.active} onChange={e => updateSlide(slide.id, 'active', e.target.checked)} /><span /><em>{slide.active ? 'LIVE' : 'HIDDEN'}</em></label></div><div className="hero-editor-fields"><p className="hero-clickthrough-note">The whole image links to the destination below. No overlay button is shown.</p><label>Headline <small>Use a line break to control visual rhythm.</small><textarea rows={2} maxLength={160} value={slide.title} onChange={e => updateSlide(slide.id, 'title', e.target.value)} /></label><label>Supporting copy<input maxLength={240} value={slide.body} onChange={e => updateSlide(slide.id, 'body', e.target.value)} /></label><label>Click-through destination (site path)<input value={slide.href} onChange={e => updateSlide(slide.id, 'href', e.target.value)} placeholder="/collections/all" /></label><label>Desktop image URL<input value={slide.desktopImage} onChange={e => updateSlide(slide.id, 'desktopImage', e.target.value)} /></label><label>Mobile image URL<input value={slide.mobileImage} onChange={e => updateSlide(slide.id, 'mobileImage', e.target.value)} /></label>{slideErrors[slide.id] && <p className="form-error-banner" role="alert">{slideErrors[slide.id]}</p>}<button className="admin-primary-btn" onClick={() => saveSlide(slide, index)} disabled={savingSlide === slide.id}><Check size={15} /> {savingSlide === slide.id ? 'Saving…' : 'Save slide'}</button></div></section>)}</div><div className="admin-callout"><Sparkles size={18} /><p><strong>Creative tip:</strong> Use portrait imagery for mobile and a wide campaign image for desktop. Keep text in the content layer, not baked into the image, for accessibility and responsive control.</p></div></div>}</AdminDataState>;
}
