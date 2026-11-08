'use client';

import { DragEvent, useEffect, useRef, useState } from 'react';
import { Film, UploadCloud } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { UploadSession } from '@/lib/upload-session';
import { HERO_VIDEO_ACCEPT, HERO_VIDEO_FORMATS_LABEL, HERO_VIDEO_MAX_LABEL, inspectHeroVideo, videoFileProblem } from '@/lib/hero-media';
import { VIDEO_DURATION_TIP, formatVideoDuration, videoDurationAdvice } from '@/lib/hero-timing';

const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Single-video picker for one banner slot: drag & drop or browse, real upload progress, preview, replace, remove.
 * Removing or replacing a SAVED video only changes the form; the file is deleted on the server when the banner is saved (and only if
 * no banner uses it any more). A video uploaded in this session but never saved is deleted straight away.
 */
export function HeroVideoUploader({ label, value, onChange, disabled = false, onBusyChange, session }: { label: string; value: string; onChange: (url: string) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void; /** The editor's upload session: it deletes videos uploaded here but never saved when the editor closes or the save fails. */ session?: UploadSession }) {
  const input = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new Map<string, string>());
  const uploading = useRef(false);
  const confirm = useConfirm();
  const [percent, setPercent] = useState<number | null>(null);
  const [fileName, setFileName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<Record<string, number>>({});
  const [lengths, setLengths] = useState<Record<string, number>>({}); // seconds, read from the browser's own video metadata
  const busy = percent !== null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const discardUnsaved = (url: string) => {
    const path = uploaded.current.get(url);
    if (!path) return;
    uploaded.current.delete(url);
    session?.forget(url);
    void api.admin.uploads.removeBannerVideo(path).catch(() => undefined);
  };

  const upload = async (files: File[]) => {
    if (uploading.current || disabled) return;
    const [file] = files;
    if (!file) return;
    const problem = videoFileProblem(file);
    setNotes([]);
    if (problem) { setErrors([problem]); return; }
    setErrors([]);
    uploading.current = true; setPercent(0); setFileName(file.name);
    try {
      // Same content check the server runs (the name and the browser's MIME type are not trusted), so an unusable file is explained before it is uploaded.
      const verdict = inspectHeroVideo(new Uint8Array(await file.arrayBuffer()));
      if (!verdict.ok) { setErrors([`${file.name}: ${verdict.error.message}`]); return; }
      const result = await api.admin.uploads.uploadBannerVideo(file, setPercent);
      uploaded.current.set(result.url, result.path);
      session?.track(result.url, () => api.admin.uploads.removeBannerVideo(result.path));
      setSize(current => ({ ...current, [result.url]: file.size }));
      const previous = value;
      onChange(result.url);
      if (previous) discardUnsaved(previous);
      setNotes(result.warnings);
    } catch (failure) {
      setErrors([`${file.name}: ${errorMessage(failure)} The existing video was kept.`]);
    } finally {
      uploading.current = false; setPercent(null);
    }
  };

  const remove = () => {
    if (uploaded.current.has(value)) { discardUnsaved(value); onChange(''); return; }
    confirm({
      title: 'Remove video?',
      message: `This video will be removed from "${label}" when you save. Nothing is deleted until the save succeeds.`,
      confirmLabel: 'Remove video',
      onConfirm: () => onChange(''),
    });
  };

  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); void upload([...event.dataTransfer.files]); };

  return <div className="image-uploader hb-video-uploader">
    <span className="image-uploader-label">{label}</span>
    <div className={`image-dropzone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <UploadCloud size={22} />
      <p><strong>Drag & drop</strong> a video here, or</p>
      <button type="button" className="admin-secondary-btn" onClick={() => input.current?.click()} disabled={disabled || percent !== null}>{value ? 'REPLACE VIDEO' : 'CHOOSE VIDEO'}</button>
      <small>{HERO_VIDEO_FORMATS_LABEL} · up to {HERO_VIDEO_MAX_LABEL} · plays muted</small>
      <small>{VIDEO_DURATION_TIP}</small>
      <input ref={input} type="file" accept={HERO_VIDEO_ACCEPT} hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} />
    </div>
    {errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}</div>}
    {notes.length > 0 && <div className="hb-note" role="status">{notes.map(message => <p key={message}>{message}</p>)}</div>}
    {videoDurationAdvice(lengths[value]) && <div className="hb-note" role="status"><p>{videoDurationAdvice(lengths[value])}</p></div>}
    {percent !== null && <div className="image-upload-progress" role="status"><span>{fileName}</span><i><b style={{ width: `${percent}%` }} /></i><em>{percent}%</em></div>}
    {value && <div className="hb-video-preview">
      <video key={value} src={value} muted loop playsInline controls preload="metadata" aria-label={`${label} preview`} onLoadedMetadata={event => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds)) setLengths(current => ({ ...current, [value]: seconds })); }} />
      <div className="hb-video-meta"><Film size={13} /> <span>{uploaded.current.has(value) ? `New upload${size[value] ? ` · ${formatBytes(size[value])}` : ''}` : 'Saved video'}{lengths[value] !== undefined ? ` · length ${formatVideoDuration(lengths[value])}` : ' · reading length…'}</span>
        <button type="button" className="is-danger" onClick={remove} disabled={disabled}>Remove</button></div>
    </div>}
  </div>;
}
