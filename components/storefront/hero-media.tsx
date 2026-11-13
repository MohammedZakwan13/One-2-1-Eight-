'use client';

import { useEffect, useRef, useState } from 'react';
import type { HeroSlide } from '@/lib/api/schemas';
import { resolveHeroMedia } from '@/lib/hero-media';
import { shouldLoopVideo, slideKind, type HeroEnvironment } from '@/lib/hero-timing';
import { syncVideoPlayback } from '@/lib/hero-pause';
import type { VideoPlayback } from '@/lib/hooks/use-hero-carousel';

const MOBILE_QUERY = '(max-width: 600px)';

/** One banner video. Mounted only for the slide on screen and only when it will really play, keyed by its file so a device change replaces it. */
function HeroVideo({ src, poster, priority, paused, playback, single }: { src: string; poster: string; priority: boolean; paused: boolean; playback: VideoPlayback; /** The only banner: there is no next slide, so the video loops. */ single: boolean }) {
  const element = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const release = () => { const video = element.current; if (!video) return; video.pause(); video.removeAttribute('src'); video.load(); };
  const fail = () => { release(); setFailed(true); playback.onFailed(); };

  // A new file under this slide: the carousel forgets what it knew about the previous one.
  useEffect(() => { playback.onSourceChange(); }, [playback, src]);

  // Leaving the slide (or the device changing) stops this video at once and releases its download. React's development-only
  // "mount, unmount, mount" check runs this cleanup on a video that is about to be used again, so the setup puts the file back.
  useEffect(() => {
    const video = element.current;
    if (video && !video.getAttribute('src')) video.src = src;
    return () => { if (!video) return; video.pause(); video.removeAttribute('src'); video.load(); };
  }, [src]);

  // Pause / resume with the carousel (visitor's pause button, keyboard focus, hidden tab). A refused play() means "show the poster".
  useEffect(() => {
    const video = element.current;
    if (!video || failed) return;
    syncVideoPlayback(video, paused, () => { release(); setFailed(true); playback.onFailed(); });
  }, [paused, failed, playback]);

  if (failed) return null; // the poster image underneath stays on screen
  return <video
    ref={element}
    className={`hero-video ${ready ? 'is-ready' : ''}`}
    src={src}
    poster={poster || undefined}
    autoPlay muted playsInline loop={single}
    preload={priority ? 'auto' : 'metadata'}
    aria-hidden="true"
    tabIndex={-1}
    onLoadedMetadata={event => {
      const video = event.currentTarget;
      video.muted = true;
      // A lone banner always loops. With several: under 6 s the clip loops (the carousel waits out its minimum); 6 s and longer plays once to the end.
      video.loop = shouldLoopVideo(video.duration, single);
      playback.onMetadata(video.duration);
    }}
    onPlaying={() => { setReady(true); playback.onPlaying(); }}
    onEnded={playback.onEnded}
    onError={fail}
  />;
}

/**
 * The hero banner's picture / video. The still image is ALWAYS rendered first, exactly as before (the image, or the video's poster), so
 * the largest contentful paint is an ordinary image and a video that cannot play simply leaves the picture in place. A video is only
 * mounted once the device is known, never for visitors who prefer reduced motion (they get the still), and only the video for the
 * visitor's own device is requested: the other device's file is never downloaded. Which kind of slide this is comes from the same
 * `slideKind` the carousel timing uses, so what is shown and how long it stays can never disagree.
 */
export function HeroMedia({ slide, priority, env, paused, playback, single = false }: { slide: HeroSlide; priority: boolean; env: HeroEnvironment; paused: boolean; playback: VideoPlayback; single?: boolean }) {
  const desktop = resolveHeroMedia(slide, 'desktop');
  const mobile = resolveHeroMedia(slide, 'mobile');
  const desktopStill = desktop.image || mobile.image;
  const mobileStill = mobile.image || desktop.image;
  const active = env.isMobile ? mobile : desktop;
  const videoSrc = slideKind(slide, env) === 'video' ? active.video : '';
  const alt = slide.altText || `${slide.title.replace(/\n/g, ' ')} — ONE 2 1 EIGHT menswear campaign`;

  return <div className="hero-media">
    <picture className="hero-picture">
      {mobileStill && mobileStill !== desktopStill && <source media={MOBILE_QUERY} srcSet={mobileStill} />}
      {desktopStill && <img className="hero-photo" src={desktopStill} alt={alt} fetchPriority={priority ? 'high' : 'auto'} onError={event => { event.currentTarget.style.opacity = '0'; }} />}
    </picture>
    {videoSrc && <HeroVideo key={videoSrc} src={videoSrc} poster={active.image} priority={priority} paused={paused} playback={playback} single={single} />}
  </div>;
}
