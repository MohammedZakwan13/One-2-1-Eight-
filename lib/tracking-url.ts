/** Courier tracking links must be https, free of embedded credentials, and short. Shared by the admin dialog, the API schema and the email renderer. */
export const TRACKING_URL_MAX = 500;

export type TrackingUrlResult = { ok: true; url: string | null } | { ok: false; error: string };

export function parseTrackingUrl(value: string | null | undefined): TrackingUrlResult {
  const text = (value ?? '').trim();
  if (!text) return { ok: true, url: null };
  if (text.length > TRACKING_URL_MAX) return { ok: false, error: `The tracking link must be at most ${TRACKING_URL_MAX} characters.` };
  let parsed: URL;
  try { parsed = new URL(text); } catch { return { ok: false, error: 'Enter a full link starting with https://' }; }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The tracking link must start with https://' };
  if (parsed.username || parsed.password) return { ok: false, error: 'The tracking link must not contain a username or password.' };
  if (!parsed.hostname.includes('.')) return { ok: false, error: 'Enter a valid link, for example https://courier.example/track/123' };
  return { ok: true, url: parsed.toString() };
}

/** For rendering only: the link if it is a safe https URL, otherwise null. */
export const safeTrackingHref = (value: string | null | undefined): string | null => {
  const result = parseTrackingUrl(value);
  return result.ok ? result.url : null;
};
