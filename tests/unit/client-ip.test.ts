import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv } from '@/lib/env';
import { ORIGIN_SECRET_HEADER, UNVERIFIED_IP, normalizeClientIp, resolveClientIp, type TrustedProxy } from '@/lib/backend/client-ip';

const SECRET = 'origin-secret-0123456789-abcdef';
const cloudflare: TrustedProxy = { mode: 'cloudflare', secret: SECRET };
const headers = (values: Record<string, string>) => new Headers(values);
const supabase = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' };

describe('trusted client IP resolution', () => {
  it('uses CF-Connecting-IP when the request carries the Cloudflare origin secret', () => {
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: SECRET }), cloudflare)).toBe('203.0.113.7');
  });
  it('ignores a spoofed X-Forwarded-For / X-Real-IP: the verified CF address wins, and without proof nothing is used', () => {
    const spoof = { 'x-forwarded-for': '198.51.100.99, 10.0.0.1', 'x-real-ip': '198.51.100.99' };
    expect(resolveClientIp(headers({ ...spoof, 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: SECRET }), cloudflare)).toBe('203.0.113.7');
    expect(resolveClientIp(headers(spoof), cloudflare)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers(spoof), { mode: 'none' })).toBe(UNVERIFIED_IP);
  });
  it('a direct request to the origin cannot forge CF-Connecting-IP: missing or wrong secret is unverified', () => {
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7' }), cloudflare)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: 'wrong' }), cloudflare)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: SECRET.slice(0, -1) }), cloudflare)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: SECRET }), { mode: 'none' })).toBe(UNVERIFIED_IP);
  });
  it('fails safe (shared unverified bucket, never an open limit) for missing or malformed trusted headers', () => {
    const proven = { [ORIGIN_SECRET_HEADER]: SECRET };
    for (const bad of ['', '   ', 'not-an-ip', '203.0.113.7, 198.51.100.1', '203.0.113', '256.1.1.1', '1.2.3.4:5678', 'fe80::1%eth0', '::g', '1:2:3:4:5:6:7:8:9', '203.0.113.7\\nX: y']) {
      expect(resolveClientIp(headers({ ...proven, 'cf-connecting-ip': bad }), cloudflare)).toBe(UNVERIFIED_IP);
    }
    expect(resolveClientIp(headers(proven), cloudflare)).toBe(UNVERIFIED_IP);
    expect(UNVERIFIED_IP).not.toBe('');
  });
  it('handles IPv4 and IPv6: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 keyed by its /64 in canonical form', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(normalizeClientIp('2001:db8:abcd:12::1')).toBe('v6:2001:0db8:abcd:0012');
    // Same /64, different spellings and interface identifiers: one bucket.
    expect(normalizeClientIp('2001:DB8:ABCD:12:0:0:0:9')).toBe('v6:2001:0db8:abcd:0012');
    expect(normalizeClientIp('2001:db8:abcd:12:ffff:ffff:ffff:ffff')).toBe('v6:2001:0db8:abcd:0012');
    // A different /64 is a different bucket.
    expect(normalizeClientIp('2001:db8:abcd:13::1')).not.toBe(normalizeClientIp('2001:db8:abcd:12::1'));
    expect(normalizeClientIp('::1')).toBe('v6:0000:0000:0000:0000');
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '2001:db8:abcd:12::1', [ORIGIN_SECRET_HEADER]: SECRET }), cloudflare)).toBe('v6:2001:0db8:abcd:0012');
  });
  it('without a configured secret (development only) the Cloudflare header is used as given, still validated', () => {
    const dev: TrustedProxy = { mode: 'cloudflare', secret: null };
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7' }), dev)).toBe('203.0.113.7');
    expect(resolveClientIp(headers({ 'cf-connecting-ip': 'junk' }), dev)).toBe(UNVERIFIED_IP);
  });
});

