export const money = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

export const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Splits plain-text CMS copy into paragraphs. Content is rendered as text nodes only (never as HTML). */
export const toParagraphs = (text: string) => text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);

export type TextSegment = { text: string; href?: string };
const LINK_PATTERN = /https:\/\/[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Splits plain CMS text into text and link segments. Only https:// URLs and email addresses become links (mailto: for emails); trailing punctuation stays text. No HTML or Markdown is interpreted. */
export function linkifyText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const value = match[0].replace(/[.,;:!?)\]]+$/, '');
    const start = match.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: value, href: value.startsWith('https://') ? value : `mailto:${value}` });
    last = start + value.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

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

/** `mailto:` link for "Contact us about this order": the order number is in the subject and the first lines of the body. Null when no contact email is configured. */
export function orderContactMailto(contactEmail: string | null | undefined, orderNumber: string): string | null {
  const base = formatEmailUrl(contactEmail);
  if (!base) return null;
  const subject = `Order ${orderNumber}`;
  const body = ['Hi ONE 2 1 EIGHT team,', '', `I need help with order ${orderNumber}.`, '', ''].join('\n');
  return `${base}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

/**
 * Generates the Returns & Exchanges policy content dynamically based on product returnable/exchangeable settings.
 * Purely product-level policy: does NOT include store shipping copy.
 */
export function formatProductReturnExchangePolicy(
  product: { returnable?: boolean; exchangeable?: boolean },
  settings: { returnPolicy?: string }
): string {
  const isReturnable = product.returnable !== false;
  const isExchangeable = product.exchangeable !== undefined ? product.exchangeable : isReturnable;

  if (isReturnable && isExchangeable) {
    const policy = settings.returnPolicy ? ` ${settings.returnPolicy}` : '';
    return `Eligible for returns and size/colour exchanges.${policy}`;
  }
  if (isReturnable && !isExchangeable) {
    const policy = settings.returnPolicy ? ` ${settings.returnPolicy}` : '';
    return `Eligible for returns only (exchanges are not offered for this product).${policy}`;
  }
  if (!isReturnable && isExchangeable) {
    return 'Eligible for size and colour exchanges only within 7 days of delivery. This product is non-returnable and cannot be returned once delivered. Items must be unworn, unwashed and in their original packaging.';
  }
  return 'This product is non-returnable and non-exchangeable.';
}

/**
 * Generates the Storefront Shipping policy content.
 * Purely storefront shipping copy: independent of product return/exchange flags.
 */
export function formatStoreShippingPolicy(settings: { freeShippingThreshold?: number }): string {
  const threshold = settings.freeShippingThreshold ?? 1499;
  return `Complimentary shipping over ₹${threshold.toLocaleString('en-IN')}. Delivery timelines shown after a valid pincode check are estimates.`;
}

/**
 * Generates combined Shipping & Returns policy content (backward compatible).
 */
export function formatProductShippingPolicy(
  product: { returnable?: boolean; exchangeable?: boolean },
  settings: { returnPolicy?: string; freeShippingThreshold?: number }
): string {
  const ret = formatProductReturnExchangePolicy(product, settings);
  const ship = formatStoreShippingPolicy(settings);
  return `${ret} ${ship}`;
}

/**
 * Returns a concise trust badge string reflecting product return and exchange eligibility.
 */
export function formatProductPolicyBadge(product: { returnable?: boolean; exchangeable?: boolean }): string {
  const isReturnable = product.returnable !== false;
  const isExchangeable = product.exchangeable !== undefined ? product.exchangeable : isReturnable;
  if (isReturnable && isExchangeable) return 'Easy returns & exchanges';
  if (isReturnable && !isExchangeable) return 'Easy returns';
  if (!isReturnable && isExchangeable) return 'Exchanges only';
  return 'Non-returnable, non-exchangeable';
}

/**
 * Returns customer-facing payment eligibility text for a product.
 */
export function formatProductPaymentNote(product: { codEnabled?: boolean; onlinePaymentEnabled?: boolean }): string {
  const cod = product.codEnabled !== false;
  const online = product.onlinePaymentEnabled !== false;
  if (cod && online) return 'Cash on delivery & online payment available';
  if (cod && !online) return 'Cash on delivery only';
  if (!cod && online) return 'Online payment only (Cash on delivery unavailable)';
  return 'Currently unavailable for purchase';
}
