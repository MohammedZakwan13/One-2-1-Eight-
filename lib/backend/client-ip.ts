import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Client IP for rate limiting. A forwarding header is only evidence of the client's address if the request provably came through a proxy that sets it, so:
 * - client-supplied X-Forwarded-For / X-Real-IP are NEVER used;
 * - mode "cloudflare": CF-Connecting-IP is used only when the request also carries the shared secret header that a Cloudflare Transform Rule adds
 *   (a direct hit on the origin cannot know the secret). `secret: null` skips that proof and is accepted by the env loader in development only;
 * - mode "vercel": Vercel overwrites X-Forwarded-For with the connecting client's address (it does not forward an address supplied by the client or an external proxy). It is
 *   used only when the app provably runs on Vercel (`VERCEL=1`, an environment variable the platform sets; no request header can switch this on or forge it) and the value is
 *   exactly one valid IP. This is meant for DNS pointing straight at Vercel; behind another proxy the header would hold that proxy's address.
 *   x-real-ip and x-vercel-forwarded-for are deliberately NOT read.
 * - mode "none" (or anything unprovable, missing or malformed): the address is UNVERIFIED, and every such request shares ONE rate-limit bucket. The IP limits
 *   stay enforced, so they can neither be bypassed nor silently disabled.
 * Addresses are never logged. IPv4 stays as is, IPv4-mapped IPv6 becomes its IPv4, and other IPv6 addresses are keyed by their /64 (a single subscriber
 * routinely controls a whole /64, so per-address keys could be rotated for free).
 */
export const UNVERIFIED_IP = 'unverified';
export const ORIGIN_SECRET_HEADER = 'x-o218-origin-secret';
export type TrustedProxy = { mode: 'none' } | { mode: 'cloudflare'; secret: string | null } | { mode: 'vercel'; onVercel: boolean };
type HeaderReader = { get(name: string): string | null };

const sameSecret = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const parts = text.slice(colon + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${text.slice(0, colon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(missing).fill('0') : []), ...tail].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

/** A canonical rate-limit key for a literal IP address, or null when it is not one. */
export function normalizeClientIp(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 45 || value.includes('%')) return null;
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) return null;
  const groups = expandV6(value);
  if (!groups) return null;
  if (groups.slice(0, 5).every(n => n === 0) && groups[5] === 0xffff) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `v6:${groups.slice(0, 4).map(n => n.toString(16).padStart(4, '0')).join(':')}`;
}

function vercelClientIp(headers: HeaderReader): string {
  const value = headers.get('x-forwarded-for');
  // Exactly one address: a list means something other than Vercel's overwrite produced the header, so nothing in it is vouched for.
  if (!value || value.includes(',')) return UNVERIFIED_IP;
  return normalizeClientIp(value) ?? UNVERIFIED_IP;
}

export function resolveClientIp(headers: HeaderReader, proxy: TrustedProxy): string {
  if (proxy.mode === 'vercel') return proxy.onVercel ? vercelClientIp(headers) : UNVERIFIED_IP;
  if (proxy.mode !== 'cloudflare') return UNVERIFIED_IP;
  if (proxy.secret !== null) {
    const proof = headers.get(ORIGIN_SECRET_HEADER);
    if (!proof || !sameSecret(proof, proxy.secret)) return UNVERIFIED_IP;
  }
  const claimed = headers.get('cf-connecting-ip');
  return (claimed && normalizeClientIp(claimed)) || UNVERIFIED_IP;
}
