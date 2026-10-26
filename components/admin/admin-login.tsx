'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { useRuntimeConfig } from '@/components/providers/app-providers';
import { BrandMark } from '@/components/ui/brand-mark';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

/**
 * Admin sign-in. Credentials are verified by the backend, which sets an HttpOnly session cookie
 * (via the same-origin proxy). Nothing is checked, stored or hard-coded in the browser.
 */
export function AdminLogin({ next }: { next: string }) {
  const router = useRouter();
  const { mock } = useRuntimeConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaStep, setMfaStep] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const finish = () => { router.replace(next); router.refresh(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (mfaStep) {
        await api.admin.auth.verifyMfa(code.trim());
        finish();
      } else {
        const result = await api.admin.auth.login(email.trim(), password);
        if (result.mfaRequired) setMfaStep(true); else finish();
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <main className="admin-login-page"><div className="admin-login-aside"><div className="admin-login-logo"><BrandMark /><span className="admin-pill">STORE OPERATIONS</span></div><div className="admin-aside-copy"><span className="eyebrow">ONE SYSTEM. EVERY DETAIL.</span><h1>Everything<br />behind the<br /><em>experience.</em></h1><p>Manage the storefront, merchandising and customer enquiries from one considered workspace.</p></div><div className="admin-aside-foot"><span>1218 / COMMERCE STUDIO</span><span>{mock ? 'DEVELOPMENT MOCK' : 'RESTRICTED'}</span></div></div><div className="admin-login-form-wrap"><div className="admin-login-form"><span className="eyebrow">RESTRICTED ACCESS</span><h2>Welcome back.</h2><p>Sign in to manage your storefront content.</p><form onSubmit={submit}>
    {!mfaStep ? <>
      <label>ADMIN EMAIL<input type="email" autoComplete="username" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} required maxLength={254} /></label>
      <label>PASSWORD<div className="password-input"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} required maxLength={256} placeholder="Enter your password" /><button type="button" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'HIDE' : 'SHOW'}</button></div></label>
    </> : <label>VERIFICATION CODE<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setError(''); }} required placeholder="6-digit code" /></label>}
    {error && <p className="admin-login-error" role="alert">{error}</p>}
    <button className="button button-dark admin-login-submit" type="submit" disabled={busy}>{busy ? 'PLEASE WAIT…' : mfaStep ? 'VERIFY' : 'ENTER CMS'} <ArrowRight size={16} /></button>
  </form>{mock && <p className="dev-note">Development mock: use MOCK_ADMIN_EMAIL / MOCK_ADMIN_PASSWORD from your .env.local.</p>}</div></div></main>;
}
