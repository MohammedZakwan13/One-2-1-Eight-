export const money = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

export const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Splits plain-text CMS copy into paragraphs. Content is rendered as text nodes only (never as HTML). */
export const toParagraphs = (text: string) => text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);

/**
 * Normalises an email address for mailto: links.
 * Returns null when missing, blank or not containing an @ symbol.
 */
export function formatEmailUrl(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim();
  if (!trimmed || !trimmed.includes('@')) return null;
  return `mailto:${trimmed}`;
}

/**
 * Normalises phone number for telephone click-to-call links (`tel:`).
 * Preserves leading `+` and digits, stripping spaces, brackets and hyphens.
 * Returns null when empty or lacking sufficient digits.
 */
export function formatPhoneTel(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 5) return null;
  return `tel:${cleaned}`;
}

/**
 * Constructs a WhatsApp click-to-chat URL (`https://wa.me/<digits>`) from Admin WhatsApp input.
 * - Strips spaces, plus signs, brackets and hyphens.
 * - If 10 digits (standard Indian mobile), prepends '91'.
 * - If the number already starts with '91', does not duplicate it.
 * - Returns null when missing or less than 10 digits.
 */
export function formatWhatsAppUrl(whatsapp: string | null | undefined): string | null {
  if (!whatsapp || typeof whatsapp !== 'string') return null;
  const digits = whatsapp.replace(/\D/g, '');
  if (!digits || digits.length < 10) return null;
  const finalDigits = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${finalDigits}`;
}

/**
 * Validates and normalises an HTTPS Instagram profile URL.
 * - Rejects unsafe schemes (`javascript:`, `data:`, etc.) and insecure `http:`.
 * - Validates host is `instagram.com`, `www.instagram.com`, or subdomains.
 * - Requires a profile handle/path (rejects bare `/`).
 * - Returns null when missing or invalid.
 */
export function formatInstagramUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com' && !hostname.endsWith('.instagram.com')) {
      return null;
    }
    const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
