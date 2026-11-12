'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { ImageUploader } from '@/components/admin/image-uploader';
import { LuxeFeatureBand } from '@/components/storefront/luxe-feature-band';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { luxeFeatureSchema, type LuxeFeature } from '@/lib/api/schemas';
import { LUXE_FEATURE_DEFAULTS, resolveLuxeFeature } from '@/lib/luxe-feature';
import { createUploadSession } from '@/lib/upload-session';

/**
 * Admin: the homepage "THE PRIVATE EDIT" band (Homepage & banners). Edits a local draft with a live preview rendered by the very component
 * the storefront uses; nothing reaches the storefront until Save, which is also when a replaced or removed picture may be released.
 */
export function LuxeFeatureEditor({ fallbackImage }: { fallbackImage: string }) {
  const { notify } = useUi();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'luxe-feature'], queryFn: () => api.admin.content.getLuxeFeature() });
  const [draft, setDraft] = useState<LuxeFeature>(LUXE_FEATURE_DEFAULTS);
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const saveLock = useRef(false);
  const [session] = useState(createUploadSession);
  useEffect(() => () => { void session.abandon(); }, [session]);
  // Show what is saved (or the built-in copy when nothing is), but never overwrite edits that are in progress.
  useEffect(() => { if (query.data && !touched) setDraft(query.data.luxeFeature ?? LUXE_FEATURE_DEFAULTS); }, [query.data, touched]);

  const set = (patch: Partial<LuxeFeature>) => { setTouched(true); setErrors([]); setDraft(current => ({ ...current, ...patch })); };
  const available = query.data?.available ?? true;
  const preview = resolveLuxeFeature(draft, fallbackImage);

  const save = async () => {
    if (saveLock.current) return; // one save at a time: a second click while a request runs is ignored
    const parsed = luxeFeatureSchema.safeParse(draft);
    if (!parsed.success) { setErrors(parsed.error.issues.map(issue => issue.message)); return; }
    saveLock.current = true; setSaving(true); setErrors([]);
    try {
      const saved = await api.admin.content.updateLuxeFeature(parsed.data);
      await session.commit([saved.image].filter(Boolean));
      setDraft(saved); setTouched(false);
      await client.invalidateQueries({ queryKey: ['admin', 'luxe-feature'] });
      notify(saved.enabled ? 'Private Edit section saved: the homepage is updated.' : 'Private Edit section saved and hidden from the homepage.');
    } catch (failure) {
      setErrors([errorMessage(failure)]); // everything entered is kept so the save can simply be retried
    } finally {
      saveLock.current = false; setSaving(false);
    }
  };
  const restoreDefaults = () => { setTouched(true); setErrors([]); setDraft({ ...LUXE_FEATURE_DEFAULTS, image: draft.image }); };

  return <section className="admin-card hb-editor lf-editor" aria-label="Private Edit homepage section">
    <div className="hb-editor-head">
      <div><span className="eyebrow">HOME / LUXE FEATURE BAND</span><h3>The Private Edit section</h3>
        <p className="hb-hint">The full-width “ONE 2 1 EIGHT LUXE” band below the best-seller rail. Edit its picture, copy and button, check the preview, then save.</p></div>
      <label className="admin-toggle"><input type="checkbox" checked={draft.enabled} onChange={event => set({ enabled: event.target.checked })} aria-label="Show this section on the homepage" /><span /></label>
    </div>

    {query.isLoading && <p className="hb-hint" role="status">Loading…</p>}
    {query.isError && <div className="form-error-banner" role="alert"><p>{errorMessage(query.error)}</p></div>}
    {!available && <div className="form-error-banner" role="alert"><p>This section can be edited after database migration 0011 is applied (supabase/migrations/0011_luxe_feature.sql). Until then the homepage keeps showing the built-in text, and saving is switched off.</p></div>}

    <div className="hb-section"><h4><b>1</b> Picture</h4>
      <ImageUploader label="Section image" max={1} images={draft.image ? [draft.image] : []} onChange={images => set({ image: images[0] ?? '' })} onBusyChange={setUploading} session={session}
        hint="Wide landscape works best (it is cropped to fill the band). JPEG, PNG, WebP or AVIF · up to 10 MB (larger images auto-optimized). Removing it makes the band reuse your homepage banner picture." />
      <label>Image description (alt text) <small>Describes the picture for screen readers.</small><input maxLength={160} value={draft.imageAlt} onChange={event => set({ imageAlt: event.target.value })} /></label>
    </div>

    <div className="hb-section"><h4><b>2</b> Text</h4>
      <label>Small heading above the title<input maxLength={60} value={draft.eyebrow} onChange={event => set({ eyebrow: event.target.value })} /></label>
      <label>Main heading <small>The second line is shown in the italic accent colour (use Enter for a new line).</small><textarea rows={2} maxLength={100} value={draft.heading} onChange={event => set({ heading: event.target.value })} /></label>
      <label>Description, line 1<input maxLength={120} value={draft.bodyLine1} onChange={event => set({ bodyLine1: event.target.value })} /></label>
      <label>Description, line 2<input maxLength={120} value={draft.bodyLine2} onChange={event => set({ bodyLine2: event.target.value })} /></label>
    </div>

    <div className="hb-section"><h4><b>3</b> Button</h4>
      <label>Button label<input maxLength={40} value={draft.ctaLabel} onChange={event => set({ ctaLabel: event.target.value })} /></label>
      <label>Button destination <small>A path on this site, for example /collections/one-2-1-eight-luxe</small><input value={draft.ctaHref} onChange={event => set({ ctaHref: event.target.value })} placeholder="/collections/one-2-1-eight-luxe" /></label>
    </div>

    <div className="hb-section"><h4><b>4</b> Preview</h4>
      <div className={`lf-preview ${draft.enabled ? '' : 'is-hidden'}`}><LuxeFeatureBand feature={preview} preview /></div>
      <p className="hb-hint">{draft.enabled ? 'This is how the section will look. It goes live when you press Save.' : 'This section is switched off: it is not shown on the homepage.'} The preview is a reduced-size view; the real section scales with the screen.</p>
    </div>

    {errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}</div>}
    {uploading && <p className="hb-hint" role="status">Uploading image… saving is available when it finishes.</p>}
    <div className="hb-editor-actions">
      <button type="button" className="admin-secondary-btn" onClick={restoreDefaults} disabled={saving}><RotateCcw size={14} /> Restore original text</button>
      <button type="button" className="admin-primary-btn" onClick={() => void save()} disabled={saving || uploading || !available}><Check size={15} /> {saving ? 'Saving…' : 'Save section'}</button>
    </div>
  </section>;
}
