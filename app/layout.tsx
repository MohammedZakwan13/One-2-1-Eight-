import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AppProviders } from '@/components/providers/app-providers';
import { getServerEnv } from '@/lib/env';
import { BRAND_NAME } from '@/lib/site';

const dmSans = localFont({
  src: [
    { path: './fonts/dm-sans-400.ttf', weight: '400', style: 'normal' },
    { path: './fonts/dm-sans-500.ttf', weight: '500', style: 'normal' },
    { path: './fonts/dm-sans-600.ttf', weight: '600', style: 'normal' },
    { path: './fonts/dm-sans-700.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-dm-sans',
  display: 'swap',
});

const manrope = localFont({
  src: [
    { path: './fonts/manrope-400.ttf', weight: '400', style: 'normal' },
    { path: './fonts/manrope-500.ttf', weight: '500', style: 'normal' },
    { path: './fonts/manrope-600.ttf', weight: '600', style: 'normal' },
    { path: './fonts/manrope-700.ttf', weight: '700', style: 'normal' },
    { path: './fonts/manrope-800.ttf', weight: '800', style: 'normal' },
  ],
  variable: '--font-manrope',
  display: 'swap',
});

// Fails fast on unsafe configuration (placeholder domain, missing Supabase keys…).
const env = getServerEnv();

export const metadata: Metadata = {
  metadataBase: new URL(env.siteUrl),
  title: { default: BRAND_NAME, template: `%s | ${BRAND_NAME}` },
  applicationName: BRAND_NAME,
  // Staging and development must never be indexed.
  robots: env.isProduction ? { index: true, follow: true } : { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#080808' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={`${dmSans.variable} ${manrope.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
