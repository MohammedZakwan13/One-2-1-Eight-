'use client';

/** Last-resort boundary (errors in the root layout). Intentionally self-contained: no providers, no CSS dependencies. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-IN">
      <body style={{ fontFamily: 'Arial, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100vh', margin: 0, textAlign: 'center', padding: 24 }}>
        <div role="alert">
          <h1 style={{ fontSize: 22 }}>The store is unavailable right now.</h1>
          <p>Please try again in a moment.</p>
          <button onClick={reset} style={{ padding: '10px 18px', cursor: 'pointer' }}>Try again</button>
          {error.digest && <p style={{ fontSize: 12, opacity: 0.6 }}>Reference: {error.digest}</p>}
        </div>
      </body>
    </html>
  );
}
