import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const norm = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const full = join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full]; });

describe('admin numeric inputs ignore the mouse wheel', () => {
  const adminFiles = [...walk('components/admin'), ...walk('app/admin')].filter(file => file.endsWith('.tsx'));

  it('no admin file renders a raw type="number" input except the shared NumberInput', () => {
    const offenders = adminFiles.filter(file => !file.replace(/\\/g, '/').endsWith('components/admin/number-input.tsx') && /<input[^>]*type=(["'{]\s*["']?)number/.test(norm(file)));
    expect(offenders).toEqual([]);
  });
  it('the shared component blurs a focused field on wheel (the page still scrolls) and keeps type="number", min/max/step and the caller\'s onWheel', () => {
    const component = norm('components/admin/number-input.tsx');
    expect(component).toContain('type="number"');
    expect(component).toContain('document.activeElement === event.currentTarget');
    expect(component).toContain('event.currentTarget.blur()');
    expect(component).toContain('onWheel?.(event)');
    expect(component).not.toContain('preventDefault'); // preventing the wheel would stop the page scrolling
  });
  it('Store & SEO: shipping threshold, shipping fee and low-stock threshold use it, with their min/max/step unchanged', () => {
    const settings = norm('components/admin/settings.tsx');
    expect(settings).toContain("import { NumberInput } from '@/components/admin/number-input';");
    expect(settings).toContain('<NumberInput min="0" value={draft.freeShippingThreshold}');
    expect(settings).toContain('<NumberInput min="0" max="1000" step="1" value={draft.lowStockThreshold}');
    expect((settings.match(/<NumberInput\b/g) ?? []).length).toBe(3);
    expect(settings).toContain('shippingFee: Number(e.target.value)');
  });
});
