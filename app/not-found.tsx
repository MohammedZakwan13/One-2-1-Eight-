import Link from 'next/link';

/** Root-level 404 (admin area and anything outside the storefront group). */
export default function NotFound() {
  return <main className="not-found-page"><span className="eyebrow">404 / OFF THE MAP</span><h1>This page took<br /><em>a different route.</em></h1><Link href="/" className="button button-dark">BACK TO THE STORE</Link></main>;
}
