'use client';

import { ArrowUpRight, ChevronDown, CircleHelp, Filter, LogOut, Mail, PackageCheck, ShieldCheck, Shirt, SlidersHorizontal, Sparkles, Star } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';

export function AdminSidebar({ activeTab, setActiveTab, onLogout }: { activeTab: string; setActiveTab: (tab: string) => void; onLogout: () => void }) {
  const groups = [
    { title: 'OVERVIEW', items: [{ id: 'overview', label: 'Dashboard', icon: 'dashboard' }] },
    { title: 'SELLING', items: [{ id: 'products', label: 'Products', icon: 'products' }, { id: 'collections', label: 'Categories & edits', icon: 'collections' }, { id: 'orders', label: 'Orders', icon: 'orders' }] },
    { title: 'STOREFRONT', items: [{ id: 'content', label: 'Homepage & banners', icon: 'content' }, { id: 'reviews', label: 'Reviews', icon: 'reviews' }, { id: 'leads', label: 'Bulk enquiries', icon: 'leads' }] },
    { title: 'CONFIGURATION', items: [{ id: 'settings', label: 'Store & SEO', icon: 'settings' }] },
  ];
  const pickIcon = (name: string) => name === 'dashboard' ? <SlidersHorizontal size={17} /> : name === 'products' ? <Shirt size={17} /> : name === 'collections' ? <Filter size={17} /> : name === 'orders' ? <PackageCheck size={17} /> : name === 'content' ? <Sparkles size={17} /> : name === 'reviews' ? <Star size={17} /> : name === 'leads' ? <Mail size={17} /> : <ShieldCheck size={17} />;
  return <aside className="admin-sidebar"><div className="admin-sidebar-brand"><BrandMark small /><span className="admin-pill">CMS / 01</span></div><div className="admin-sidebar-store"><div className="store-avatar">1218</div><div><strong>1218 Commerce</strong><span>Store workspace</span></div><ChevronDown size={15} /></div><nav>{groups.map(group => <div className="admin-nav-group" key={group.title}><span className="admin-nav-label">{group.title}</span>{group.items.map(item => <button key={item.id} className={activeTab === item.id ? 'active' : ''} onClick={() => setActiveTab(item.id)}>{pickIcon(item.icon)}<span>{item.label}</span>{item.id === 'leads' && <i className="nav-count">•</i>}</button>)}</div>)}</nav><div className="admin-sidebar-bottom"><div className="admin-help-card"><CircleHelp size={18} /><div><strong>Need a hand?</strong><span>Help centre & support</span></div><ArrowUpRight size={14} /></div><button className="admin-logout" onClick={onLogout}><LogOut size={16} /> Sign out</button><div className="admin-user"><span className="admin-user-avatar">A</span><div><strong>Store Admin</strong><span>Administrator</span></div><ChevronDown size={15} /></div></div></aside>;
}
