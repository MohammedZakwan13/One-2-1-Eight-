import 'server-only';
import '@/lib/backend/routes/storefront';
import '@/lib/backend/routes/admin';

export { handleBackendRequest, backendRoutes } from '@/lib/backend/core';
