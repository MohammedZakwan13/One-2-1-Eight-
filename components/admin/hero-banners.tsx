'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Copy, Film, Image as ImageIcon, Monitor, Pencil, Plus, Smartphone, Trash2, X } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { HeroVideoUploader } from '@/components/admin/hero-video-uploader';
import { ImageUploader } from '@/components/admin/image-uploader';
import { useUi } from '@/components/providers/app-providers';
import { SmartImage } from '@/components/ui/smart-image';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { adminHeroSlideUpdateSchema, type HeroSlide } from '@/lib/api/schemas';
import { resolveHeroMedia, moveId, type HeroMediaFields, type HeroMediaType } from '@/lib/hero-media';
import { createUploadSession, type UploadSession } from '@/lib/upload-session';

type Draft = Omit<HeroSlide, 'id' | 'sortOrder'> & { id: string | null };
type Device = 'desktop' | 'mobile';

const blankDraft = (): Draft => ({
  id: null, kicker: '', title: '', body: '', cta: '', href: '/collections/all', active: false, altText: '', updatedAt: '',
  desktopMediaType: 'image', desktopImage: '', desktopVideo: '', mobileMediaType: 'image', mobileImage: '', mobileVideo: '', useDesktopOnMobile: false,
});
const toDraft = (slide: HeroSlide): Draft => { const { sortOrder, ...rest } = slide; void sortOrder; return rest; };
const payloadOf = (draft: Draft, active: boolean) => {
  const { id, updatedAt, ...rest } = draft;
  void id;
  return { ...rest, active, expectedUpdatedAt: updatedAt || undefined };
};
const headline = (title: string) => title.replace(/\n/g, ' ').trim() || 'Untitled banner';

/** Still or first-frame preview of what a device receives. Videos with a poster show the poster, so the list never downloads a video. */
function MediaThumb({ fields, device, label }: { fields: HeroMediaFields; device: Device; label: string }) {
  const media = resolveHeroMedia(fields, device);
  const empty = media.type === 'video' ? !media.video : !media.image;
  const desktop = resolveHeroMedia(fields, 'desktop');
  const usesDesktop = device === 'mobile' && media.type === desktop.type && media.image === desktop.image && media.video === desktop.video;
  return <div className={`hb-thumb hb-thumb-${device}`}>
    <div className="hb-thumb-frame">
      {empty ? <span className="hb-thumb-empty">No media</span>
        : media.type === 'video' && !media.image ? <video src={`${media.video}#t=0.1`} muted playsInline preload="metadata" aria-label={label} />
          : <SmartImage src={media.image} alt={label} />}
      {media.type === 'video' && !empty && <span className="hb-thumb-badge"><Film size={11} /> VIDEO</span>}
    </div>
    <span className="hb-thumb-caption">{device === 'desktop' ? <Monitor size={12} /> : <Smartphone size={12} />} {device === 'desktop' ? 'Desktop' : 'Mobile'} · {media.type === 'video' ? 'Video' : 'Image'}{usesDesktop ? ' (desktop media)' : ''}</span>
  </div>;
}

/** What the banner will look like for each device, from the unsaved form. Uses the same media rules as the storefront. */
function BannerPreview({ draft }: { draft: Draft }) {
  const [device, setDevice] = useState<Device>('desktop');
  const media = resolveHeroMedia(draft, device);
  const hasMedia = media.type === 'video' ? Boolean(media.video) : Boolean(media.image);
  return <div className="hb-preview">
    <div className="hb-preview-tabs" role="tablist" aria-label="Preview device">
      {(['desktop', 'mobile'] as const).map(item => <button key={item} type="button" role="tab" aria-selected={device === item} className={device === item ? 'is-active' : ''} onClick={() => setDevice(item)}>{item === 'desktop' ? <Monitor size={13} /> : <Smartphone size={13} />} {item === 'desktop' ? 'Desktop' : 'Mobile'}</button>)}
    </div>
    <div className={`hb-preview-stage hb-preview-${device}`}>
      {!hasMedia ? <span className="hb-thumb-empty">Add {device} media to preview it</span>
        : media.type === 'video'
          ? <video key={media.video} src={media.video} poster={media.image || undefined} autoPlay muted loop playsInline preload="metadata" />
          : <img src={media.image} alt="" />}
      <div className="hb-preview-shade" />
      <div className="hb-preview-copy"><strong>{draft.title || 'Headline'}</strong><span>{draft.body || 'Supporting copy'}</span></div>
    </div>
  </div>;
}

