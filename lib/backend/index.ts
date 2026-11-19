import 'server-only';
import '@/lib/backend/routes/storefront';
import '@/lib/backend/routes/admin';
import '@/lib/backend/routes/hero-banners';

export { handleBackendRequest, backendRoutes } from '@/lib/backend/core';
