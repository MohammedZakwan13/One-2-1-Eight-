'use client';

import { DragEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Star, UploadCloud } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { SmartImage } from '@/components/ui/smart-image';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
  MAX_ORIGINAL_IMAGE_BYTES,
  MAX_ORIGINAL_IMAGE_LABEL,
} from '@/lib/upload-limits';
import { formatBytes, optimizeImage } from '@/lib/image-optimizer';
import type { UploadSession } from '@/lib/upload-session';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

type Pending = { key: string; name: string; percent: number; statusText?: string };

/**
 * Image picker for products, categories and banners: drag & drop or browse, live progress, preview, primary image,
 * reorder, replace and remove. Files go to Supabase Storage through the admin API; only the resulting URLs are saved.
 * Removing or replacing a SAVED image only changes the form: the record (and then the Storage object) is updated when the
 * admin saves, so a failed save never loses an image. Images uploaded in this session but not yet saved are deleted on removal.
 * Images up to 10 MB are uploaded directly; images up to 50 MB are automatically compressed before upload.
 * `max={1}` turns it into a single-image field.
 */
export function ImageUploader({ images, onChange, max = 12, label, hint, onBusyChange, session }: { images: string[]; onChange: (images: string[]) => void; max?: number; label: string; hint?: string; /** Called with true while an upload is running (lets a form disable Save). */ onBusyChange?: (busy: boolean) => void; /** Optional: an editor-wide session that deletes images uploaded here but never saved when the editor closes or the save fails. */ session?: UploadSession }) {
  const input = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new Map<string, string>());
  const replacing = useRef<number | null>(null);
  const current = useRef(images);
  current.current = images;
  const confirm = useConfirm();
  const [pending, setPending] = useState<Pending[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [infos, setInfos] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const single = max === 1;
  const busy = pending.length > 0;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const commit = (next: string[]) => { current.current = next; onChange(next); };
  const discardUnsaved = (url: string) => {
    const path = uploaded.current.get(url);
    if (!path) return;
    uploaded.current.delete(url);
    session?.forget(url);
    void api.admin.uploads.remove(path).catch(() => undefined);
  };

  const uploadFiles = async (files: File[], replaceIndex: number | null) => {
    const problems: string[] = [];
    const room = replaceIndex !== null || single ? 1 : Math.max(0, max - current.current.length);
    const accepted = files.filter(file => {
      if (file.size > MAX_ORIGINAL_IMAGE_BYTES) {
        problems.push(`${file.name}: Image is too large to process. Please choose an image under ${MAX_ORIGINAL_IMAGE_LABEL}.`);
        return false;
      }
      if (!ACCEPT.includes(file.type)) {
        problems.push(`${file.name}: only JPEG, PNG, WebP or AVIF images are allowed.`);
        return false;
      }
      return true;
    });
    if (accepted.length > room) problems.push(`Only ${room} more image${room === 1 ? '' : 's'} can be attached here. Extra files were skipped.`);
    setErrors(problems);
    setInfos([]);

    await Promise.all(accepted.slice(0, room).map(async file => {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      setPending(list => [...list, { key, name: file.name, percent: 0, statusText: file.size > MAX_IMAGE_UPLOAD_BYTES ? 'Optimizing image...' : undefined }]);
      try {
        let fileToUpload = file;
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
          const optimized = await optimizeImage(file, {
            onProgress: p => {
              setPending(list => list.map(item => (item.key === key ? { ...item, percent: p.percent ?? 0, statusText: p.message } : item)));
            },
          });
          fileToUpload = optimized.file;
          if (optimized.compressed) {
            setInfos(list => [...list, `Optimized ${file.name}: ${formatBytes(optimized.originalBytes)} → ${formatBytes(optimized.optimizedBytes)} (${optimized.compressionRatio}% smaller)`]);
          }
        }

        setPending(list => list.map(item => (item.key === key ? { ...item, percent: 0, statusText: 'Uploading...' } : item)));

        const result = await api.admin.uploads.upload(fileToUpload, percent => setPending(list => list.map(item => (item.key === key ? { ...item, percent, statusText: `${percent}%` } : item))));
        uploaded.current.set(result.url, result.path);
        session?.track(result.url, () => api.admin.uploads.remove(result.path));
        const base = current.current;
        if (replaceIndex !== null && base[replaceIndex] !== undefined) {
          const old = base[replaceIndex];
          commit(base.map((url, index) => (index === replaceIndex ? result.url : url)));
          discardUnsaved(old);
        } else if (single) {
          const old = base[0];
          commit([result.url]);
          if (old) discardUnsaved(old);
        } else {
          commit([...base, result.url]);
        }
      } catch (failure) {
        setErrors(list => [...list, `${file.name}: ${errorMessage(failure)} The existing image was kept.`]);
      } finally {
        setPending(list => list.filter(item => item.key !== key));
      }
    }));
  };

  const browse = (index: number | null) => { replacing.current = index; input.current?.click(); };
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); void uploadFiles([...event.dataTransfer.files], null); };
  const move = (index: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = [...images]; [next[index], next[to]] = [next[to], next[index]]; commit(next);
  };
  const remove = (index: number) => {
    const url = images[index];
    if (uploaded.current.has(url)) { commit(images.filter((_, i) => i !== index)); discardUnsaved(url); return; }
    confirm({
      title: 'Remove image?',
      message: `This image will be removed from "${label}" when you save. Nothing is deleted until the save succeeds.`,
      confirmLabel: 'Remove image',
      onConfirm: () => commit(images.filter((_, i) => i !== index)),
    });
  };

  return <div className="image-uploader">
    <span className="image-uploader-label">{label}</span>
    <div className={`image-dropzone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <UploadCloud size={22} />
      <p><strong>Drag & drop</strong> {single ? 'an image' : 'images'} here, or</p>
      <button type="button" className="admin-secondary-btn" onClick={() => browse(null)} disabled={!single && images.length >= max}>{single && images.length ? 'REPLACE IMAGE' : 'CHOOSE FILES'}</button>
      <small>{hint ?? `JPEG, PNG, WebP or AVIF · up to ${MAX_IMAGE_UPLOAD_LABEL} each (larger images up to ${MAX_ORIGINAL_IMAGE_LABEL} auto-optimized)`}</small>
      <input ref={input} type="file" accept={ACCEPT.join(',')} multiple={!single && replacing.current === null} hidden onChange={event => { const files = [...(event.target.files ?? [])]; const target = replacing.current; replacing.current = null; event.target.value = ''; void uploadFiles(files, target); }} />
    </div>
    {errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}</div>}
    {infos.length > 0 && <div className="image-uploader-info" role="status">{infos.map(message => <p key={message}>{message}</p>)}</div>}
    {pending.map(item => <div className="image-upload-progress" key={item.key} role="status"><span>{item.name}{item.statusText ? ` (${item.statusText})` : ''}</span><i><b style={{ width: `${item.percent}%` }} /></i><em>{item.percent}%</em></div>)}
    {images.length > 0 && <ul className="image-uploader-grid">{images.map((url, index) => <li key={`${url}-${index}`}>
      <SmartImage src={url} alt={`${label} ${index + 1}`} />
      {!single && index === 0 && <span className="image-primary-badge">PRIMARY</span>}
      {!single && <div className="image-uploader-move">
        <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move image ${index + 1} earlier`}><ArrowLeft size={14} /></button>
        <button type="button" onClick={() => move(index, index + 1)} disabled={index === images.length - 1} aria-label={`Move image ${index + 1} later`}><ArrowRight size={14} /></button>
        <button type="button" onClick={() => move(index, 0)} disabled={index === 0} aria-label={`Make image ${index + 1} the primary image`}><Star size={14} /></button>
      </div>}
      <div className="image-uploader-actions">
        {!single && <button type="button" onClick={() => browse(index)} aria-label={`Replace image ${index + 1}`}>Replace</button>}
        <button type="button" className="is-danger" onClick={() => remove(index)} aria-label={`Remove image ${index + 1}`}>Remove</button>
      </div>
    </li>)}</ul>}
  </div>;
}
