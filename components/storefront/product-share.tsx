'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Copy, Download, FileText, Facebook, Instagram, Mail, MessageCircle, Share2, Smartphone } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { copyText, imageFileName, runNativeShare, shareLinks, type ShareEnv, type SharePayload } from '@/lib/product-share';

/** Last-resort copy for browsers without the async clipboard API (or without permission to use it). */
function legacyCopy(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(field); field.select();
  try { return document.execCommand('copy'); } finally { document.body.removeChild(field); }
}

const readEnv = (): ShareEnv => ({
  share: typeof navigator.share === 'function' ? (data) => navigator.share(data) : undefined,
  canShare: typeof navigator.canShare === 'function' ? (data) => navigator.canShare(data) : undefined,
  coarsePointer: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
});

const POPOVER_WIDTH = 272;
type View = 'menu' | 'instagram';
type Position = { top: number; left: number; maxHeight: number } | null;

/**
 * The Share button for the product page's image overlay. Touch devices with Web Share support open the phone's own share sheet (with the real product
 * image where files can be shared); everywhere else a compact menu opens: Copy link, Copy product details, WhatsApp, Facebook, Instagram (image download +
 * caption, because Instagram has no web share link), Email. The menu is rendered in a portal and positioned from the button, so the image container's
 * overflow can never clip it, and it becomes a bottom sheet on phones.
 */
