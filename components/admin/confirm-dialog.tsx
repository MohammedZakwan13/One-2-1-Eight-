'use client';

import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api/errors';

export type ConfirmField = { name: string; label: string; placeholder?: string; maxLength?: number; type?: 'text' | 'url'; /** Returns an error message to block confirming, or null when the value is fine. */ validate?: (value: string) => string | null };
export type ConfirmOptions = {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  /** `danger` (default) styles the confirm button as destructive. */
  tone?: 'danger' | 'default';
  /** Optional text inputs (e.g. courier / tracking number); their values are passed to `onConfirm`. */
  fields?: ConfirmField[];
  /** Runs only when the user presses the confirm button. The dialog stays open (loading) until it settles; a rejection is shown inside the dialog. */
  onConfirm: (values: Record<string, string>) => Promise<unknown> | unknown;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => void) | null>(null);

/** One in-app confirmation dialog for every destructive Admin/CMS action (replaces window.confirm / window.prompt). */
export function useConfirm() {
  const open = useContext(ConfirmContext);
  if (!open) throw new Error('useConfirm must be used inside ConfirmProvider');
  return open;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const submitting = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  const open = useCallback((next: ConfirmOptions) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    submitting.current = false;
    setBusy(false); setError(''); setValues({}); setOptions(next);
  }, []);

  const close = useCallback(() => {
    if (submitting.current) return;
    setOptions(null);
    returnFocus.current?.focus?.();
  }, []);

  useEffect(() => { if (options) cancelButton.current?.focus(); }, [options]);

  useEffect(() => {
    if (!options) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', onKey); };
  }, [options, close]);

  const confirm = async () => {
    if (!options || submitting.current) return;
    for (const field of options.fields ?? []) {
      const problem = field.validate?.(values[field.name] ?? '') ?? null;
      if (problem) { setError(problem); return; }
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      await options.onConfirm(values);
      submitting.current = false; setBusy(false);
      setOptions(null);
      returnFocus.current?.focus?.();
    } catch (failure) {
      submitting.current = false; setBusy(false);
      setError(errorMessage(failure));
    }
  };

  return <ConfirmContext.Provider value={open}>
    {children}
    {options && <div className="confirm-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <h2 id={titleId}>{options.title}</h2>
        <p id={messageId}>{options.message}</p>
        {options.fields?.map(field => <label key={field.name}>{field.label}<input type={field.type === 'url' ? 'url' : 'text'} inputMode={field.type === 'url' ? 'url' : undefined} autoComplete="off" value={values[field.name] ?? ''} maxLength={field.maxLength ?? 120} placeholder={field.placeholder} disabled={busy} onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} /></label>)}
        {error && <p className="form-error-banner" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="admin-secondary-btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className={options.tone === 'default' ? 'admin-primary-btn' : 'admin-primary-btn confirm-danger'} onClick={() => void confirm()} disabled={busy}>{busy ? 'Working…' : options.confirmLabel}</button>
        </div>
      </div>
    </div>}
  </ConfirmContext.Provider>;
}
