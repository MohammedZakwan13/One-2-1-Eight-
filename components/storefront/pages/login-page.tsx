'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useCustomer } from '@/lib/hooks/use-customer';
import { api } from '@/lib/api/client';
import { errorMessage, isUnauthorized } from '@/lib/api/errors';
import { captchaPending, prepareWidget, retryCode, sendCode, verifyCode, type WidgetKeys } from '@/lib/msg91-widget';

/** Element the MSG91 widget draws its CAPTCHA into (must exist before the widget starts). */
const CAPTCHA_ID = 'msg91-captcha';
/** Must match "OTP Length" in the MSG91 widget settings (currently 4 digits). */
const OTP_LENGTH = 4;

export function LoginPage({ returnTo = null }: { returnTo?: string | null }) {
  // `returnTo` was validated on the server (lib/return-to.ts): a same-site path that is never /login.
  const destination = returnTo ?? '/account';
  const { legalPages } = useStorefrontData();
  const { transition: onTransition, notify } = useUi();
  const router = useRouter();
  const { customer, setCustomer } = useCustomer();
  const [requestId, setRequestId] = useState('');
  const widget = useRef<(WidgetKeys & { reqId: string }) | null>(null);
  const keys = useRef<WidgetKeys | null>(null);
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [phone, setPhone] = useState('');
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState(Array<string>(OTP_LENGTH).fill(''));
  const [verified, setVerified] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  // Already signed in → go straight to the account area.
  // The cached customer can be stale (expired or revoked session), and a protected page would bounce straight back here, so confirm with the server first.
  useEffect(() => {
    if (!customer || otpStep || verified) return;
    let live = true;
    api.auth.me().then(() => { if (live) router.replace(destination); }).catch(error => { if (live && isUnauthorized(error)) setCustomer(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, otpStep, verified, router, destination]);
  // Our server gates every send/resend (rate limits, phone binding); the code itself is sent, retried and checked by the MSG91 widget in the browser.
  // Start the widget as soon as the page is shown so its CAPTCHA is visible before the first send.
  useEffect(() => {
    let live = true;
    api.auth.otpConfig().then(config => { keys.current = config; return prepareWidget(config, CAPTCHA_ID); }).catch(() => { if (live) setAuthError('Sign-in by SMS is not available right now.'); });
    return () => { live = false; };
  }, []);
  const requestCode = async (resend = false) => {
    setBusy(true); setAuthError('');
    try {
      const result = await api.auth.requestOtp(phone);
      setRequestId(result.requestId);
      const ids = { widgetId: result.widgetId, tokenAuth: result.tokenAuth };
      if (resend && widget.current?.reqId) { await retryCode(ids, widget.current.reqId, CAPTCHA_ID); widget.current = { ...ids, reqId: widget.current.reqId }; }
      else widget.current = { ...ids, reqId: await sendCode(ids, phone, CAPTCHA_ID) };
      setOtpStep(true);
      notify(resend ? 'Verification code resent.' : 'Verification code sent.');
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const sendOtp = (event: FormEvent) => { event.preventDefault(); if (busy || !/^[6-9]\d{9}$/.test(phone)) { setAuthError('Enter a valid 10-digit mobile number.'); return; } widget.current = null; if (captchaPending()) { setAuthError('Please complete the security check first.'); return; } void requestCode(); };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!otp.every(digit => digit !== '')) { notify(`Enter all ${OTP_LENGTH} digits to continue.`); return; }
    setBusy(true); setAuthError('');
    try {
      if (!widget.current) throw new Error('Please request a new code.');
      const accessToken = await verifyCode(widget.current, otp.join(''), widget.current.reqId, CAPTCHA_ID);
      const session = await api.auth.verifyOtp({ requestId, phone, accessToken });
      setCustomer(session.customer);
      setVerified(true);
      notify('Signed in.');
      if (returnTo) router.replace(returnTo);
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return <><main className="login-page"><div className="login-editorial"><SmartImage src="/images/campaign/menswear-portrait-framed.webp" alt="Editorial campaign model wearing modern menswear" eager /><div className="login-editorial-shade" /><div className="login-editorial-copy"><span className="eyebrow">THE EVERYDAY, ELEVATED</span><h1>Wear what's<br /><em>next.</em></h1><p>Discover considered essentials and a more personal kind of style.</p><span className="editorial-bottom">ONE 2 1 EIGHT / 1218</span></div></div><div className="login-panel-wrap"><div className="login-panel">{verified ? <div className="login-success"><div className="success-mark"><Check size={24} /></div><span className="eyebrow">YOU'RE IN</span><h2>Welcome to 1218.</h2><p>You're signed in. Your orders and saved details are in your account.</p><RouteLink href="/collections/all" className="button button-dark" onClick={onTransition}>START EXPLORING <ArrowRight size={16} /></RouteLink></div> : <><div className="login-brand"><BrandMark /><span className="eyebrow">YOUR STYLE, YOUR SPACE</span></div><h2>{otpStep ? 'One last step.' : 'Good to have you here.'}</h2><p>{otpStep ? `Enter the ${OTP_LENGTH}-digit code sent to +91 ${phone}.` : 'Sign in or create an account to keep your favourites, orders and details in one place.'}</p><form onSubmit={sendOtp} hidden={otpStep}><label htmlFor="phone-number">MOBILE NUMBER</label><div className="mobile-number-field"><span>+91</span><input id="phone-number" autoComplete="tel-national" type="tel" inputMode="numeric" maxLength={10} required value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="Enter 10-digit number" /></div><div id={CAPTCHA_ID} className="msg91-captcha" />{authError && !otpStep && <p className="form-error-banner" role="alert">{authError}</p>}<button className="button button-dark login-submit" type="submit" disabled={busy}>{busy ? 'SENDING…' : 'SEND OTP'} <ArrowRight size={16} /></button>{legalPages.length > 0 && <div className="login-terms">By continuing, you agree to our {legalPages.map((page, index) => <span key={page.slug}>{index > 0 && ' and '}<RouteLink href={`/policies/${page.slug}`} onClick={onTransition}>{page.title}</RouteLink></span>)}.</div>}</form>{otpStep && <form onSubmit={verify}><label>ENTER VERIFICATION CODE</label><div className="otp-fields">{otp.map((digit, index) => <input key={index} ref={el => { inputs.current[index] = el; }} value={digit} maxLength={1} inputMode="numeric" aria-label={`OTP digit ${index + 1}`} onChange={e => { const next = [...otp]; next[index] = e.target.value.replace(/\D/g, '').slice(-1); setOtp(next); if (next[index] && index < OTP_LENGTH - 1) inputs.current[index + 1]?.focus(); }} onKeyDown={e => { if (e.key === 'Backspace' && !otp[index] && index > 0) inputs.current[index - 1]?.focus(); }} />)}</div>{authError && <p className="form-error-banner" role="alert">{authError}</p>}<button className="button button-dark login-submit" type="submit" disabled={busy}>{busy ? 'VERIFYING…' : 'VERIFY & CONTINUE'} <ArrowRight size={16} /></button><button className="text-link otp-back" type="button" onClick={() => { setOtpStep(false); widget.current = null; setOtp(Array<string>(OTP_LENGTH).fill('')); }}>CHANGE MOBILE NUMBER</button><button className="text-link otp-resend" type="button" onClick={() => void requestCode(true)} disabled={busy}>RESEND CODE</button></form>}<div className="login-security"><ShieldCheck size={16} /><span>Your details stay private and secure.</span></div></>}</div><div className="login-back-link"><RouteLink href="/" onClick={onTransition}><ArrowLeft size={15} /> BACK TO SHOP</RouteLink></div></div></main><Footer /></>;
}
