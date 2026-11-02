'use client';

import React, { createContext, useContext } from 'react';
import type { Category, PaymentMethod, StoreSettings } from '@/lib/api/schemas';

/** Site-wide CMS data fetched on the server once per request/cache window and shared with client chrome (header, footer, menus). */
export type StorefrontData = {
  settings: StoreSettings;
  categories: Category[];
  paymentMethods: PaymentMethod[];
  /** Legal pages that actually exist in the CMS (e.g. terms, privacy) – links are only rendered for these. */
  legalPages: { slug: string; title: string }[];
};
const StorefrontDataContext = createContext<StorefrontData | null>(null);

export function StorefrontDataProvider({ value, children }: { value: StorefrontData; children: React.ReactNode }) {
  return <StorefrontDataContext.Provider value={value}>{children}</StorefrontDataContext.Provider>;
}

export function useStorefrontData(): StorefrontData {
  const value = useContext(StorefrontDataContext);
  if (!value) throw new Error('useStorefrontData must be used inside the storefront layout');
  return value;
}
