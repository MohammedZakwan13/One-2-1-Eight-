import 'server-only';
import { createApi } from '@/lib/api/create-api';
import { createCaller } from '@/lib/api/http';
import { serverTransport } from '@/lib/api/server-transport';

/** API for Server Components, metadata, sitemap and route handlers. */
export const serverApi = createApi(createCaller(serverTransport));
