'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Facebook, Instagram, Mail, MessageCircle, Share2 } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { copyText, productShareData, runNativeShare, shareLinks, type ShareEnv } from '@/lib/product-share';

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

/**
 * Share button for the product page. Touch devices with Web Share support open the phone's own share sheet; everywhere else a small popover offers
 * Copy link, WhatsApp, Facebook, X and Email. The link is always the product's canonical URL, passed in by the page.
 */
export function ProductShare({ url, productName, brandName }: { url: string; productName: string; brandName: string }) {
  const { notify } = useUi();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const data = productShareData(url, productName, brandName);
  const links = shareLinks(data);

  const close = (returnFocus = true) => { setOpen(false); setCopyFailed(false); if (returnFocus) trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) close(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer);
    root.current?.querySelector<HTMLElement>('[data-share-first]')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  const onShare = async () => {
    if (busy.current) return; // one share action at a time: a second tap while the sheet is open does nothing
    if (open) { close(); return; }
    busy.current = true;
    try {
      const outcome = await runNativeShare(readEnv(), data);
      if (outcome === 'fallback') setOpen(true); // cancelled is silent; shared needs no message from us
    } finally { busy.current = false; }
  };

  const onCopy = async () => {
    const ok = await copyText(url, navigator.clipboard, legacyCopy);
    if (ok) { setCopied(true); setCopyFailed(false); notify('Product link copied'); window.setTimeout(() => setCopied(false), 2200); }
    else { setCopyFailed(true); notify('Could not copy automatically. Select the link below to copy it.'); window.setTimeout(() => field.current?.select(), 0); }
  };

  /** Instagram cannot be given a link to share, so the product link is copied first and Instagram opens (the anchor's own navigation) for pasting. */
  const onInstagram = () => {
    void copyText(url, navigator.clipboard, legacyCopy).then(ok => notify(ok ? 'Product link copied. Paste it in Instagram.' : 'Open Instagram and paste the product link there.'));
    close(false);
  };

  return <div className="product-share" ref={root}>
    <button ref={trigger} type="button" className="gallery-share" onClick={() => void onShare()} aria-label={`Share ${productName}`} aria-haspopup="dialog" aria-expanded={open}>
      <Share2 size={22} aria-hidden="true" />
    </button>
    {open && <div className="share-popover" role="dialog" aria-label="Share this product">
      <p className="share-popover-title">Share this piece</p>
      <button type="button" className="share-option" data-share-first onClick={() => void onCopy()}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}<span>{copied ? 'Link copied' : 'Copy link'}</span></button>
      <a className="share-option" href={links.whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => close(false)}><MessageCircle size={16} aria-hidden="true" /><span>WhatsApp</span></a>
      <a className="share-option" href={links.facebook} target="_blank" rel="noopener noreferrer" onClick={() => close(false)}><Facebook size={16} aria-hidden="true" /><span>Facebook</span></a>
      <a className="share-option" href={links.instagram} target="_blank" rel="noopener noreferrer" onClick={onInstagram}><Instagram size={16} aria-hidden="true" /><span>Instagram</span></a>
      <a className="share-option" href={links.email} onClick={() => close(false)}><Mail size={16} aria-hidden="true" /><span>Email</span></a>
      {copyFailed && <input ref={field} className="share-link-field" readOnly value={url} aria-label="Product link" onFocus={event => event.currentTarget.select()} />}
    </div>}
    <span className="visually-hidden" role="status" aria-live="polite">{copied ? 'Product link copied' : ''}</span>
  </div>;
}
