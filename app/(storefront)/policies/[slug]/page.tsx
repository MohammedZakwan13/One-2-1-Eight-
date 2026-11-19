import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Footer } from '@/components/storefront/footer';
import { RouteLink } from '@/components/ui/route-link';
import { getLegalPage } from '@/lib/api/queries';
import { linkifyText, toParagraphs } from '@/lib/format';

type Props = { params: Promise<{ slug: string }> };

const SLUG = /^[a-z0-9-]{1,60}$/;

/** Legal pages (terms, privacy, …) are authored in the backend CMS. Nothing is invented here: no CMS page → 404. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = SLUG.test(slug) ? await getLegalPage(slug) : null;
  return page ? { title: page.title, alternates: { canonical: `/policies/${slug}` } } : { title: 'Not found', robots: { index: false } };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const page = await getLegalPage(slug);
  if (!page) notFound();
  return <>
    <main className="policy-page">
      <div className="breadcrumbs"><RouteLink href="/">Home</RouteLink><span>/</span><span>{page.title}</span></div>
      <span className="eyebrow">THE DETAILS MATTER</span>
      <h1>{page.title}</h1>
      <div className="policy-lede">{toParagraphs(page.body).map((paragraph, index) => <p key={index}>{linkifyText(paragraph).map((part, i) => part.href ? <a key={i} href={part.href} {...(part.href.startsWith('https://') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{part.text}</a> : part.text)}</p>)}</div>
      <p className="policy-lede"><small>Last updated {new Date(page.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</small></p>
    </main>
    <Footer />
  </>;
}
