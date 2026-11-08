/**
 * When the hero carousel's automatic movement is paused. Pure (no React, no DOM), so every rule is unit-tested.
 *
 *   user   a sticky pause. Set by the Pause button, AND by keyboard focus ENTERING the carousel. It is cleared only by the visitor
 *          activating the Play control: moving focus away never resumes the carousel by itself.
 *   hover  a temporary pause while a mouse (or pen) pointer is over the carousel. It never overrides `user`: leaving with the
 *          pointer resumes the carousel only if the visitor has not paused it themselves.
 *
 * Neither state touches the timing rules: pausing and resuming only stop and re-arm the existing timers (lib/hero-timing.ts).
 */
export type PauseState = { user: boolean; hover: boolean };
export type PauseEvent = 'toggle' | 'keyboard-focus-enter' | 'pointer-enter' | 'pointer-leave';

export const INITIAL_PAUSE: PauseState = { user: false, hover: false };

/** Returns the SAME object when nothing changes, so React skips the re-render and no effect re-runs. */
export function reducePause(state: PauseState, event: PauseEvent): PauseState {
  switch (event) {
    case 'toggle': return { ...state, user: !state.user };
    case 'keyboard-focus-enter': return state.user ? state : { ...state, user: true };
    case 'pointer-enter': return state.hover ? state : { ...state, hover: true };
    case 'pointer-leave': return state.hover ? { ...state, hover: false } : state;
  }
}

export const isRotationPaused = (state: PauseState): boolean => state.user || state.hover;

/** Focus ENTERS the carousel only when it comes from outside it; moving between the Pause button and the slide link is not "entering". */
export const focusEntersCarousel = (relatedTarget: unknown, container: { contains: (node: never) => boolean }): boolean =>
  !relatedTarget || !container.contains(relatedTarget as never);

/** Hover pauses for a mouse or a pen. A finger tap is not hovering, so touch never leaves the carousel stuck paused. */
export const pointerPausesRotation = (pointerType: string): boolean => pointerType === 'mouse' || pointerType === 'pen';

type VideoLike = { paused: boolean; ended: boolean; play: () => Promise<void> | undefined; pause: () => void };

/**
 * Makes a banner video match the carousel: paused while the carousel is paused, playing otherwise. It acts only when the video is not
 * already in the wanted state, so repeated hover / focus / tab-visibility changes never stack `play()` calls, and a clip that has already
 * finished is never restarted by a resume. `pause()` is always sent while paused: it is harmless on a paused video and it also cancels an
 * autoplay that has not started yet, so a video that loads while the carousel is paused does not begin playing. A `play()` the browser
 * REFUSES (autoplay blocked, unsupported media) is reported so the poster can be shown; one merely interrupted by a pause or a reload is not.
 */
export function syncVideoPlayback(video: VideoLike, paused: boolean, onRefused: () => void): void {
  if (paused) { video.pause(); return; }
  if (!video.paused || video.ended) return;
  const attempt = video.play();
  // An AbortError only means a pause() or a new load interrupted this play() (the video was replaced or left): not a refusal.
  if (attempt) attempt.catch(error => { if ((error as { name?: string } | null)?.name !== 'AbortError') onRefused(); });
}
