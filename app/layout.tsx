import type { Metadata, Viewport } from 'next';
import { DM_Sans, Manrope } from 'next/font/google';
import './globals.css';
import { AppProviders } from '@/components/providers/app-providers';
import { getServerEnv } from '@/lib/env';
import { BRAND_NAME } from '@/lib/site';

const dmSans = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-dm-sans', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-manrope', display: 'swap' });

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
