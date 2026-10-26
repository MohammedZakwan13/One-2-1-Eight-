'use client';

import React from 'react';
import { errorMessage } from '@/lib/api/errors';

/** Consistent loading / error wrapper for admin data screens. */
export function AdminDataState({ isLoading, error, retry, children }: { isLoading: boolean; error: unknown; retry: () => void; children: React.ReactNode }) {
  if (isLoading) return <div className="admin-tab-content"><div className="loading-state" role="status">Loading…</div></div>;
  if (error) return <div className="admin-tab-content"><div className="error-state" role="alert"><p>{errorMessage(error)}</p><button className="admin-primary-btn" onClick={retry}>TRY AGAIN</button></div></div>;
  return <>{children}</>;
}

export const titleCase = (text: string) => text.replace(/_/g, ' ').replace(/^\w/, letter => letter.toUpperCase());
