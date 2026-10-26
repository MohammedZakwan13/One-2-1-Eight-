import { browserTransport } from '@/lib/api/browser-transport';
import { createApi } from '@/lib/api/create-api';
import { createCaller } from '@/lib/api/http';

/** API for Client Components. Talks to the same-origin proxy at /api/v1. */
export const api = createApi(createCaller(browserTransport));
