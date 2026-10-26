'use client';

import { ErrorView } from '@/components/ui/error-view';

export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView {...props} />;
}
