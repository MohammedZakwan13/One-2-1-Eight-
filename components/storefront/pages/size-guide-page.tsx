'use client';

import { ArrowRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';

export function SizeGuidePage() {
  const { settings } = useStorefrontData();
  const { transition: onTransition } = useUi();
  return <><main className="size-guide-page"><div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>Size & fit guide</span></div><span className="eyebrow">FIND YOUR OWN FIT</span><h1>Feel good<br /><em>in your size.</em></h1><p className="size-guide-lede">Use the measurement guide below as a starting point. Fit can vary slightly by garment style, so always check the product’s individual description.</p><div className="size-guide-page-layout"><div className="size-guide-table-wrap"><table className="size-guide-table"><thead><tr><th>SIZE</th><th>CHEST</th><th>SHOULDER</th><th>LENGTH</th></tr></thead><tbody>{[['S', '36–38 in', '16.5 in', '27 in'], ['M', '38–40 in', '17.5 in', '28 in'], ['L', '40–42 in', '18.5 in', '29 in'], ['XL', '42–44 in', '19.5 in', '30 in'], ['XXL', '44–46 in', '20.5 in', '31 in']].map(row => <tr key={row[0]}>{row.map((value, i) => <td key={i}>{value}</td>)}</tr>)}</tbody></table></div><aside className="size-guide-tips"><span className="eyebrow">A FEW GOOD RULES</span><h2>Choose the feel, not just the label.</h2><div><strong>For a closer fit</strong><p>Start with your usual size and compare chest measurements.</p></div><div><strong>For more room</strong><p>Consider sizing up in oversized or drop-shoulder styles if you prefer additional drape.</p></div><div><strong>Still unsure?</strong><p>Contact <a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a> with the product name and your preferred fit.</p></div></aside></div><RouteLink href="/collections/all" className="button button-dark" onClick={onTransition}>SHOP ALL PIECES <ArrowRight size={16} /></RouteLink></main><Footer /></>;
}