function MediaSlot({ device, draft, set, track, session }: { device: Device; draft: Draft; set: (patch: Partial<Draft>) => void; track: (key: string) => (busy: boolean) => void; session: UploadSession }) {
  const typeKey = device === 'desktop' ? 'desktopMediaType' : 'mobileMediaType';
  const imageKey = device === 'desktop' ? 'desktopImage' : 'mobileImage';
  const videoKey = device === 'desktop' ? 'desktopVideo' : 'mobileVideo';
  const type = draft[typeKey];
  const off = device === 'mobile' && draft.useDesktopOnMobile;
  const Label = device === 'desktop' ? 'Desktop' : 'Mobile';
  // What just happened when the video was removed (cleared by any other change in this slot).
  const [note, setNote] = useState<'poster' | 'empty' | null>(null);
  const setImage = (images: string[]) => { setNote(null); set({ [imageKey]: images[0] ?? '' } as Partial<Draft>); };
  const setVideo = (url: string) => {
    if (url) { setNote(null); set({ [videoKey]: url } as Partial<Draft>); return; }
    // Video is optional. With the video gone this slot becomes an Image slot and keeps its still image (the former poster); with no image
    // either, it is an empty Image slot and the admin is asked for an image, never for a video.
    setNote(draft[imageKey] ? 'poster' : 'empty');
    set({ [videoKey]: '', [typeKey]: 'image' } as Partial<Draft>);
  };
  return <fieldset className={`hb-slot ${off ? 'is-off' : ''}`} disabled={off}>
    <legend>{device === 'desktop' ? <Monitor size={14} /> : <Smartphone size={14} />} {Label} media</legend>
    <p className="hb-hint">{device === 'desktop' ? 'Wide campaign art or a landscape video. Shown on tablets and computers.' : 'A portrait crop or video. Shown on phones (screens up to 600 px wide).'}</p>
    <div className="hb-segment" role="radiogroup" aria-label={`${Label} media type`}>
      {(['image', 'video'] as HeroMediaType[]).map(item => <button key={item} type="button" role="radio" aria-checked={type === item} className={type === item ? 'is-active' : ''} onClick={() => { setNote(null); set({ [typeKey]: item } as Partial<Draft>); }}>{item === 'image' ? <ImageIcon size={13} /> : <Film size={13} />} {item === 'image' ? 'Image' : 'Video'}</button>)}
    </div>
    {note && <div className="hb-note" role="status"><p>{note === 'poster' ? 'Video removed. This slot now shows its image (the former poster) as the banner image.' : 'Video removed. This slot is now in Image mode: upload an image before publishing.'}</p></div>}
    {type === 'image'
      ? <ImageUploader label={`${Label} image`} max={1} images={draft[imageKey] ? [draft[imageKey]] : []} onChange={setImage} onBusyChange={track(`${device}-image`)} session={session} />
      : <>
        <HeroVideoUploader label={`${Label} video`} value={draft[videoKey]} onChange={setVideo} disabled={off} onBusyChange={track(`${device}-video`)} session={session} />
        <ImageUploader label={`${Label} poster image (recommended)`} max={1} images={draft[imageKey] ? [draft[imageKey]] : []} onChange={setImage} onBusyChange={track(`${device}-poster`)} session={session} hint="Shown while the video loads, when it cannot play, and for visitors who prefer reduced motion." />
      </>}
  </fieldset>;
}

