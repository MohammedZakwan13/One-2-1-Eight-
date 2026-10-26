import 'server-only';
import { cache } from 'react';
import { serverApi } from '@/lib/api/server';

/**
 * Request-scoped (React `cache`) wrappers so `generateMetadata`, layouts and pages that need the
 * same record trigger a single upstream call per render.
 */
export const getStorefront = cache(() => serverApi.content.storefront());
export const getProduct = cache((slug: string) => serverApi.catalog.getProduct(slug));
export const getCollections = cache(() => serverApi.catalog.listCollections());
export const getCategories = cache(() => serverApi.catalog.listCategories());
export const getLegalPage = cache((slug: string) => serverApi.content.page(slug));
