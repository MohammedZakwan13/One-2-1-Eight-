import type { Metadata } from 'next';

// The admin area is isolated under /admin: own layout, never indexed, no storefront chrome.
export const metadata: Metadata = {
  title: 'Store CMS',
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