describe('trusted proxy configuration', () => {
  it('defaults to none and exposes the proxy mode and secret only when configured', () => {
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase }).trustedProxy).toEqual({ mode: 'none' });
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase, TRUSTED_PROXY: 'cloudflare' }).trustedProxy).toEqual({ mode: 'cloudflare', secret: null });
    expect(parseServerEnv({ APP_ENV: 'staging', NEXT_PUBLIC_SITE_URL: 'https://staging.shop.in', ...supabase, TRUSTED_PROXY: 'cloudflare', TRUSTED_PROXY_SECRET: SECRET }).trustedProxy).toEqual({ mode: 'cloudflare', secret: SECRET });
  });
  it('requires the origin secret for Cloudflare outside development, and a trusted proxy in production', () => {
    expect(() => parseServerEnv({ APP_ENV: 'staging', NEXT_PUBLIC_SITE_URL: 'https://staging.shop.in', ...supabase, TRUSTED_PROXY: 'cloudflare' })).toThrow(/TRUSTED_PROXY_SECRET/);
    expect(() => parseServerEnv({ APP_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in', ...supabase })).toThrow(/TRUSTED_PROXY/);
    expect(() => parseServerEnv({ APP_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in', ...supabase, TRUSTED_PROXY: 'cloudflare' })).toThrow(EnvError);
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, TRUSTED_PROXY: 'cloudflare', TRUSTED_PROXY_SECRET: 'short' })).toThrow(EnvError);
  });
});

describe('the backend never reads client forwarding headers', () => {
  it('no source under lib/backend or the API routes reads x-forwarded-for or x-real-ip to identify a client', () => {
    const roots = ['lib/backend', 'lib/api'];
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (/\.tsx?$/.test(entry.name)) files.push(path); } };
    roots.forEach(walk);
    for (const file of files.filter(f => !f.endsWith('client-ip.ts'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/headers\.get\(\s*['"]x-(forwarded-for|real-ip)['"]/i);
  });
});

describe('Vercel trusted client IP', () => {
  const vercel: TrustedProxy = { mode: 'vercel', onVercel: true };
  const offVercel: TrustedProxy = { mode: 'vercel', onVercel: false };

  it('uses the single address in the X-Forwarded-For that Vercel sets', () => {
    expect(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), vercel)).toBe('203.0.113.7');
    expect(resolveClientIp(headers({ 'x-forwarded-for': '  203.0.113.7  ' }), vercel)).toBe('203.0.113.7');
  });
  it('keeps IPv4-mapped IPv6 as IPv4 and keys other IPv6 by /64', () => {
    expect(resolveClientIp(headers({ 'x-forwarded-for': '::ffff:203.0.113.7' }), vercel)).toBe('203.0.113.7');
    expect(resolveClientIp(headers({ 'x-forwarded-for': '2001:db8:abcd:12::1' }), vercel)).toBe('v6:2001:0db8:abcd:0012');
    expect(resolveClientIp(headers({ 'x-forwarded-for': '2001:DB8:ABCD:12:ffff:ffff:ffff:ffff' }), vercel)).toBe('v6:2001:0db8:abcd:0012');
  });
  it('never reads X-Real-IP or X-Vercel-Forwarded-For, alone or next to a valid X-Forwarded-For', () => {
    const others = { 'x-real-ip': '198.51.100.99', 'x-vercel-forwarded-for': '198.51.100.98', 'cf-connecting-ip': '198.51.100.97', [ORIGIN_SECRET_HEADER]: SECRET };
    expect(resolveClientIp(headers(others), vercel)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers({ ...others, 'x-forwarded-for': '203.0.113.7' }), vercel)).toBe('203.0.113.7');
  });
  it('without runtime proof (not running on Vercel) no header is trusted, however well formed', () => {
    const forged = { 'x-forwarded-for': '203.0.113.7', 'x-vercel-id': 'bom1::abc', 'x-vercel-deployment-url': 'x.vercel.app', 'x-vercel-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7' };
    expect(resolveClientIp(headers(forged), offVercel)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers(forged), { mode: 'none' })).toBe(UNVERIFIED_IP);
  });
  it('request headers cannot switch a mode on: Cloudflare mode ignores X-Forwarded-For and Vercel markers', () => {
    expect(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7', 'x-vercel-id': 'bom1::abc' }), cloudflare)).toBe(UNVERIFIED_IP);
    expect(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7', 'x-vercel-id': 'bom1::abc' }), { mode: 'none' })).toBe(UNVERIFIED_IP);
  });
  it('fails safe to the shared bucket for missing, list-valued or malformed values', () => {
    expect(resolveClientIp(headers({}), vercel)).toBe(UNVERIFIED_IP);
    for (const bad of ['', '   ', 'not-an-ip', '203.0.113.7, 198.51.100.1', '198.51.100.1, 203.0.113.7', ',203.0.113.7', '203.0.113', '256.1.1.1', '1.2.3.4:5678', '[2001:db8::1]', 'fe80::1%eth0', '::g', '1:2:3:4:5:6:7:8:9', '203.0.113.7;x', '203.0.113.7 evil', 'a'.repeat(300)]) {
      expect(resolveClientIp(headers({ 'x-forwarded-for': bad }), vercel), JSON.stringify(bad)).toBe(UNVERIFIED_IP);
    }
  });
  it('the Cloudflare behaviour is unchanged', () => {
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7', [ORIGIN_SECRET_HEADER]: SECRET }), cloudflare)).toBe('203.0.113.7');
    expect(resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.7' }), cloudflare)).toBe(UNVERIFIED_IP);
  });
  it('the resolver source reads X-Forwarded-For only, never x-real-ip or x-vercel-forwarded-for', () => {
    const source = readFileSync('lib/backend/client-ip.ts', 'utf8');
    expect(source).not.toMatch(/\.get\(\s*['"]x-(real-ip|vercel-forwarded-for)['"]/i);
  });
});

describe('Vercel trusted proxy configuration', () => {
  const prod = { APP_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in', ...supabase, TRUSTED_PROXY: 'vercel' };
  it('is active only when the platform sets VERCEL=1; otherwise it parses but is inert', () => {
    expect(parseServerEnv({ ...prod, VERCEL: '1' }).trustedProxy).toEqual({ mode: 'vercel', onVercel: true });
    expect(parseServerEnv(prod).trustedProxy).toEqual({ mode: 'vercel', onVercel: false });
    for (const value of ['0', 'true', 'yes', ' 1', '']) expect(parseServerEnv({ ...prod, VERCEL: value }).trustedProxy, JSON.stringify(value)).toEqual({ mode: 'vercel', onVercel: false });
  });
  it('needs no secret, and production still refuses TRUSTED_PROXY=none', () => {
    expect(() => parseServerEnv({ ...prod, VERCEL: '1' })).not.toThrow();
    expect(() => parseServerEnv({ ...prod, TRUSTED_PROXY: 'none', VERCEL: '1' })).toThrow(/TRUSTED_PROXY/);
    expect(() => parseServerEnv({ ...prod, TRUSTED_PROXY: undefined, VERCEL: '1' })).toThrow(/TRUSTED_PROXY/);
    expect(() => parseServerEnv({ ...prod, TRUSTED_PROXY: 'netlify' })).toThrow(EnvError);
  });
  it('Cloudflare still requires its origin secret outside development', () => {
    expect(() => parseServerEnv({ ...prod, TRUSTED_PROXY: 'cloudflare', VERCEL: '1' })).toThrow(/TRUSTED_PROXY_SECRET/);
  });
});
