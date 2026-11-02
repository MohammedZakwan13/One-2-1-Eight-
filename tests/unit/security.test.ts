import { describe, expect, it } from 'vitest';
import { adminGateDecision, safeAdminNext } from '@/lib/admin-gate';
import { isSameOriginWrite, sanitizeProxyPath } from '@/lib/api/proxy';
import { buildCsp, securityHeaders } from '@/lib/security-headers';
import { jsonLd } from '@/lib/site';
import { safeUrl, internalPath } from '@/lib/api/schemas';
import { csvCell } from '@/lib/backend/core';

describe('proxy path sanitising', () => {
  it('accepts normal API paths', () => {
    expect(sanitizeProxyPath(['products', 'tee-1'])).toBe('/products/tee-1');
    expect(sanitizeProxyPath(['admin', 'orders', 'export.csv'])).toBe('/admin/orders/export.csv');
  });
  it('rejects traversal, encoded traversal, separators and junk', () => {
    for (const segments of [['..', 'admin'], ['a', '..'], ['.', 'x'], ['%2e%2e', 'x'], ['%2E%2E%2F', 'x'], ['a%2Fb'], ['a%5Cb'], ['a\\b'], [''], ['x', ''], ['a b'], ['a%00b'], ['<script>'], []]) {
      expect(sanitizeProxyPath(segments), JSON.stringify(segments)).toBeNull();
    }
    expect(sanitizeProxyPath(Array.from({ length: 12 }, () => 'a'))).toBeNull();
  });
});

describe('cross-origin write protection', () => {
  it('allows same-origin and header-less clients, blocks foreign origins', () => {
    expect(isSameOriginWrite('https://shop.in', 'shop.in')).toBe(true);
    expect(isSameOriginWrite(null, 'shop.in')).toBe(true);
    expect(isSameOriginWrite('https://evil.com', 'shop.in')).toBe(false);
    expect(isSameOriginWrite('https://shop.in.evil.com', 'shop.in')).toBe(false);
    expect(isSameOriginWrite('null', 'shop.in')).toBe(false);
    expect(isSameOriginWrite('https://shop.in', null)).toBe(false);
  });
});

describe('admin gate', () => {
  it('lets only the login page through without a session cookie', () => {
    expect(adminGateDecision('/admin', false)).toBe('redirect-to-login');
    expect(adminGateDecision('/admin/products', false)).toBe('redirect-to-login');
    expect(adminGateDecision('/admin/login', false)).toBe('allow');
    expect(adminGateDecision('/admin/products', true)).toBe('allow');
    expect(adminGateDecision('/products/x', false)).toBe('allow');
  });
  it('prevents open redirects after login', () => {
    expect(safeAdminNext('/admin/orders')).toBe('/admin/orders');
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/orders', 'javascript:alert(1)', '/admin/login', '/admin\r\nSet-Cookie: x=1', null, undefined, '']) {
      expect(safeAdminNext(bad as string | null | undefined), String(bad)).toBe('/admin');
    }
  });
});

describe('security headers', () => {
  it('ships a strict CSP in production', () => {
    const csp = buildCsp({}, false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*\*/);
  });
  it('only relaxes eval/websockets in development', () => {
    const csp = buildCsp({}, true);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
  it('lets operators allow-list payment SDKs explicitly', () => {
    const csp = buildCsp({ CSP_EXTRA_SCRIPT_SRC: 'https://checkout.razorpay.com', CSP_EXTRA_FRAME_SRC: 'https://api.razorpay.com', CSP_EXTRA_CONNECT_SRC: 'https://lumberjack.razorpay.com' }, false);
    expect(csp).toContain('script-src \'self\' \'unsafe-inline\' https://checkout.razorpay.com');
    expect(csp).toContain('frame-src https://api.razorpay.com');
    expect(csp).toContain('connect-src \'self\' https://lumberjack.razorpay.com');
  });
  it('allows the MSG91 widget and hCaptcha sources only when the widget is configured', () => {
    const off = buildCsp({}, false);
    expect(off).not.toMatch(/msg91|hcaptcha/);
    expect(off).toContain("frame-src 'none'");
    const csp = buildCsp({ MSG91_WIDGET_ID: 'w' }, false);
    expect(csp).toMatch(/script-src[^;]*https:\/\/verify\.msg91\.com[^;]*https:\/\/\*\.hcaptcha\.com/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/control\.msg91\.com[^;]*https:\/\/msg91backup\.phone91\.com[^;]*https:\/\/\*\.hcaptcha\.com/);
    expect(csp).toMatch(/frame-src https:\/\/hcaptcha\.com https:\/\/\*\.hcaptcha\.com/);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline' https:\/\/hcaptcha\.com/);
    expect(csp).not.toMatch(/script-src[^;]*\*(?!\.hcaptcha)/);
  });
  it('sets HSTS only in production', () => {
    const names = (dev: boolean) => securityHeaders({}, dev).map(header => header.key);
    expect(names(false)).toContain('Strict-Transport-Security');
    expect(names(true)).not.toContain('Strict-Transport-Security');
    for (const key of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Content-Security-Policy']) expect(names(false)).toContain(key);
  });
});

describe('JSON-LD serialisation', () => {
  it('cannot be broken out of the script tag by CMS text', () => {
    const out = jsonLd({ description: '</script><script>alert(1)</script>', ls: String.fromCharCode(0x2028) });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c/script>');
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(JSON.parse(out).description).toBe('</script><script>alert(1)</script>');
  });
});

describe('URL validation for CMS-supplied assets', () => {
  it('accepts site paths and https only', () => {
    for (const url of ['/images/a.webp', 'https://cdn.shop.in/a.webp']) expect(safeUrl.safeParse(url).success, url).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.com/x', 'http://insecure.com/a.jpg', 'ftp://x/y', '', 'vbscript:x']) expect(safeUrl.safeParse(url).success, url).toBe(false);
    expect(internalPath.safeParse('/collections/all').success).toBe(true);
    expect(internalPath.safeParse('https://evil.com').success).toBe(false);
    expect(internalPath.safeParse('//evil.com').success).toBe(false);
  });
});

describe('CSV export safety', () => {
  it('neutralises spreadsheet formula injection and escapes quotes', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});
