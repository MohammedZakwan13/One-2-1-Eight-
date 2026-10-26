import 'server-only';
import { getServerEnv } from '@/lib/env';

export const BRAND_NAME = 'ONE 2 1 EIGHT';

/** Canonical origin from validated configuration. Never a placeholder in production (see lib/env.ts). */
export const getSiteUrl = () => getServerEnv().siteUrl;
export const absoluteUrl = (path: string) => `${getSiteUrl()}${path.startsWith('/') ? path : `/${path}`}`;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Serialises JSON-LD safely for an inline <script>: `<` is escaped so CMS text can never close the tag. */
export const jsonLd = (data: unknown) =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');

export const titleCase = (text: string) => text.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
