

export function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'brand-mark-small' : ''}`} aria-label="One 2 1 Eight"><span>ONE 2 1 EIGHT</span><i /></span>;
}
