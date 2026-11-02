import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Swagger UI. Assets are served from /swagger (copied from swagger-ui-dist by scripts/copy-swagger.mjs), so no third-party CDN is needed. */
export function GET() {
  if (!getServerEnv().apiDocsEnabled) return new Response('Not found', { status: 404 });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>ONE 2 1 EIGHT API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/swagger/swagger-ui-bundle.js"></script><script src="/swagger/init.js"></script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
