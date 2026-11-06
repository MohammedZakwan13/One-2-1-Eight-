'use client';

import { forwardRef, InputHTMLAttributes, WheelEvent } from 'react';

/**
 * Number input that ignores the mouse wheel / touchpad scroll. Browsers change a *focused* number input on wheel,
 * which silently edits prices and stock while the admin is just scrolling the page. Blurring on wheel stops that
 * while the page keeps scrolling; typing, native spinners and the arrow keys are unaffected.
 */
export const NumberInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function NumberInput({ onWheel, ...props }, ref) {
  const handleWheel = (event: WheelEvent<HTMLInputElement>) => {
    if (document.activeElement === event.currentTarget) event.currentTarget.blur();
    onWheel?.(event);
  };
  return <input {...props} ref={ref} type="number" onWheel={handleWheel} />;
});
