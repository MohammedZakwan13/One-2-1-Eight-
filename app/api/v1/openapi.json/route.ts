import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** OpenAPI document for the implemented API, with a relative `servers` entry (the container's internal 0.0.0.0 host name must never leak into Swagger). */
export async function GET() {
  if (!getServerEnv().apiDocsEnabled) return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
  const doc = parse(await readFile(path.join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as Record<string, unknown>;
  return Response.json({ ...doc, servers: [{ url: '/api/v1', description: 'This server (relative, so Swagger calls whatever host served the docs)' }] }, { headers: { 'Cache-Control': 'no-store' } });
}
