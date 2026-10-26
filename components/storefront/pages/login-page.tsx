'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { useRuntimeConfig, useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useCustomer } from '@/lib/hooks/use-customer';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

export function LoginPage() {
  const { legalPages } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const { mock } = useRuntimeConfig();
  const router = useRouter();
  const { customer, setCustomer } = useCustomer();
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [phone, setPhone] = useState('');
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [verified, setVerified] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  // Already signed in → go straight to the account area.
  useEffect(() => { if (customer && !otpStep && !verified) router.replace('/account'); }, [customer, otpStep, verified, router]);
  const requestCode = async () => {
    setBusy(true); setAuthError('');
    try {
      const result = await api.auth.requestOtp(phone);
      setRequestId(result.requestId);
      setOtpStep(true);
      notify('Verification code sent.');
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const sendOtp = (event: FormEvent) => { event.preventDefault(); if (busy || !/^[6-9]\d{9}$/.test(phone)) { setAuthError('Enter a valid 10-digit mobile number.'); return; } void requestCode(); };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!otp.every(digit => digit !== '')) { notify('Enter all 6 digits to continue.'); return; }
    setBusy(true); setAuthError('');
    try {
      const session = await api.auth.verifyOtp({ requestId, phone, otp: otp.join('') });
      setCustomer(session.customer);
      setVerified(true);
      notify('Signed in.');
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return <><main className="login-page"><div className="login-editorial"><SmartImage src="/images/campaign/menswear-portrait-framed.webp" alt="Editorial campaign model wearing modern menswear" eager /><div className="login-editorial-shade" /><div className="login-editorial-copy"><span className="eyebrow">THE EVERYDAY, ELEVATED</span><h1>Wear what's<br /><em>next.</em></h1><p>Discover considered essentials and a more personal kind of style.</p><span className="editorial-bottom">ONE 2 1 EIGHT / 1218</span></div></div><div className="login-panel-wrap"><div className="login-panel">{verified ? <div className="login-success"><div className="success-mark"><Check size={24} /></div><span className="eyebrow">YOU'RE IN</span><h2>Welcome to 1218.</h2><p>You're signed in. Your orders and saved details are in your account.</p><RouteLink href="/collections/all" className="button button-dark" onClick={onTransition}>START EXPLORING <ArrowRight size={16} /></RouteLink></div> : <><div className="login-brand"><BrandMark /><span className="eyebrow">YOUR STYLE, YOUR SPACE</span></div><h2>{otpStep ? 'One last step.' : 'Good to have you here.'}</h2><p>{otpStep ? `Enter the 6-digit code sent to +91 ${phone}.` : 'Sign in or create an account to keep your favourites, orders and details in one place.'}</p>{!otpStep ? <form onSubmit={sendOtp}><label htmlFor="phone-number">MOBILE NUMBER</label><div className="mobile-number-field"><span>+91</span><input id="phone-number" autoComplete="tel-national" type="tel" inputMode="numeric" maxLength={10} required value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="Enter 10-digit number" /></div>{authError && <p className="form-error-banner" role="alert">{authError}</p>}<button className="button button-dark login-submit" type="submit" disabled={busy}>{busy ? 'SENDING…' : 'SEND OTP'} <ArrowRight size={16} /></button>{legalPages.length > 0 && <div className="login-terms">By continuing, you agree to our {legalPages.map((page, index) => <span key={page.slug}>{index > 0 && ' and '}<RouteLink href={`/policies/${page.slug}`} onClick={onTransition}>{page.title}</RouteLink></span>)}.</div>}</form> : <form onSubmit={verify}><label>ENTER VERIFICATION CODE</label><div className="otp-fields">{otp.map((digit, index) => <input key={index} ref={el => { inputs.current[index] = el; }} value={digit} maxLength={1} inputMode="numeric" aria-label={`OTP digit ${index + 1}`} onChange={e => { const next = [...otp]; next[index] = e.target.value.replace(/\D/g, '').slice(-1); setOtp(next); if (next[index] && index < 5) inputs.current[index + 1]?.focus(); }} onKeyDown={e => { if (e.key === 'Backspace' && !otp[index] && index > 0) inputs.current[index - 1]?.focus(); }} />)}</div>{authError && <p className="form-error-banner" role="alert">{authError}</p>}<button className="button button-dark login-submit" type="submit" disabled={busy}>{busy ? 'VERIFYING…' : 'VERIFY & CONTINUE'} <ArrowRight size={16} /></button><button className="text-link otp-back" type="button" onClick={() => { setOtpStep(false); setOtp(['', '', '', '', '', '']); }}>CHANGE MOBILE NUMBER</button><button className="text-link otp-resend" type="button" onClick={() => void requestCode()} disabled={busy}>RESEND CODE</button></form>}{mock && <p className="dev-note">Development mock: enter the MOCK_OTP_CODE value from your .env.local.</p>}<div className="login-security"><ShieldCheck size={16} /><span>Your details stay private and secure.</span></div></>}</div><div className="login-back-link"><RouteLink href="/" onClick={onTransition}><ArrowLeft size={15} /> BACK TO SHOP</RouteLink></div></div></main><Footer /></>;
}
