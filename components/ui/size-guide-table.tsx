import type { SizeGuide } from '@/lib/size-guide';

/** A product's own measurement table (storefront modal and the admin preview). Plain text only. The unit is shown once, in each column heading. */
export function SizeGuideTable({ guide }: { guide: SizeGuide }) {
  return <table><thead><tr><th>Size</th>{guide.columns.map(column => <th key={column.key}>{column.label} ({guide.unit})</th>)}</tr></thead><tbody>{guide.rows.map((row, index) => <tr key={`${row.size}-${index}`}><td>{row.size}</td>{guide.columns.map(column => <td key={column.key}>{row.values[column.key] ?? ''}</td>)}</tr>)}</tbody></table>;
}
