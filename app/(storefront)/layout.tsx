import { connection } from 'next/server';
import { StorefrontShell } from '@/components/storefront/shell';
import { getLegalPage, getStorefront } from '@/lib/api/queries';
import { absoluteUrl, jsonLd } from '@/lib/site';

export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  // Render per request (data is still cached by the fetch layer) so `next build` never depends on the backend being reachable.
  await connection();
  const [{ settings, categories, paymentMethods }, terms, privacy] = await Promise.all([getStorefront(), getLegalPage('terms'), getLegalPage('privacy')]);
  const legalPages = [terms, privacy].filter((page): page is NonNullable<typeof page> => Boolean(page)).map(page => ({ slug: page.slug, title: page.title }));

  const organization = {
    '@context': 'https://schema.org', '@type': 'Organization', name: settings.brandName, url: absoluteUrl('/'),
    email: settings.contactEmail, ...(settings.instagramUrl ? { sameAs: [settings.instagramUrl] } : {}),
  };
  const website = {
    '@context': 'https://schema.org', '@type': 'WebSite', name: settings.brandName, url: absoluteUrl('/'),
    potentialAction: { '@type': 'SearchAction', target: absoluteUrl('/search?q={search_term_string}'), 'query-input': 'required name=search_term_string' },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(organization) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(website) }} />
      <StorefrontShell data={{ settings, categories, paymentMethods, legalPages }}>{children}</StorefrontShell>
    </>
  );
}