function BannerEditor({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState<Record<string, boolean>>({});
  const saveLock = useRef(false);
  // Everything uploaded while this editor is open. Kept only after the database save succeeds; otherwise deleted when the editor closes.
  const [session] = useState(createUploadSession);
  useEffect(() => () => { void session.abandon(); }, [session]);
  const top = useRef<HTMLElement>(null);
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  const track = (key: string) => (busy: boolean) => setUploads(current => (current[key] === busy ? current : { ...current, [key]: busy }));
  const uploading = Object.values(uploads).some(Boolean);
  const isNew = draft.id === null;
  useEffect(() => { top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);

  const submit = async (publish: boolean) => {
    if (saveLock.current || uploading) return;
    const parsed = adminHeroSlideUpdateSchema.safeParse(payloadOf(draft, publish));
    if (!parsed.success) { setErrors([...new Set(parsed.error.issues.map(issue => issue.message))]); return; }
    saveLock.current = true; setSaving(true); setErrors([]);
    let saved = false;
    try {
      if (draft.id) await api.admin.content.updateHeroSlide(draft.id, parsed.data);
      else await api.admin.content.createHeroSlide(parsed.data);
      saved = true;
    } catch (failure) {
      // Not saved: the existing banner and its media are untouched, and this session's uploads stay until the editor closes (then they are deleted).
      setErrors([errorMessage(failure)]);
    }
    if (saved) {
      // The database now refers to the media this form uses: keep those, delete any other file this session uploaded.
      await session.commit([draft.desktopImage, draft.mobileImage, draft.desktopVideo, draft.mobileVideo].filter(Boolean));
      // The banner IS saved even if refreshing the list fails, so the editor closes either way (a second save would add a duplicate banner).
      try { await onSaved(publish ? 'Banner published: the homepage is updated.' : 'Banner saved as a draft: it is not shown on the storefront.'); } catch { /* the list refreshes on the next load */ }
    }
    saveLock.current = false; setSaving(false);
  };

  return <section className="admin-card hb-editor" ref={top} aria-label={isNew ? 'New banner' : 'Edit banner'}>
    <div className="hb-editor-head">
      <div><span className="eyebrow">{isNew ? 'NEW BANNER' : 'EDIT BANNER'}</span><h3>{isNew ? 'Add a hero banner' : headline(initial.title)}</h3></div>
      <button type="button" className="admin-secondary-btn" onClick={onClose} disabled={saving}><X size={14} /> Close</button>
    </div>

    <div className="hb-section"><h4><b>1</b> Basic information</h4>
      <label>Headline <small>Use a line break to control visual rhythm.</small><textarea rows={2} maxLength={160} value={draft.title} onChange={event => set({ title: event.target.value })} /></label>
      <label>Image description (alt text) <small>Optional. Describes the banner for screen readers. Leave empty to use the headline.</small><input maxLength={200} value={draft.altText} onChange={event => set({ altText: event.target.value })} /></label>
    </div>

    <div className="hb-section"><h4><b>2</b> Desktop media</h4><MediaSlot device="desktop" draft={draft} set={set} track={track} session={session} /></div>

    <div className="hb-section"><h4><b>3</b> Mobile media</h4>
      <label className="hb-check"><input type="checkbox" checked={draft.useDesktopOnMobile} onChange={event => set({ useDesktopOnMobile: event.target.checked })} /> <span><strong>Use desktop media on mobile.</strong> Phones receive the desktop image or video. Your mobile files are kept, just not used.</span></label>
      <MediaSlot device="mobile" draft={draft} set={set} track={track} session={session} />
    </div>

    <div className="hb-section"><h4><b>4</b> Banner content</h4>
      <label>Supporting copy<input maxLength={240} value={draft.body} onChange={event => set({ body: event.target.value })} /></label>
    </div>

    <div className="hb-section"><h4><b>5</b> Click-through destination</h4>
      <label>Site path <small>The whole banner links here. No overlay button is shown.</small><input value={draft.href} onChange={event => set({ href: event.target.value })} placeholder="/collections/all" /></label>
    </div>

    <div className="hb-section"><h4><b>6</b> Preview, publishing and visibility</h4>
      <BannerPreview draft={draft} />
      <p className="hb-hint">{draft.active ? 'This banner is live on the storefront. Publishing saves your changes to the live homepage.' : 'This banner is a draft and is not shown on the storefront until you publish it.'}</p>
    </div>

    {errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}</div>}
    {uploading && <p className="hb-hint" role="status">Uploading media… saving is available when it finishes.</p>}
    <div className="hb-editor-actions">
      <button type="button" className="admin-secondary-btn" onClick={() => void submit(false)} disabled={saving || uploading}>{saving ? 'Saving…' : isNew || !draft.active ? 'Save as draft' : 'Save as draft (hide from storefront)'}</button>
      <button type="button" className="admin-primary-btn" onClick={() => void submit(true)} disabled={saving || uploading}><Check size={15} /> {saving ? 'Saving…' : draft.active ? 'Publish changes' : 'Publish to storefront'}</button>
    </div>
  </section>;
}

export function HeroBanners({ slides }: { slides: HeroSlide[] }) {
  const { notify } = useUi();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const ids = useMemo(() => slides.map(slide => slide.id), [slides]);
  const live = slides.filter(slide => slide.active).length;
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'content'] });

  /** One action at a time: a second click while a request is running is ignored. */
  const guarded = async (key: string, work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key);
    try { await work(); } catch (failure) { notify(errorMessage(failure)); await refresh(); } finally { lock.current = false; setBusy(''); }
  };

  const move = (id: string, step: -1 | 1) => guarded(`move-${id}`, async () => {
    const next = moveId(ids, id, step);
    if (next === ids) return;
    await api.admin.content.reorderHeroSlides(next);
    await refresh();
    notify('Banner order saved: the homepage carousel follows it.');
  });
  const duplicate = (slide: HeroSlide) => guarded(`dup-${slide.id}`, async () => {
    await api.admin.content.duplicateHeroSlide(slide.id);
    await refresh();
    notify('Copy added as a hidden draft, right after the original.');
  });
  const toggle = (slide: HeroSlide) => guarded(`toggle-${slide.id}`, async () => {
    const parsed = adminHeroSlideUpdateSchema.safeParse(payloadOf(toDraft(slide), !slide.active));
    if (!parsed.success) { notify(parsed.error.issues[0]?.message ?? 'This banner cannot be published yet.'); return; }
    await api.admin.content.updateHeroSlide(slide.id, parsed.data);
    await refresh();
    notify(slide.active ? 'Banner hidden from the storefront.' : 'Banner is now live.');
  });
  const remove = (slide: HeroSlide, index: number) => confirm({
    title: 'Delete banner?',
    message: `Banner ${index + 1} (“${headline(slide.title)}”) will be removed from the carousel for good. Its image and video files are deleted too, unless another banner uses them.`,
    confirmLabel: 'Delete banner',
    onConfirm: async () => {
      await api.admin.content.deleteHeroSlide(slide.id);
      if (editing?.id === slide.id) setEditing(null);
      await refresh();
      notify('Banner deleted.');
    },
  });

  return <>
    <div className="admin-content-section-head hb-head">
      <div><span className="eyebrow">HOME / CAMPAIGN CAROUSEL</span><h2>Hero slides <span>{live} live</span></h2>
        <p>Slides move gently every 5.4 seconds. Each banner has its own desktop and mobile media (image or video), and there is no limit on how many you add.</p></div>
      <button type="button" className="admin-primary-btn hb-add" onClick={() => setEditing(blankDraft())} disabled={busy !== ''}><Plus size={15} /> Add New Banner</button>
    </div>

    <div className="hb-stats" aria-label="Banner overview">
      <div><strong>{slides.length}</strong><span>Total banners</span></div>
      <div><strong>{live}</strong><span>Live on storefront</span></div>
      <div><strong>{slides.length - live}</strong><span>Hidden or draft</span></div>
    </div>

    {editing && <BannerEditor key={editing.id ?? 'new'} initial={editing} onClose={() => setEditing(null)} onSaved={async message => { setEditing(null); try { await refresh(); } finally { notify(message); } }} />}

    {slides.length === 0 ? <div className="admin-card hb-empty"><h3>No banners yet</h3><p>The homepage shows a simple brand header until you add and publish a banner.</p><button type="button" className="admin-primary-btn" onClick={() => setEditing(blankDraft())}><Plus size={15} /> Add New Banner</button></div>
      : <ol className="hb-list">{slides.map((slide, index) => <li key={slide.id} className={`admin-card hb-card ${slide.active ? '' : 'is-hidden'}`}>
        <div className="hb-card-order"><span className="slide-number-lite">{String(index + 1).padStart(2, '0')}</span>
          <div className="hb-move"><button type="button" onClick={() => void move(slide.id, -1)} disabled={index === 0 || busy !== ''} aria-label={`Move banner ${index + 1} earlier`}><ArrowUp size={14} /></button><button type="button" onClick={() => void move(slide.id, 1)} disabled={index === slides.length - 1 || busy !== ''} aria-label={`Move banner ${index + 1} later`}><ArrowDown size={14} /></button></div></div>
        <div className="hb-card-media"><MediaThumb fields={slide} device="desktop" label={`Desktop media for banner ${index + 1}`} /><MediaThumb fields={slide} device="mobile" label={`Mobile media for banner ${index + 1}`} /></div>
        <div className="hb-card-body">
          <div className="hb-card-title"><h3>{headline(slide.title)}</h3><span className={`hb-status ${slide.active ? 'is-live' : ''}`}>{slide.active ? 'LIVE' : 'DRAFT / HIDDEN'}</span></div>
          <p>{slide.body || 'No supporting copy'}</p><small>{slide.href}</small>
          <div className="hb-actions">
            <button type="button" className="admin-secondary-btn" onClick={() => setEditing(toDraft(slide))} disabled={busy !== ''}><Pencil size={13} /> Edit</button>
            <button type="button" className="admin-secondary-btn" onClick={() => void duplicate(slide)} disabled={busy !== ''}><Copy size={13} /> {busy === `dup-${slide.id}` ? 'Duplicating…' : 'Duplicate'}</button>
            <label className="admin-toggle"><input type="checkbox" checked={slide.active} onChange={() => void toggle(slide)} disabled={busy !== ''} aria-label={`${slide.active ? 'Hide' : 'Publish'} banner ${index + 1}`} /><span /><em>{slide.active ? 'LIVE' : 'HIDDEN'}</em></label>
            <button type="button" className="admin-secondary-btn hb-delete" onClick={() => remove(slide, index)} disabled={busy !== ''}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      </li>)}</ol>}
  </>;
}
