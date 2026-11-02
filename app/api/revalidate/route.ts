import { createHash, timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { clearServerCache } from '@/lib/api/server-transport';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backend → frontend cache purge. Call after catalogue / content changes:
 *
 *   POST /api/revalidate
 *   x-revalidate-secret: <REVALIDATE_SECRET>
 *   { "tags": ["products", "product:essential-box-fit-tee-black", "content"] }
 *
 * Tags used by the data layer: `products`, `product:<slug>`, `reviews:<slug>`, `content`, `page:<slug>`.
 */
const bodySchema = z.object({ tags: z.array(z.string().regex(/^[a-z]+(?::[A-Za-z0-9_-]+)?$/)).min(1).max(20) });
const digest = (value: string) => createHash('sha256').update(value).digest();

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const { revalidateSecret } = getServerEnv();
  if (!revalidateSecret) return Response.json({ error: { code: 'disabled', message: 'Revalidation is not configured.' } }, { status: 503, headers });

  const provided = request.headers.get('x-revalidate-secret') ?? '';
  if (!timingSafeEqual(digest(provided), digest(revalidateSecret))) {
    return Response.json({ error: { code: 'unauthorized', message: 'Unauthorized.' } }, { status: 401, headers });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { code: 'validation_failed', message: 'Provide { "tags": [...] }.' } }, { status: 422, headers });

  for (const tag of parsed.data.tags) revalidateTag(tag);
  clearServerCache();
  return Response.json({ revalidated: parsed.data.tags }, { headers });
}
