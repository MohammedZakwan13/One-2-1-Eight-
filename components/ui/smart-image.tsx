'use client';

import { useEffect, useRef, useState } from 'react';

export function SmartImage({ src, alt, className = '', eager = false, onNaturalSize }: { src: string; alt: string; className?: string; eager?: boolean; onNaturalSize?: (width: number, height: number) => void }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => setFailed(false), [src]);
  // Report the intrinsic size once known (also for images already complete before hydration).
  useEffect(() => { const img = ref.current; if (img && img.complete && img.naturalWidth > 0) onNaturalSize?.(img.naturalWidth, img.naturalHeight); }, [src, onNaturalSize]);
  return (
    <div className={`smart-image ${!src || failed ? 'smart-image-failed' : ''} ${className}`}>
      {src && !failed ? <img ref={ref} src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} onError={() => setFailed(true)} onLoad={event => { const img = event.currentTarget; if (img.naturalWidth > 0) onNaturalSize?.(img.naturalWidth, img.naturalHeight); }} /> : (
        <div className="image-fallback" aria-label={alt}><span className="fallback-monogram">1218</span><span>{alt}</span></div>
      )}
    </div>
  );
}
