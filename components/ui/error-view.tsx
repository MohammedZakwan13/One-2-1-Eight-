'use client';

import { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';

/** Shared UI for route error boundaries. Never prints error details – only the digest for support lookups. */
export function ErrorView({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[route-error]', error.digest ?? '', error.message); }, [error]);
  return (
    <main className="not-found-page" role="alert">
      <span className="eyebrow">SOMETHING WENT WRONG</span>
      <h1>We hit a<br /><em>snag.</em></h1>
      <p>The store couldn't load this page. Please try again in a moment.</p>
      <button className="button button-dark" onClick={reset}>TRY AGAIN <ArrowRight size={16} /></button>
      {error.digest && <p><small>Reference: {error.digest}</small></p>}
    </main>
  );
}
