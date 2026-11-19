import { describe, expect, it } from 'vitest';
import { MAX_FILL_CROP, fillCrop, galleryFit } from '@/lib/gallery-fit';

describe('fillCrop', () => {
  it('is 0 for a picture that already has the frame shape', () => {
    expect(fillCrop(2 / 3)).toBeCloseTo(0);
    expect(fillCrop(5464 / 8192)).toBeCloseTo(0, 3);
  });
  it('measures the share cut off, for pictures wider and narrower than the frame', () => {
    expect(fillCrop(5464 / 6124)).toBeCloseTo(0.253, 2); // the near-square close-up
    expect(fillCrop(8192 / 5464)).toBeCloseTo(0.555, 2); // landscape
    expect(fillCrop(0.5)).toBeCloseTo(0.25, 2); // narrower than the frame: trimmed top and bottom
  });
  it('treats garbage as "do not crop"', () => {
    expect(fillCrop(0)).toBe(1);
    expect(fillCrop(Number.NaN)).toBe(1);
    expect(fillCrop(-2)).toBe(1);
  });
});

describe('galleryFit', () => {
  it('fills the frame for 2:3 photos and near-2:3 close-ups', () => {
    expect(galleryFit(5464 / 8192)).toBe('fill'); // 2:3
    expect(galleryFit(4173 / 5867)).toBe('fill'); // 0.711
    expect(galleryFit(5464 / 6673)).toBe('fill'); // 0.819
    expect(galleryFit(5464 / 6124)).toBe('fill'); // 0.892, the reported picture
  });
  it('keeps a landscape photo whole: never crops half a garment away', () => {
    expect(galleryFit(8192 / 5464)).toBe('whole');
    expect(galleryFit(16 / 9)).toBe('whole');
    expect(galleryFit(1)).toBe('whole'); // a square would lose a third of its width
  });
  it('keeps the picture whole until its proportions are known', () => {
    expect(galleryFit(undefined)).toBe('whole');
  });
  it('the limit is exactly the documented maximum trim', () => {
    expect(MAX_FILL_CROP).toBe(0.3);
    expect(galleryFit((2 / 3) / (1 - MAX_FILL_CROP) - 1e-6)).toBe('fill');
    expect(galleryFit((2 / 3) / (1 - MAX_FILL_CROP) + 1e-3)).toBe('whole');
  });
});
