'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Search, X } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';

export function SearchOverlay({ open, close, onTransition }: { open: boolean; close: () => void; onTransition: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) setQuery(''); }, [open]);
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    close(); onTransition(); router.push(`/search?q=${encodeURIComponent(query.trim())}`);
  };
  return <div className="overlay-layer overlay-search" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="search-panel" aria-label="Search products">
      <div className="search-panel-head"><BrandMark small /><button className="icon-button" onClick={close} aria-label="Close search"><X /></button></div>
      <form className="search-field-large" onSubmit={submit}><Search size={22} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tees, layers, fits..." aria-label="Search products" /><button type="submit" aria-label="Submit search"><ArrowRight /></button></form>
      <div className="search-suggestions"><span className="eyebrow">TRENDING RIGHT NOW</span><div>{['Box fit T-shirts', 'Polo', 'Hoodie', 'Drop Shoulder', 'Luxe edit'].map(label => <button key={label} onClick={() => { setQuery(label); close(); onTransition(); router.push(`/search?q=${encodeURIComponent(label)}`); }}>{label}<ArrowUpRight size={14} /></button>)}</div></div>
    </section>
  </div>;
}
