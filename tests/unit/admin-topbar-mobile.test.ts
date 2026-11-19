import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('app/globals.css', 'utf8').replace(/\r\n/g, '\n');
const block = css.slice(css.indexOf('/* Admin top bar on phones'));
const shell = readFileSync('components/admin/admin-shell.tsx', 'utf8');

describe('admin top bar on phones', () => {
  it('is a two-row layout scoped to phone widths only (tablet and desktop rules are not touched)', () => {
    expect(block).toMatch(/^\/\* Admin top bar on phones[^\n]*\n@media \(max-width: 760px\) \{/);
    expect(block).toContain('.admin-app .admin-topbar { flex-wrap: wrap;');
    expect(block).toContain('.admin-app .admin-topbar-right { order: 3; flex: 1 1 100%;'); // status + View store drop to their own row
    expect(block).toContain('.admin-app .admin-topbar-breadcrumb { flex: 1 1 0; min-width: 0; }'); // the title shares row one with the menu button
  });
  it('has accessible touch targets and wraps long titles instead of clipping them', () => {
    expect(block).toContain('.admin-app .admin-mobile-menu { flex: 0 0 44px; width: 44px; height: 44px; }');
    expect(block).toContain('min-height: 40px');
    expect(block).toContain('overflow-wrap: anywhere');
  });
  it('keeps the existing markup and behaviour: menu button, title, status and View store link are unchanged', () => {
    expect(shell).toContain('onClick={() => setMobileSidebar(!mobileSidebar)} aria-label="Open admin menu"');
    expect(shell).toContain('<span>Storefront: <strong>Live</strong></span>');
    expect(shell).toContain('className="admin-view-store"');
  });
});