export function ProductShare({ payload }: { payload: SharePayload }) {
  const { notify } = useUi();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('menu');
  const [copied, setCopied] = useState<'link' | 'details' | 'caption' | ''>('');
  const [fallbackText, setFallbackText] = useState('');
  const [position, setPosition] = useState<Position>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [touchDevice, setTouchDevice] = useState(false);
  const busy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const image = useRef<Promise<File | null> | null>(null);
  const links = shareLinks(payload);

  /**
   * Reads the real product image once as a File, through an image element with CORS (the page's security policy allows image loads from the storage host
   * but not scripted fetches). Null when the image host does not allow it or the browser cannot encode it, in which case sharing falls back to text + URL.
   */
  const loadImage = useCallback((): Promise<File | null> => {
    if (!payload.imageUrl) return Promise.resolve(null);
    const source = payload.imageUrl;
    image.current ??= new Promise<File | null>(resolve => {
      const element = new Image();
      element.crossOrigin = 'anonymous';
      element.onerror = () => resolve(null);
      element.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
          canvas.getContext('2d')?.drawImage(element, 0, 0);
          const type = /\.jpe?g(\?|$)/i.test(source) ? 'image/jpeg' : /\.webp(\?|$)/i.test(source) ? 'image/webp' : 'image/png';
          canvas.toBlob(blob => resolve(blob ? new File([blob], imageFileName(payload.url.split('/').pop() ?? 'product', blob.type), { type: blob.type }) : null), type, 0.92);
        } catch { resolve(null); } // a tainted canvas (no CORS) or a missing 2D context
      };
      // A distinct URL keeps the browser from reusing the gallery's cached copy, which was stored without CORS headers and would fail this load.
      element.src = `${source}${source.includes('?') ? '&' : '?'}share=1`;
    });
    return image.current;
  }, [payload.imageUrl, payload.url]);

  // Native sharing needs the file ready at tap time (browsers require the share call to follow the tap directly), so on devices that can share files it is
  // prepared shortly after the page is idle. Nothing is downloaded on devices that cannot share files; the Instagram download fetches it on demand.
  useEffect(() => {
    setNativeAvailable(typeof navigator.share === 'function');
    setTouchDevice(window.matchMedia('(pointer: coarse)').matches);
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return;
    const timer = window.setTimeout(() => { void loadImage(); }, 2500);
    return () => window.clearTimeout(timer);
  }, [loadImage]);

  const close = useCallback((returnFocus = true) => { setOpen(false); setView('menu'); setFallbackText(''); if (returnFocus) trigger.current?.focus(); }, []);

  // Position next to the button (desktop) inside the viewport; on phones CSS turns the menu into a bottom sheet.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (window.matchMedia('(max-width: 760px)').matches) { setPosition(null); return; }
      const rect = trigger.current!.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) { close(false); return; } // the button scrolled out of view: the menu goes with it
      const height = popover.current?.offsetHeight ?? 320;
      const left = Math.min(Math.max(8, rect.left - POPOVER_WIDTH - 8), window.innerWidth - POPOVER_WIDTH - 8);
      const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - height - 8));
      setPosition({ top, left, maxHeight: window.innerHeight - 16 });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, { passive: true });
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place); };
  }, [open, view, fallbackText, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onPointer = (event: PointerEvent) => { const target = event.target as Node; if (!popover.current?.contains(target) && !trigger.current?.contains(target)) close(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer);
    popover.current?.querySelector<HTMLElement>('[data-share-first]')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open, view, close]);

  /** Opens the system share sheet. Success is reported only after the browser says the share finished; cancelling is silent. */
  const nativeShare = async (force: boolean): Promise<boolean> => {
    // The first tap uses the image only if it is already prepared (the share call must follow the tap directly); an explicit menu choice may wait a moment for it.
    const file = await Promise.race([loadImage(), new Promise<null>(resolve => setTimeout(() => resolve(null), force ? 4000 : 0))]);
    const result = await runNativeShare(readEnv(), payload, file, { force });
    if (result.outcome === 'shared') notify(result.withImage ? 'Shared with the product image' : 'Shared');
    return result.outcome !== 'fallback';
  };

  const onTrigger = async () => {
    if (busy.current) return; // one share action at a time: a second tap while the sheet is open does nothing
    if (open) { close(); return; }
    busy.current = true;
    try { if (!(await nativeShare(false))) setOpen(true); } finally { busy.current = false; }
  };

  const copy = async (text: string, kind: 'link' | 'details' | 'caption') => {
    const ok = await copyText(text, navigator.clipboard, legacyCopy);
    if (ok) { setCopied(kind); setFallbackText(''); notify(kind === 'link' ? 'Product link copied' : kind === 'caption' ? 'Caption copied' : 'Product details copied'); window.setTimeout(() => setCopied(''), 2200); }
    else { setFallbackText(text); notify('Could not copy automatically. Select the text below to copy it.'); window.setTimeout(() => field.current?.select(), 0); }
  };

  const download = async () => {
    const file = await loadImage();
    if (!file) { notify('The product image could not be downloaded from here. Save it from the product page instead.'); return; }
    const href = URL.createObjectURL(file);
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = file.name; document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    notify('Image download started');
  };

  /** Instagram has its own panel (never the system share dialog): download the image, copy the caption, post it by hand. Nothing is claimed to be attached. */
  const onInstagram = () => { setView('instagram'); setFallbackText(''); };

  const closeAfter = () => close(false);

  return <>
    <button ref={trigger} type="button" className="gallery-share" onClick={() => void onTrigger()} aria-label={`Share ${payload.name}`} aria-haspopup="dialog" aria-expanded={open}>
      <Share2 size={22} aria-hidden="true" />
    </button>
    <span className="visually-hidden" role="status" aria-live="polite">{copied === 'link' ? 'Product link copied' : copied === 'details' ? 'Product details copied' : copied === 'caption' ? 'Caption copied' : ''}</span>
    {open && createPortal(<>
      <div className="share-backdrop" onClick={() => close(false)} aria-hidden="true" />
      <div ref={popover} className="share-popover" role="dialog" aria-label="Share this product" style={position ? { top: position.top, left: position.left, maxHeight: position.maxHeight } : undefined}>
        {view === 'menu' ? <>
          <p className="share-popover-title">Share this piece</p>
          {nativeAvailable && <button type="button" className="share-option" data-share-first onClick={() => void nativeShare(true).then(done => { if (done) close(false); })}><Smartphone size={17} aria-hidden="true" /><span>Share with your device</span></button>}
          <button type="button" className="share-option" data-share-first={nativeAvailable ? undefined : true} onClick={() => void copy(payload.url, 'link')}>{copied === 'link' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}<span>{copied === 'link' ? 'Link copied' : 'Copy link'}</span></button>
          <button type="button" className="share-option" onClick={() => void copy(payload.detailsText, 'details')}>{copied === 'details' ? <Check size={17} aria-hidden="true" /> : <FileText size={17} aria-hidden="true" />}<span>{copied === 'details' ? 'Details copied' : 'Copy product details'}</span></button>
          <div className="share-divider" role="separator" />
          <a className="share-option" href={links.whatsapp} target="_blank" rel="noopener noreferrer" onClick={closeAfter}><MessageCircle size={17} aria-hidden="true" /><span>WhatsApp</span></a>
          <a className="share-option" href={links.facebook} target="_blank" rel="noopener noreferrer" onClick={closeAfter}><Facebook size={17} aria-hidden="true" /><span>Facebook</span></a>
          <button type="button" className="share-option" onClick={onInstagram}><Instagram size={17} aria-hidden="true" /><span>Instagram</span></button>
          <a className="share-option" href={links.email} onClick={closeAfter}><Mail size={17} aria-hidden="true" /><span>Email</span></a>
        </> : <>
          <button type="button" className="share-back" data-share-first onClick={() => setView('menu')}><ArrowLeft size={15} aria-hidden="true" /><span>Back</span></button>
          <p className="share-popover-title">Share on Instagram</p>
          <ol className="share-steps">
            <li>Download the product image.</li>
            <li>Copy the caption (name, price, brand and the product link).</li>
            <li>Open Instagram, create a post or story, choose the downloaded image and paste the caption.</li>
          </ol>
          <button type="button" className="share-option" onClick={() => void download()}><Download size={17} aria-hidden="true" /><span>Download product image</span></button>
          <button type="button" className="share-option" onClick={() => void copy(payload.instagramCaption, 'caption')}>{copied === 'caption' ? <Check size={17} aria-hidden="true" /> : <FileText size={17} aria-hidden="true" />}<span>{copied === 'caption' ? 'Caption copied' : 'Copy caption'}</span></button>
          <p className="share-note">Instagram does not accept images or captions from websites, and it does not turn links in post captions into clickable links (use a story link sticker or your bio for that).</p>
          {nativeAvailable && touchDevice && <>
            <div className="share-divider" role="separator" />
            <button type="button" className="share-option" onClick={() => void nativeShare(true).then(done => { if (done) close(false); })}><Smartphone size={17} aria-hidden="true" /><span>Share image with your device (optional)</span></button>
          </>}
        </>}
        {fallbackText && <textarea ref={field} className="share-link-field" readOnly rows={fallbackText.includes('\n') ? 5 : 2} value={fallbackText} aria-label="Text to copy" onFocus={event => event.currentTarget.select()} />}
      </div>
    </>, document.body)}
  </>;
}
