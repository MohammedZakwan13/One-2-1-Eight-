'use client';

import { DragEvent, useEffect, useRef, useState } from 'react';
import { Film, UploadCloud } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { UploadSession } from '@/lib/upload-session';
import { HERO_VIDEO_ACCEPT, videoFileProblem } from '@/lib/hero-media';
import type { HeroVideoInfo, HeroVideoMode } from '@/lib/api/schemas';
import { VIDEO_DURATION_TIP, formatVideoDuration, videoDurationAdvice } from '@/lib/hero-timing';

const MODES: { id: HeroVideoMode; title: string; text: string }[] = [
  { id: 'original', title: 'Original Quality', text: 'Keeps your video exactly as uploaded when browsers can play it (the default). Only converts a format browsers cannot play. Large files take longer to load.' },
  { id: 'balanced', title: 'Auto Compress — Balanced', text: 'Keeps your resolution and frame rate and reduces the file size with little visible loss.' },
  { id: 'small', title: 'Auto Compress — Smaller Size', text: 'Stronger compression for faster loading. May reduce the resolution (up to 1080p) and frame rate.' },
];
const MODE_NAME: Record<HeroVideoMode, string> = { original: 'Original Quality', balanced: 'Balanced', small: 'Smaller Size' };
const ACTION_NAME = { preserved: 'Original kept as uploaded', remuxed: 'Re-wrapped without re-encoding', reencoded: 'Re-encoded' } as const;
const dims = (f: { width: number; height: number; fps: number }) => `${f.width}×${f.height} · ${Math.round(f.fps)} fps`;
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
  const lastFile = useRef<File | null>(null);
  const confirm = useConfirm();
  const [percent, setPercent] = useState<number | null>(null);
  const [fileName, setFileName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<Record<string, number>>({});
  const [summary, setSummary] = useState<Record<string, { original: number; processed: number; info?: HeroVideoInfo }>>({});
  const [mode, setMode] = useState<HeroVideoMode>('original');
  const [phase, setPhase] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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

  /**
   * The server processes the video in the background (keeping it, re-wrapping it or compressing it, per the chosen mode, then sending it to Storage);
   * poll its job until it is ready or failed. The wait is judged by PROGRESS, not by a fixed clock: it gives up only when the server reports nothing new
   * for a long time (the server's own watchdog fails a stuck job well before that), so a slow but moving upload is never cut off and a dead one never hangs.
   */
  const waitForJob = async (jobId: string) => {
    const stageLabel = (job: { stage: string; percent: number; ahead?: number }) => {
      const pct = ` ${Math.round(job.percent)}%`;
      switch (job.stage) {
        case 'queued': return job.ahead && job.ahead > 0 ? `Waiting in line: ${job.ahead} other video${job.ahead === 1 ? '' : 's'} first…` : 'Starting…';
        case 'analyzing': return 'Processing with FFmpeg: checking the video…';
        case 'converting': return `Processing with FFmpeg: converting to MP4${pct}`;
        case 'compressing': return `Processing with FFmpeg: compressing${pct}`;
        case 'uploading': case 'saving': return `Uploading processed video to storage${pct}`;
        default: return 'Processing…';
      }
    };
    setPhase('Processing with FFmpeg…');
    const startedAt = Date.now(); let lastChange = Date.now(); let lastKey = ''; let failedPolls = 0;
    for (let poll = 0; Date.now() - startedAt < 3 * 3_600_000; poll += 1) {
      await new Promise(resolve => setTimeout(resolve, poll < 8 ? 700 : 1500)); // look often at first: short clips finish within seconds
      if (!alive.current) throw new ApiError(499, 'cancelled', 'Upload cancelled.');
      let job: Awaited<ReturnType<typeof api.admin.uploads.bannerVideoJob>>;
      try { job = await api.admin.uploads.bannerVideoJob(jobId); failedPolls = 0; } catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) throw failure; // the server no longer knows this job
        if ((failedPolls += 1) >= 6) throw failure; // a brief network hiccup is tolerated; a lasting one is reported
        continue;
      }
      if (job.status === 'failed') throw new ApiError(422, job.error?.code ?? 'video_failed', job.error?.message ?? 'The video could not be processed.'); // keep the server's own explanation
      if (job.status === 'ready' && job.url && job.path) return { path: job.path, url: job.url, warnings: job.warnings, originalBytes: job.originalBytes, processedBytes: job.processedBytes ?? 0, info: job.info };
      const key = `${job.status}|${job.stage}|${Math.round(job.percent)}|${job.ahead ?? ''}|${job.updatedAt}`;
      if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
      if (job.stage === 'converting' || job.stage === 'compressing' || job.stage === 'uploading' || job.stage === 'saving') setPercent(Math.round(job.percent));
      setPhase(stageLabel(job));
      const quiet = Date.now() - lastChange;
      if (quiet > (job.status === 'queued' ? 30 * 60_000 : 8 * 60_000)) throw new ApiError(504, 'timeout', 'The server stopped reporting progress for this video.');
    }
    throw new ApiError(504, 'timeout', 'Processing is taking far too long.');
  };

  const upload = async (files: File[]) => {
    if (uploading.current || disabled) return;
    const [file] = files;
    if (!file) return;
    const problem = videoFileProblem(file);
    setNotes([]);
    if (problem) { setErrors([problem]); return; }
    setErrors([]);
    uploading.current = true; lastFile.current = file; setPercent(0); setFileName(file.name); setPhase('Uploading original file…');
    try {
      // Any size: the file is sent in resumable chunks, then the server inspects the real contents (never the name or MIME type), processes the video
      // according to the chosen mode, and this screen follows that job until it is ready.
      const sent = await api.admin.uploads.uploadBannerVideo(file, mode, value => { setPercent(value); setPhase(value >= 100 ? 'Upload complete. Starting…' : `Uploading original file ${Math.round(value)}%`); });
      const result = await waitForJob(sent.jobId);
      uploaded.current.set(result.url, result.path);
      session?.track(result.url, () => api.admin.uploads.removeBannerVideo(result.path));
      setSize(current => ({ ...current, [result.url]: file.size }));
      setSummary(current => ({ ...current, [result.url]: { original: result.originalBytes, processed: result.processedBytes, info: result.info } }));
      const previous = value;
      onChange(result.url);
      if (previous) discardUnsaved(previous);
      setNotes(result.warnings);
    } catch (failure) {
      setErrors([`${file.name}: ${errorMessage(failure)} The existing video was kept.`]);
    } finally {
      uploading.current = false; setPercent(null); setPhase('');
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
    <fieldset className="hb-video-modes" disabled={disabled || percent !== null}>
      <legend>Video optimisation</legend>
      {MODES.map(item => <label key={item.id} className={mode === item.id ? 'is-active' : ''}><input type="radio" name={`video-mode-${label}`} value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} /><span><strong>{item.title}{item.id === 'original' ? ' (default)' : ''}</strong><small>{item.text}</small></span></label>)}
    </fieldset>
    <div className={`image-dropzone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <UploadCloud size={22} />
      <p><strong>Drag & drop</strong> a video here, or</p>
      <button type="button" className="admin-secondary-btn" onClick={() => input.current?.click()} disabled={disabled || percent !== null}>{value ? 'REPLACE VIDEO' : 'CHOOSE VIDEO'}</button>
      <small>Upload your video in a supported format. Videos are automatically converted and optimized for storefront playback.</small>
      <small>{VIDEO_DURATION_TIP}</small>
      <input ref={input} type="file" accept={HERO_VIDEO_ACCEPT} hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} />
    </div>
    {errors.length > 0 && <div className="form-error-banner" role="alert">{errors.map(message => <p key={message}>{message}</p>)}{lastFile.current && percent === null && !disabled && <button type="button" className="admin-secondary-btn" onClick={() => void upload([lastFile.current!])}>Try again</button>}</div>}
    {notes.length > 0 && !(value && summary[value]?.info) && <div className="hb-note" role="status">{[...new Set(notes)].map(message => <p key={message}>{message}</p>)}</div>}
    {value && (() => { const warnings = [...new Set((summary[value]?.info?.notes ?? []).filter(note => note.level === 'warning').map(note => note.text))]; // routine conversion notices (info level) stay in the server log and the job data, not on screen
      return warnings.length > 0 ? <div className="hb-note" role="status">{warnings.map(text => <p key={text} className="is-warning">⚠ {text}</p>)}</div> : null; })()}
    {videoDurationAdvice(lengths[value]) && <div className="hb-note" role="status"><p>{videoDurationAdvice(lengths[value])}</p></div>}
    {percent !== null && <div className="image-upload-progress" role="status"><span>{fileName}</span><i><b style={{ width: `${/^Upload|\d+%/.test(phase) ? percent : 100}%` }} /></i><em>{phase || `${percent}%`}</em></div>}
    {value && <div className="hb-video-preview">
      <video key={value} src={value} muted loop playsInline controls preload="metadata" aria-label={`${label} preview`} onLoadedMetadata={event => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds)) setLengths(current => ({ ...current, [value]: seconds })); }} />
      <div className="hb-video-meta"><Film size={13} /> <span>{uploaded.current.has(value) ? (summary[value] ? 'Ready to publish' : `New upload${size[value] ? ` · ${formatBytes(size[value])}` : ''}`) : 'Saved video'}{lengths[value] !== undefined ? ` · length ${formatVideoDuration(lengths[value])}` : ' · reading length…'}</span>
        {uploaded.current.has(value) && summary[value]?.info && (() => { const i = summary[value].info!; return <dl className="hb-video-facts">
          <div><dt>Original</dt><dd>{formatBytes(i.original.bytes)} · {dims(i.original)} · {i.original.videoCodec.toUpperCase()}</dd></div>
          <div><dt>Processed</dt><dd>{formatBytes(i.final.bytes)} · {dims(i.final)} · {i.final.videoCodec.toUpperCase()} {i.final.container.toUpperCase()}</dd></div>
          <div><dt>Mode</dt><dd>{MODE_NAME[i.mode]}</dd></div>
          <div><dt>Result</dt><dd>{ACTION_NAME[i.action]}{i.resized ? ' · Resolution reduced' : ' · Resolution unchanged'}</dd></div>
          <div className="hb-video-summary"><dd>{i.summary}</dd></div>
        </dl>; })()}
        <button type="button" className="is-danger" onClick={remove} disabled={disabled}>Remove</button></div>
    </div>}
  </div>;
}
