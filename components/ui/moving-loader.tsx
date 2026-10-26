import { Shirt, ShoppingBag, Sparkles } from 'lucide-react';

export function MovingLoader({ initial = false }: { initial?: boolean } = {}) {
  if (initial) {
    return (
      <div className="initial-splash-screen" role="status" aria-label="ONE 2 1 EIGHT">
        <div className="splash-lockup">
          <div className="splash-primary-wrap">
            <svg className="splash-primary-svg" viewBox="0 0 630 110" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ONETWO">
              <path fillRule="evenodd" clipRule="evenodd" d="M51 0C82 0 102 24 102 55C102 86 82 110 51 110C20 110 0 86 0 55C0 24 20 0 51 0ZM51 45C68 45 78 49.5 78 55C78 60.5 68 65 51 65C34 65 24 60.5 24 55C24 49.5 34 45 51 45Z" fill="#FFFFFF" />
              <path d="M106 0H135L174 68V0H202V110H173L134 42V110H106V0Z" fill="#FFFFFF" />
              <path d="M206 0H286V26H234V44H280V66H234V84H286V110H206V0Z" fill="#FFFFFF" />
              <path d="M289 0H377V26H347V110H319V26H289V0Z" fill="#FFFFFF" />
              <path d="M380 0H406L423 72L440 0H464L481 72L498 0H524L494 110H468L452 42L436 110H410L380 0Z" fill="#FFFFFF" />
              <path fillRule="evenodd" clipRule="evenodd" d="M579 0C610 0 630 24 630 55C630 86 610 110 579 110C548 110 528 86 528 55C528 24 548 0 579 0ZM579 45C596 45 606 49.5 606 55C606 60.5 596 65 579 65C562 65 552 60.5 552 55C552 49.5 562 45 579 45Z" fill="#FFFFFF" />
            </svg>
          </div>
          <div className="splash-secondary-wrap">
            <span className="splash-secondary-text">1 EIGHT</span>
          </div>
        </div>
      </div>
    );
  }
  return <div className="route-loader" role="status" aria-live="polite" aria-label="Loading next page"><div className="loader-orbit"><span><Shirt size={20} /></span><span><ShoppingBag size={17} /></span><span><Sparkles size={16} /></span></div><p>ONE 2 1 EIGHT</p></div>;
}
