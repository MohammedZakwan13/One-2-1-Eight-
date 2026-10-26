'use client';

import React, { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowUpRight, ChevronRight, Menu } from 'lucide-react';
import { useRuntimeConfig, useUi } from '@/components/providers/app-providers';
import { AdminSidebar } from '@/components/admin/sidebar';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AdminUser } from '@/lib/api/schemas';

/** One place that maps CMS tabs to isolated /admin/* routes – so the area can later be lifted into its own app. */
export const ADMIN_TABS = {
  overview: '/admin', products: '/admin/products', collections: '/admin/categories', orders: '/admin/orders',
  content: '/admin/content', reviews: '/admin/reviews', leads: '/admin/leads', settings: '/admin/settings',
} as const;
export type AdminTab = keyof typeof ADMIN_TABS;
const TITLES: Record<AdminTab, string> = { overview: 'Dashboard', products: 'Products', collections: 'Categories & edits', orders: 'Orders', content: 'Homepage & banners', reviews: 'Reviews', leads: 'Bulk enquiries', settings: 'Store & SEO' };

const AdminContext = createContext<{ admin: AdminUser; go: (tab: string) => void } | null>(null);
export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin must be used inside AdminShell');
  return value;
}

function tabFor(pathname: string): AdminTab {
  const entries = Object.entries(ADMIN_TABS) as Array<[AdminTab, string]>;
  const match = entries.filter(([tab, href]) => tab !== 'overview' && (pathname === href || pathname.startsWith(`${href}/`))).sort((a, b) => b[1].length - a[1].length)[0];
  return match ? match[0] : 'overview';
}

export function AdminShell({ admin, children }: { admin: AdminUser; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/admin';
  const { notify } = useUi();
  const { mock } = useRuntimeConfig();
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const activeTab = tabFor(pathname);
  const go = (tab: string) => { setMobileSidebar(false); router.push(ADMIN_TABS[tab as AdminTab] ?? '/admin'); };
  const logout = async () => {
    try {
      await api.admin.auth.logout();
    } catch (error) {
      notify(errorMessage(error));
      return;
    }
    notify('You have signed out.');
    router.replace('/admin/login');
    router.refresh();
  };
  const value = useMemo(() => ({ admin, go }), [admin]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AdminContext.Provider value={value}>
      <main className="admin-app">
        <div className={`admin-sidebar-wrap ${mobileSidebar ? 'is-open' : ''}`}><AdminSidebar activeTab={activeTab} setActiveTab={go} onLogout={logout} /></div>
        {mobileSidebar && <button className="admin-mobile-backdrop" aria-label="Close admin menu" onClick={() => setMobileSidebar(false)} />}
        <section className="admin-main">
          <header className="admin-topbar">
            <button className="admin-mobile-menu" onClick={() => setMobileSidebar(!mobileSidebar)} aria-label="Open admin menu"><Menu size={20} /></button>
            <div className="admin-topbar-breadcrumb"><span>WORKSPACE</span><ChevronRight size={13} /><strong>{TITLES[activeTab]}</strong></div>
            <div className="admin-topbar-right"><span className="admin-live-dot" /> <span>Storefront: <strong>{mock ? 'Development mock' : 'Live'}</strong></span><RouteLink href="/" target="_blank" className="admin-view-store"><ArrowUpRight size={15} /> View store</RouteLink><span className="admin-topbar-avatar" title={admin.email}>{(admin.name || admin.email).charAt(0).toUpperCase()}</span></div>
          </header>
          {children}
          <footer className="admin-app-footer"><span>ONE 2 1 EIGHT / COMMERCE STUDIO</span><span>{mock ? 'DEVELOPMENT MOCK' : 'ADMIN CONSOLE'}</span><span>© {new Date().getFullYear()}</span></footer>
        </section>
      </main>
    </AdminContext.Provider>
  );
}
