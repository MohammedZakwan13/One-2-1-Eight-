/**
 * How a product picture is fitted into the gallery's fixed 2:3 frame. Pure (no React, no DOM), so the rule is unit-tested.
 *
 * The frame never changes shape. A picture that is close to the frame's proportions (the catalogue's apparel photos are 2:3; a near-square close-up is
 * not far off) FILLS it, trimming a little from the sides, so every view looks the same size. A picture that is far from the frame (a landscape photo)
 * is NEVER cropped: it stays whole inside the frame, because losing half of a garment is worse than a quiet bar.
 */
export const GALLERY_FRAME_RATIO = 2 / 3;

/** The most of a picture's width (or height) that may be trimmed to fill the frame. */
export const MAX_FILL_CROP = 0.3;

/** The share of the picture that filling the frame would cut off (0 = it already has the frame's shape). */
export function fillCrop(ratio: number, frame: number = GALLERY_FRAME_RATIO): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return ratio > frame ? 1 - frame / ratio : 1 - ratio / frame;
}

/** `fill` = cover the frame (small trim); `whole` = keep the whole picture visible inside it. */
export function galleryFit(ratio: number | undefined, frame: number = GALLERY_FRAME_RATIO): 'fill' | 'whole' {
  return ratio !== undefined && fillCrop(ratio, frame) <= MAX_FILL_CROP ? 'fill' : 'whole';
}
