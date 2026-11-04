/**
 * Security response headers. Pure so it can be unit-tested and imported from next.config.ts
 * (keep this file free of path aliases and runtime-only imports).
 *
 * CSP note: Next.js emits inline bootstrap scripts, so `script-src` needs 'unsafe-inline'
 * unless nonces are used (which forces fully dynamic rendering). Every other directive is strict.
 * Payment SDKs / analytics must be added explicitly through the CSP_EXTRA_* variables.
 */

export type HeaderEntry = { key: string; value: string };

const list = (value: string | undefined) => (value ?? '').split(/\s+/).map(item => item.trim()).filter(Boolean);

export function buildCsp(env: Record<string, string | undefined>, isDev: boolean): string {
  // Razorpay Checkout is allowed only when the payment provider is actually configured.
  const razorpay = Boolean(env.RAZORPAY_KEY_ID);
  // The MSG91 OTP Widget SDK is loaded (and talks to MSG91) from the browser only when the widget is configured.
  const msg91 = Boolean(env.MSG91_WIDGET_ID || env.MSG91_WIDGET_ENABLED === 'true');
  // SDK file: verify.msg91.com. Its API calls: control.msg91.com (+ msg91backup.phone91.com as its built-in fallback). CAPTCHA is hCaptcha (widget captcha_type 1), whose documented sources are hcaptcha.com and *.hcaptcha.com.
  const hcaptcha = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : []), ...(razorpay ? ['https://checkout.razorpay.com'] : []), ...(msg91 ? ['https://verify.msg91.com', ...hcaptcha] : []), ...list(env.CSP_EXTRA_SCRIPT_SRC)];
  const connectSrc = ["'self'", ...(isDev ? ['ws:', 'wss:'] : []), ...(razorpay ? ['https://api.razorpay.com', 'https://lumberjack.razorpay.com'] : []), ...(msg91 ? ['https://control.msg91.com', 'https://msg91backup.phone91.com', ...hcaptcha] : []), ...list(env.CSP_EXTRA_CONNECT_SRC)];
  const imgSrc = ["'self'", 'data:', 'blob:', 'https:', ...list(env.CSP_EXTRA_IMG_SRC)];
  const frameSrc = [...(razorpay ? ['https://api.razorpay.com', 'https://checkout.razorpay.com'] : []), ...(msg91 ? hcaptcha : []), ...list(env.CSP_EXTRA_FRAME_SRC)];
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${msg91 ? hcaptcha.join(' ') : ''}`.trim(),
    `img-src ${imgSrc.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    frameSrc.length ? `frame-src ${frameSrc.join(' ')}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ];
  return directives.join('; ');
}

export function securityHeaders(env: Record<string, string | undefined>, isDev: boolean): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: 'Content-Security-Policy', value: buildCsp(env, isDev) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ];
  if (!isDev) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' });
  return headers;
}
