'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toast } from '@/components/ui/toast';


type UiContextValue = { notify: (message: string) => void; transition: () => void };
const UiContext = createContext<UiContextValue>({ notify: () => undefined, transition: () => undefined });
export const useUi = () => useContext(UiContext);

/** Lets the storefront shell provide the page-transition hook without the admin area needing it. */
export const TransitionProvider = ({ transition, children }: { transition: () => void; children: React.ReactNode }) => {
  const parent = useContext(UiContext);
  const value = useMemo(() => ({ notify: parent.notify, transition }), [parent.notify, transition]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // The API layer already retries idempotent reads with backoff; avoid retry storms on top of it.
      queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 2600);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const ui = useMemo<UiContextValue>(() => ({ notify, transition: () => undefined }), [notify]);

  return (
    <QueryClientProvider client={queryClient}>
        <UiContext.Provider value={ui}>
          {children}
          <Toast message={toast} />
        </UiContext.Provider>
    </QueryClientProvider>
  );
}
