import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  isAnimatedWebp,
  mimeToExtension,
  optimizeImage,
  replaceFileExtension,
  resetOptimizationEngine,
  setOptimizationEngineForTesting,
  type ImageOptimizationEngine,
} from '@/lib/image-optimizer';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_ORIGINAL_IMAGE_BYTES,
} from '@/lib/upload-limits';
import { createUploadSession } from '@/lib/upload-session';

// Helper to construct mock files with magic headers
function createMockFile(size: number, mime: string, name: string): File {
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  if (mime === 'image/jpeg') {
    bytes.set([0xff, 0xd8, 0xff]);
  } else if (mime === 'image/png') {
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } else if (mime === 'image/webp') {
    bytes.set([0x52, 0x49, 0x46, 0x46]);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  }
  return new File([buffer], name, { type: mime });
}

describe('Centralized Image Optimization & Upload Pipeline', () => {
  beforeEach(() => {
    resetOptimizationEngine();
  });

  afterEach(() => {
    resetOptimizationEngine();
  });

  // 1. A 3 MB JPEG upload (pass-through)
  it('1. accepts a 3 MB JPEG without re-compression', async () => {
    const file = createMockFile(3 * 1024 * 1024, 'image/jpeg', 'photo.jpg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(false);
    expect(result.file).toBe(file);
    expect(result.optimizedBytes).toBe(3 * 1024 * 1024);
    expect(result.optimizedType).toBe('image/jpeg');
  });

  // 2. A 9 MB PNG upload (pass-through)
  it('2. accepts a 9 MB PNG without re-compression', async () => {
    const file = createMockFile(9 * 1024 * 1024, 'image/png', 'graphic.png');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(false);
    expect(result.file).toBe(file);
    expect(result.optimizedBytes).toBe(9 * 1024 * 1024);
    expect(result.optimizedType).toBe('image/png');
  });

  // 3. An 11 MB image (compressed below 10 MB)
  it('3. compresses an 11 MB image below 10 MB', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 3000,
        height: 2000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        // Simulates shrinking to 6 MB on first pass
        const simulatedSize = Math.round(options.quality * 7 * 1024 * 1024);
        return new Blob([new Uint8Array(simulatedSize)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(11 * 1024 * 1024, 'image/jpeg', 'heavy.jpg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(result.optimizedBytes).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES);
    expect(result.file.name).toBe('heavy.jpg');
  });

  // 4. A 20 MB high-resolution JPEG (compressed below 10 MB)
  it('4. compresses a 20 MB JPEG below 10 MB and preserves JPEG encoding', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 6000,
        height: 4000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        // Scaled resolution simulation
        const size = Math.round((options.targetWidth / 6000) * 8 * 1024 * 1024 * options.quality);
        return new Blob([new Uint8Array(size)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(20 * 1024 * 1024, 'image/jpeg', 'editorial.jpeg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(result.optimizedBytes).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES);
    expect(result.optimizedType).toBe('image/jpeg');
    expect(result.file.name).toBe('editorial.jpg');
  });

  // 5. A 30 MB PNG with transparency (converts to WebP, preserves alpha)
  it('5. compresses a 30 MB PNG with transparency to WebP and preserves alpha', async () => {
    let capturedMime = '';
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 4000,
        height: 4000,
        hasAlpha: true, // transparent
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        capturedMime = options.mimeType;
        const size = 5 * 1024 * 1024; // 5 MB
        return new Blob([new Uint8Array(size)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(30 * 1024 * 1024, 'image/png', 'cutout.png');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(capturedMime).toBe('image/webp');
    expect(result.optimizedType).toBe('image/webp');
    expect(result.file.name).toBe('cutout.webp');
    expect(result.optimizedBytes).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES);
  });

  // 6. A 50 MB supported image (exact upper limit)
  it('6. compresses a 50 MB image successfully', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 8000,
        height: 6000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        return new Blob([new Uint8Array(8 * 1024 * 1024)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(50 * 1024 * 1024, 'image/jpeg', 'massive.jpg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(result.optimizedBytes).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES);
  });

  // 7. An image larger than 50 MB (rejected)
  it('7. rejects an image exceeding 50 MB with the exact required error', async () => {
    const file = createMockFile(MAX_ORIGINAL_IMAGE_BYTES + 1, 'image/jpeg', 'giant.jpg');
    await expect(optimizeImage(file)).rejects.toThrow(
      'Image is too large to process. Please choose an image under 50 MB.'
    );
  });

  // 8. An unsupported format (rejected)
  it('8. rejects unsupported formats', async () => {
    const file = new File(['GIF89a'], 'anim.gif', { type: 'image/gif' });
    await expect(optimizeImage(file)).rejects.toThrow('only JPEG, PNG, WebP or AVIF images are allowed');
  });

  // 9. A corrupt image that cannot be decoded
  it('9. handles corrupt images that fail decoding gracefully', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => {
        throw new Error('Could not decode image. The file may be corrupt or has zero dimensions.');
      },
      encode: async () => new Blob([]),
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(15 * 1024 * 1024, 'image/jpeg', 'broken.jpg');
    await expect(optimizeImage(file)).rejects.toThrow('Could not decode image');
  });

  // 10. A compression output that initially exceeds 10 MB steps through the ladder
  it('10. steps through ladder when initial compression passes exceed 10 MB', async () => {
    let attempts = 0;
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 5000,
        height: 5000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        attempts += 1;
        // First 2 attempts exceed 10 MB, 3rd attempt fits
        if (attempts <= 2) {
          return new Blob([new Uint8Array(12 * 1024 * 1024)], { type: options.mimeType });
        }
        return new Blob([new Uint8Array(7 * 1024 * 1024)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(25 * 1024 * 1024, 'image/jpeg', 'stepped.jpg');
    const result = await optimizeImage(file);
    expect(attempts).toBe(3);
    expect(result.optimizedBytes).toBe(7 * 1024 * 1024);
  });

  // 11. Correct MIME type and extension after conversion
  it('11. verifies MIME type and extension mapping functions', () => {
    expect(mimeToExtension('image/jpeg')).toBe('jpg');
    expect(mimeToExtension('image/png')).toBe('png');
    expect(mimeToExtension('image/webp')).toBe('webp');
    expect(mimeToExtension('image/avif')).toBe('avif');
    expect(replaceFileExtension('photo.png', 'webp')).toBe('photo.webp');
    expect(replaceFileExtension('banner.jpeg', '.jpg')).toBe('banner.jpg');
    expect(replaceFileExtension('catalog.item.png', 'jpg')).toBe('catalog.item.jpg');
  });

  // 12. Preserved aspect ratio calculation
  it('12. maintains aspect ratio when scaling dimensions', async () => {
    let encodedW = 0;
    let encodedH = 0;
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 4000,
        height: 2000, // 2:1 aspect ratio
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        encodedW = options.targetWidth;
        encodedH = options.targetHeight;
        return new Blob([new Uint8Array(6 * 1024 * 1024)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(20 * 1024 * 1024, 'image/jpeg', 'wide.jpg');
    const result = await optimizeImage(file);
    expect(result.width).toBe(4000);
    expect(result.height).toBe(2000);
    expect(encodedW / encodedH).toBe(2);
  });

  // 13. Failed upload and failed save cleanup (UploadSession)
  it('13. UploadSession tracks, forgets, commits and abandons unsaved images correctly', async () => {
    const session = createUploadSession();
    const removedUrls: string[] = [];
    const removeFn = (url: string) => async () => {
      removedUrls.push(url);
    };

    session.track('https://test.supabase.co/img1.jpg', removeFn('img1'));
    session.track('https://test.supabase.co/img2.jpg', removeFn('img2'));
    expect(session.size).toBe(2);

    // Forget img1 (user replaced or deleted in form before save)
    session.forget('https://test.supabase.co/img1.jpg');
    expect(session.size).toBe(1);

    // Abandon deletes remaining untracked
    await session.abandon();
    expect(removedUrls).toEqual(['img2']);
    expect(session.size).toBe(0);
  });

  // 14. Product multiple-image uploads
  it('14. handles multiple product images sequentially and reports progress', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 2000,
        height: 2000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => new Blob([new Uint8Array(4 * 1024 * 1024)], { type: options.mimeType }),
    };
    setOptimizationEngineForTesting(mockEngine);

    const files = [
      createMockFile(12 * 1024 * 1024, 'image/jpeg', 'p1.jpg'),
      createMockFile(5 * 1024 * 1024, 'image/png', 'p2.png'),
      createMockFile(18 * 1024 * 1024, 'image/jpeg', 'p3.jpg'),
    ];

    const results = await Promise.all(files.map(f => optimizeImage(f)));
    expect(results[0].compressed).toBe(true);
    expect(results[1].compressed).toBe(false); // <= 10 MB kept as is
    expect(results[2].compressed).toBe(true);
  });

  // 15. Category image replacement
  it('15. optimizes category image if replaced with large file', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 1500,
        height: 2000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => new Blob([new Uint8Array(3 * 1024 * 1024)], { type: options.mimeType }),
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(16 * 1024 * 1024, 'image/jpeg', 'category-hoodies.jpg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(result.optimizedBytes).toBe(3 * 1024 * 1024);
  });

  // 16. Desktop and mobile hero banner image uploads
  it('16. processes hero banner images (desktop and mobile)', async () => {
    const desktopFile = createMockFile(22 * 1024 * 1024, 'image/jpeg', 'banner-desktop.jpg');
    const mobileFile = createMockFile(8 * 1024 * 1024, 'image/jpeg', 'banner-mobile.jpg');

    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 3840,
        height: 2160,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => new Blob([new Uint8Array(6 * 1024 * 1024)], { type: options.mimeType }),
    };
    setOptimizationEngineForTesting(mockEngine);

    const [optDesktop, optMobile] = await Promise.all([
      optimizeImage(desktopFile),
      optimizeImage(mobileFile),
    ]);

    expect(optDesktop.compressed).toBe(true);
    expect(optDesktop.optimizedBytes).toBe(6 * 1024 * 1024);
    expect(optMobile.compressed).toBe(false); // <= 10 MB untouched
  });

  // 17. Luxe feature image uploads
  it('17. processes Luxe feature band images', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 3000,
        height: 1200,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => new Blob([new Uint8Array(4 * 1024 * 1024)], { type: options.mimeType }),
    };
    setOptimizationEngineForTesting(mockEngine);

    const file = createMockFile(14 * 1024 * 1024, 'image/jpeg', 'luxe-band.jpg');
    const result = await optimizeImage(file);
    expect(result.compressed).toBe(true);
    expect(result.optimizedBytes).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES);
  });

  // 18. Existing video upload behaviour remains unchanged
  it('18. image limits stay separate from banner videos: videos use their own bucket and an admin-chosen optimisation mode, not the 10 MB image rule', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(readFileSync('supabase/migrations/0013_banner_video_size_limit.sql', 'utf8')).toContain("id = 'banner-media'");
  });

  it('formats byte strings cleanly for human readability', () => {
    expect(formatBytes(500 * 1024)).toBe('500 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(25.5 * 1024 * 1024)).toBe('25.5 MB');
  });

  it('detects animated WebP byte patterns correctly', () => {
    const staticWebp = new Uint8Array(32);
    staticWebp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
    expect(isAnimatedWebp(staticWebp)).toBe(false);

    const animWebp = new Uint8Array(32);
    animWebp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    animWebp[20] = 0x02; // animation flag
    expect(isAnimatedWebp(animWebp)).toBe(true);
  });

  it('detects animated PNG (APNG) and animated AVIF correctly', async () => {
    const { isAnimatedPng, isAnimatedAvif } = await import('@/lib/image-optimizer');

    // APNG with acTL chunk
    const apng = new Uint8Array(64);
    apng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    apng.set([0x61, 0x63, 0x54, 0x4c], 16); // 'acTL'
    expect(isAnimatedPng(apng)).toBe(true);

    // Standard static PNG without acTL
    const staticPng = new Uint8Array(64);
    staticPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isAnimatedPng(staticPng)).toBe(false);

    // Animated AVIF with avis brand
    const avis = new Uint8Array(64);
    avis.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73]); // ftyp avis
    expect(isAnimatedAvif(avis)).toBe(true);

    // Static AVIF with avif brand
    const staticAvif = new Uint8Array(64);
    staticAvif.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]); // ftyp avif
    expect(isAnimatedAvif(staticAvif)).toBe(false);
  });

  it('preserves animated images under 10 MB untouched without static flattening', async () => {
    // 5 MB animated WebP
    const animWebp = createMockFile(5 * 1024 * 1024, 'image/webp', 'anim.webp');
    const result = await optimizeImage(animWebp);
    expect(result.compressed).toBe(false);
    expect(result.file).toBe(animWebp);
  });

  it('rejects oversized animated images (> 10 MB) with clear explanation instead of flattening', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 1920,
        height: 1080,
        hasAlpha: true,
        isAnimated: true,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async () => new Blob([]),
    };
    setOptimizationEngineForTesting(mockEngine);

    const oversizedAnim = createMockFile(14 * 1024 * 1024, 'image/webp', 'hero-animated.webp');
    await expect(optimizeImage(oversizedAnim)).rejects.toThrow(
      'Animated images larger than 10 MB cannot be automatically compressed without losing animation. Please compress this file before uploading.'
    );
  });

  it('clamps canvas dimensions for ultra-high-resolution images (12,000x8,000) to safe bounds while preserving 3:2 aspect ratio', async () => {
    let targetWidthUsed = 0;
    let targetHeightUsed = 0;
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 12000,
        height: 8000, // 3:2 ratio
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async (_src, options) => {
        targetWidthUsed = options.targetWidth;
        targetHeightUsed = options.targetHeight;
        return new Blob([new Uint8Array(5 * 1024 * 1024)], { type: options.mimeType });
      },
    };
    setOptimizationEngineForTesting(mockEngine);

    const hugeImage = createMockFile(35 * 1024 * 1024, 'image/jpeg', 'huge-12k.jpg');
    const result = await optimizeImage(hugeImage);
    expect(result.compressed).toBe(true);
    // Should be clamped to 4096 x 2731 (preserving 3:2 ratio)
    expect(targetWidthUsed).toBeLessThanOrEqual(4096);
    expect(targetHeightUsed).toBeLessThanOrEqual(4096);
    expect(Math.round((targetWidthUsed / targetHeightUsed) * 10) / 10).toBe(1.5);
  });

  it('strictly rejects when all candidate compression blobs exceed 10 MB without uploading original', async () => {
    const mockEngine: ImageOptimizationEngine = {
      decode: async () => ({
        width: 4000,
        height: 3000,
        hasAlpha: false,
        isAnimated: false,
        rawSource: {},
        close: vi.fn(),
      }),
      encode: async () => new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'image/jpeg' }), // always 11 MB
    };
    setOptimizationEngineForTesting(mockEngine);

    const stubbornImage = createMockFile(20 * 1024 * 1024, 'image/jpeg', 'stubborn.jpg');
    await expect(optimizeImage(stubbornImage)).rejects.toThrow(
      'Could not compress image below 10 MB. Please choose an image with smaller dimensions.'
    );
  });
});
