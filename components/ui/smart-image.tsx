'use client';

import { useEffect, useState } from 'react';

export function SmartImage({ src, alt, className = '', eager = false }: { src: string; alt: string; className?: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div className={`smart-image ${!src || failed ? 'smart-image-failed' : ''} ${className}`}>
      {src && !failed ? <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} onError={() => setFailed(true)} /> : (
        <div className="image-fallback" aria-label={alt}><span className="fallback-monogram">1218</span><span>{alt}</span></div>
      )}
    </div>
  );
}
