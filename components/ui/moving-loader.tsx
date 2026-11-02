import { Shirt, ShoppingBag, Sparkles } from 'lucide-react';

export function MovingLoader({ initial = false, onDone }: { initial?: boolean; onDone?: () => void } = {}) {
  if (initial) {
    // Approved client splash video (1920x1080, ~3.4 s), shown in full: the shell dismisses the splash when playback ends, or if the video errors or cannot autoplay (its own safety timer is the last resort).
    // Muted + playsInline so browsers allow autoplay.
    return (
      <div className="initial-splash-screen initial-splash-video" role="status" aria-label="ONE 2 1 EIGHT">
        <video className="splash-video" src="/splash-screen.mp4" autoPlay muted playsInline preload="auto" onLoadedData={event => { void event.currentTarget.play().catch(() => onDone?.()); }} onEnded={onDone} onError={onDone} />
      </div>
    );
  }
  return <div className="route-loader" role="status" aria-live="polite" aria-label="Loading next page"><div className="loader-orbit"><span><Shirt size={20} /></span><span><ShoppingBag size={17} /></span><span><Sparkles size={16} /></span></div><p>ONE 2 1 EIGHT</p></div>;
}
