'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/admin/confirm-dialog';
import { SizeGuideTable } from '@/components/ui/size-guide-table';
import {
  SIZE_GUIDE_LIMITS, SIZE_GUIDE_TEMPLATES, SIZE_GUIDE_UNITS, SIZE_GUIDE_UNIT_LABEL, nextColumnKey, pruneValues, sizeGuideFromTemplate, sizeGuideProblems, suggestTemplate,
  type SizeGuide, type SizeGuideTemplateId, type SizeGuideUnit,
} from '@/lib/size-guide';

type Props = {
  guide: SizeGuide | null;
  /** True when the product already has a guide saved on the server (so "Remove" is a real deletion, not just discarding an unsaved draft). */
  savedExists: boolean;
  removed: boolean;
  /** The product's current category: only used to SUGGEST a starter template. */
  category: { slug?: string | null; name?: string | null } | null;
  onEdit: (next: SizeGuide) => void;
  onRemove: () => void;
};

/**
 * Admin "Size Guide / Measurements" section. Customer-facing garment measurements only: it has no connection to the product's
 * inventory sizes, SKUs or stock, and nothing here can change them.
 */
export function SizeGuideEditor({ guide, savedExists, removed, category, onEdit, onRemove }: Props) {
  const confirm = useConfirm();
  const [preview, setPreview] = useState(false);
  const [moreLayouts, setMoreLayouts] = useState(false);
  // The category only decides which layout is offered first. Changing it never touches a guide or any measurement.
  const suggested = suggestTemplate(category);
  const suggestedLabel = SIZE_GUIDE_TEMPLATES.find(item => item.id === suggested)?.label ?? '';

  // Layouts exist only while the product has no guide: they add column names and sizes with every measurement empty, so there is nothing to overwrite.
  const start = (id: SizeGuideTemplateId) => onEdit(sizeGuideFromTemplate(id));
  const askRemove = () => confirm({
    title: 'Remove this size guide?',
    message: savedExists ? 'Customers will see the generic size guide for this product again. The guide is deleted when you save the product. Inventory is not affected.' : 'The unsaved guide is discarded.',
    confirmLabel: 'Remove guide', onConfirm: () => { onRemove(); setPreview(false); setMoreLayouts(false); },
  });

  const edit = (changes: Partial<SizeGuide>) => guide && onEdit(pruneValues({ ...guide, ...changes }));
  // Removing a column that already has measurements asks first; an empty column goes straight away.
  const removeColumn = (key: string, label: string) => {
    if (!guide) return;
    const remove = () => edit({ columns: guide.columns.filter(item => item.key !== key) });
    if (guide.rows.some(row => (row.values[key] ?? '').trim())) {
      confirm({ title: 'Remove this column?', message: `"${label || 'This column'}" and the measurements entered under it will be removed. Nothing is saved until you save the product.`, confirmLabel: 'Remove column', onConfirm: remove });
    } else remove();
  };
  const problems = guide ? sizeGuideProblems(guide) : [];

  return <fieldset className="admin-stock-message admin-size-guide">
    <legend>Size Guide / Measurements</legend>
    <p className="admin-size-guide-note"><strong>Customer-facing measurements only.</strong> The sizes listed here are labels for the measurement table and are completely separate from the inventory sizes and quantities above. Changing them never changes stock, SKUs or availability.</p>
    {!guide && <>
      <small>{removed ? 'This product\'s guide will be removed when you save. Customers will see the generic size guide.' : 'No size guide yet: customers see the generic size guide. Add one to show this product\'s own measurements.'}</small>
      <div className="admin-size-guide-starters">
        {suggested !== 'custom' && <button type="button" className="admin-primary-btn" onClick={() => start(suggested)}>Start with {suggestedLabel} layout</button>}
        <button type="button" className={suggested !== 'custom' ? 'admin-secondary-btn' : 'admin-primary-btn'} onClick={() => start('custom')}>Start blank</button>
        <button type="button" className="admin-secondary-btn" onClick={() => setMoreLayouts(value => !value)} aria-expanded={moreLayouts}>{moreLayouts ? 'Hide layouts' : 'Other layouts'}</button>
      </div>
      {moreLayouts && <div className="admin-size-guide-starters" role="group" aria-label="Other layouts">{SIZE_GUIDE_TEMPLATES.filter(item => item.id !== 'custom').map(item => <button type="button" key={item.id} className="admin-secondary-btn" onClick={() => start(item.id)}>{item.label}</button>)}</div>}
      <small>A layout only adds column names and sizes. Every measurement stays empty for you to fill in, and you can rename, add or remove anything afterwards.</small>
    </>}
    {guide && <>
      <div className="admin-size-guide-options">
        <label className="admin-size-guide-toggle"><input type="checkbox" checked={guide.enabled} onChange={event => edit({ enabled: event.target.checked })} />Show this size guide to customers</label>
        <label>Unit<select value={guide.unit} onChange={event => edit({ unit: event.target.value as SizeGuideUnit })}>{SIZE_GUIDE_UNITS.map(unit => <option key={unit} value={unit}>{SIZE_GUIDE_UNIT_LABEL[unit]}</option>)}</select></label>
      </div>
      {!guide.enabled && <small>Disabled: customers see the generic size guide for this product. Your measurements are kept.</small>}
      <div className="admin-size-guide-grid" role="group" aria-label="Measurement table">
        <table>
          <thead><tr>
            <th scope="col">Size label</th>
            {guide.columns.map((column, index) => <th scope="col" key={column.key}>
              <div className="admin-size-guide-colhead">
                <input value={column.label} maxLength={SIZE_GUIDE_LIMITS.label} aria-label={`Column ${index + 1} name`} placeholder="e.g. Chest" onChange={event => edit({ columns: guide.columns.map(item => (item.key === column.key ? { ...item, label: event.target.value } : item)) })} />
                <button type="button" className="admin-size-guide-remove" title="Remove this column" aria-label={`Remove column ${column.label || index + 1}`} disabled={guide.columns.length <= 1} onClick={() => removeColumn(column.key, column.label)}><Trash2 size={14} /></button>
              </div>
            </th>)}
            <th aria-hidden="true" />
          </tr></thead>
          <tbody>{guide.rows.map((row, rowIndex) => <tr key={rowIndex}>
            <td><input value={row.size} maxLength={SIZE_GUIDE_LIMITS.size} aria-label={`Row ${rowIndex + 1} size label`} placeholder="e.g. M" onChange={event => edit({ rows: guide.rows.map((item, i) => (i === rowIndex ? { ...item, size: event.target.value } : item)) })} /></td>
            {guide.columns.map(column => <td key={column.key}><input value={row.values[column.key] ?? ''} maxLength={SIZE_GUIDE_LIMITS.cell} aria-label={`${row.size || `Row ${rowIndex + 1}`} ${column.label || 'measurement'}`} placeholder="e.g. 38–40" onChange={event => edit({ rows: guide.rows.map((item, i) => (i === rowIndex ? { ...item, values: { ...item.values, [column.key]: event.target.value } } : item)) })} /></td>)}
            <td><button type="button" className="admin-size-guide-remove" aria-label={`Remove row ${row.size || rowIndex + 1}`} disabled={guide.rows.length <= 1} onClick={() => edit({ rows: guide.rows.filter((_, i) => i !== rowIndex) })}><Trash2 size={14} /></button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="admin-size-guide-actions">
        <button type="button" className="admin-secondary-btn" disabled={guide.columns.length >= SIZE_GUIDE_LIMITS.columns} onClick={() => edit({ columns: [...guide.columns, { key: nextColumnKey(guide.columns), label: '' }] })}><Plus size={14} /> Add column</button>
        <button type="button" className="admin-secondary-btn" disabled={guide.rows.length >= SIZE_GUIDE_LIMITS.rows} onClick={() => edit({ rows: [...guide.rows, { size: '', values: {} }] })}><Plus size={14} /> Add row</button>
        <button type="button" className="admin-secondary-btn" onClick={() => setPreview(value => !value)} aria-expanded={preview}>{preview ? 'Hide preview' : 'Preview'}</button>
        <button type="button" className="admin-danger-quiet" onClick={askRemove}>Remove size guide</button>
      </div>
      <small>Up to {SIZE_GUIDE_LIMITS.columns} columns and {SIZE_GUIDE_LIMITS.rows} rows. Ranges such as 38–40 are fine.</small>
      {problems.length > 0 && <ul className="admin-size-guide-problems" role="status">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {preview && problems.length === 0 && <div className="admin-size-guide-preview" aria-label="Customer preview"><span className="eyebrow">CUSTOMER PREVIEW</span><div className="size-guide-table-wrap"><SizeGuideTable guide={guide} /></div></div>}
    </>}
  </fieldset>;
}
