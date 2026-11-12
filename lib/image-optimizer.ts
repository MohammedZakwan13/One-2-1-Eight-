import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
  MAX_ORIGINAL_IMAGE_BYTES,
  MAX_ORIGINAL_IMAGE_LABEL,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SupportedImageMime,
} from './upload-limits';

export { MAX_ORIGINAL_IMAGE_LABEL };

export const MAX_SAFE_CANVAS_DIMENSION = 4096;

export type OptimizationResult = {
  file: File;
  compressed: boolean;
  originalBytes: number;
  optimizedBytes: number;
  originalType: string;
  optimizedType: string;
  width?: number;
  height?: number;
  compressionRatio?: number; // 0..100 percentage saved
};

export type OptimizeProgress = (status: {
  stage: 'checking' | 'optimizing' | 'done';
  message: string;
  percent?: number;
}) => void;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Check if WebP binary bytes contain animation chunks (ANMF/ANIM). */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 30) return false;
  // RIFF .... WEBP VP8X
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    // Check for VP8X animation flag (bit 1 of flags byte at index 20)
    if (
      bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58 &&
      bytes.length > 20
    ) {
      const flags = bytes[20];
      if ((flags & 0x02) !== 0) return true;
    }
    // Also scan for ANIM chunk header
    for (let i = 12; i < bytes.length - 8; i++) {
      if (
        bytes[i] === 0x41 && bytes[i + 1] === 0x4e &&
        bytes[i + 2] === 0x49 && bytes[i + 3] === 0x4d
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Check if PNG binary bytes contain an APNG animation chunk (acTL before IDAT). */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < 40) return false;
  // PNG signature: 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  if (
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a
  ) {
    return false;
  }
  // Scan chunk headers for 'acTL' (0x61, 0x63, 0x54, 0x4c)
  const maxScan = Math.min(bytes.length - 8, 65536);
  for (let i = 8; i < maxScan; i++) {
    if (bytes[i] === 0x61 && bytes[i + 1] === 0x63 && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x4c) {
      return true;
    }
  }
  return false;
}

/** Check if AVIF binary bytes indicate an animated image sequence (avis or moov track). */
export function isAnimatedAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 32) return false;
  // Look for 'ftyp' at offset 4
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    // Check major brand (bytes 8..11) or compatible brands in the ftyp box
    // 'avis' = [0x61, 0x76, 0x69, 0x73]
    const boxSize = Math.min(bytes.length - 4, (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3] || 128);
    for (let i = 8; i <= boxSize; i += 4) {
      if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x73) {
        return true;
      }
    }
  }
  // Also scan for 'moov' box header which indicates video / animated sequence in ISOBMFF
  const maxScan = Math.min(bytes.length - 4, 4096);
  for (let i = 0; i < maxScan; i++) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x76) {
      return true;
    }
  }
  return false;
}

/** Check if an image file is an animated variant (WebP, APNG, or AVIF image sequence). */
export function isAnimatedImage(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/webp') return isAnimatedWebp(bytes);
  if (mimeType === 'image/png') return isAnimatedPng(bytes);
  if (mimeType === 'image/avif') return isAnimatedAvif(bytes);
  return false;
}

/** Generate a clean file name when the compression converts the image format. */
export function replaceFileExtension(fileName: string, targetExt: string): string {
  const cleanExt = targetExt.startsWith('.') ? targetExt.slice(1) : targetExt;
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) return `${fileName}.${cleanExt}`;
  return `${fileName.slice(0, lastDot)}.${cleanExt}`;
}

export function mimeToExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/avif': return 'avif';
    default: return 'jpg';
  }
}

export interface ImageOptimizationEngine {
  decode(file: File): Promise<{
    width: number;
    height: number;
    hasAlpha: boolean;
    isAnimated: boolean;
    rawSource: unknown;
    close: () => void;
  }>;
  encode(
    rawSource: unknown,
    options: {
      width: number;
      height: number;
      targetWidth: number;
      targetHeight: number;
      mimeType: string;
      quality: number;
    }
  ): Promise<Blob>;
}

/**
 * Standard browser HTML5 Canvas / OffscreenCanvas implementation.
 */
class BrowserCanvasEngine implements ImageOptimizationEngine {
  async decode(file: File) {
    if (typeof window === 'undefined') {
      throw new Error('Browser image decoding is unavailable in non-browser environment.');
    }

    const headerBytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const isAnim = isAnimatedImage(headerBytes, file.type);

    let bitmap: ImageBitmap | null = null;
    let img: HTMLImageElement | null = null;
    let width = 0;
    let height = 0;
    let objectUrl: string | null = null;

    try {
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
          width = bitmap.width;
          height = bitmap.height;
        } catch {
          bitmap = null;
        }
      }

      if (!bitmap) {
        objectUrl = URL.createObjectURL(file);
        img = new Image();
        img.src = objectUrl;
        await new Promise<void>((resolve, reject) => {
          if (!img) return reject(new Error('Failed to create Image object'));
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Could not decode image. The file may be corrupt or an unsupported format.'));
        });
        width = img.naturalWidth || img.width;
        height = img.naturalHeight || img.height;
      }

      if (width <= 0 || height <= 0) {
        throw new Error('Could not decode image. The file may be corrupt or has zero dimensions.');
      }

      // Determine transparency for PNG/WebP
      let hasAlpha = false;
      if (file.type === 'image/png' || file.type === 'image/webp') {
        const sampleCanvas = document.createElement('canvas');
        const sampleW = Math.min(64, width);
        const sampleH = Math.min(64, height);
        sampleCanvas.width = sampleW;
        sampleCanvas.height = sampleH;
        const sCtx = sampleCanvas.getContext('2d');
        if (sCtx) {
          if (bitmap) sCtx.drawImage(bitmap, 0, 0, sampleW, sampleH);
          else if (img) sCtx.drawImage(img, 0, 0, sampleW, sampleH);
          try {
            const imgData = sCtx.getImageData(0, 0, sampleW, sampleH).data;
            for (let i = 3; i < imgData.length; i += 4) {
              if (imgData[i] < 250) {
                hasAlpha = true;
                break;
              }
            }
          } catch {

            hasAlpha = true;
          }
        }
        sampleCanvas.width = 0;
        sampleCanvas.height = 0;
      }

      return {
        width,
        height,
        hasAlpha,
        isAnimated: isAnim,
        rawSource: bitmap ?? img,
        close: () => {
          if (bitmap) bitmap.close();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
      };
    } catch (decodeErr) {
      if (bitmap) bitmap.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      throw decodeErr;
    }
  }

  async encode(
    rawSource: unknown,
    options: {
      width: number;
      height: number;
      targetWidth: number;
      targetHeight: number;
      mimeType: string;
      quality: number;
    }
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = options.targetWidth;
    canvas.height = options.targetHeight;
    const ctx = canvas.getContext('2d', { alpha: options.mimeType !== 'image/jpeg' });
    if (!ctx) {
      canvas.width = 0;
      canvas.height = 0;
      throw new Error('Canvas 2D context creation failed.');
    }

    // High quality scaling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // If encoding to opaque JPEG, fill white background to avoid black alpha rendering
    if (options.mimeType === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, options.targetWidth, options.targetHeight);
    }

    const drawable = rawSource as CanvasImageSource;
    ctx.drawImage(drawable, 0, 0, options.targetWidth, options.targetHeight);

    return new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob(
          blob => {
            canvas.width = 0;
            canvas.height = 0;
            if (blob) resolve(blob);
            else reject(new Error('Canvas encoding to blob failed.'));
          },
          options.mimeType,
          options.quality
        );
      } catch (err) {
        canvas.width = 0;
        canvas.height = 0;
        reject(err);
      }
    });
  }
}

let activeEngine: ImageOptimizationEngine = new BrowserCanvasEngine();

export function setOptimizationEngineForTesting(engine: ImageOptimizationEngine) {
  activeEngine = engine;
}

export function resetOptimizationEngine() {
  activeEngine = new BrowserCanvasEngine();
}

/**
 * Progressive optimization ladder.
 * Balances quality preservation with gradual dimension reduction.
 */
const OPTIMIZATION_LADDER = [
  { scale: 1.0, quality: 0.85 },
  { scale: 1.0, quality: 0.75 },
  { scale: 0.85, quality: 0.82 },
  { scale: 0.85, quality: 0.72 },
  { scale: 0.70, quality: 0.80 },
  { scale: 0.70, quality: 0.70 },
  { scale: 0.55, quality: 0.78 },
  { scale: 0.55, quality: 0.65 },
  { scale: 0.40, quality: 0.75 },
  { scale: 0.30, quality: 0.70 },
];

/**
 * Optimizes an image File if it exceeds MAX_IMAGE_UPLOAD_BYTES (10 MB).
 * Files <= 10 MB pass through untouched.
 * Files > 50 MB are rejected upfront.
 */
export async function optimizeImage(
  file: File,
  options?: {
    onProgress?: OptimizeProgress;
    maxTargetBytes?: number;
    maxOriginalBytes?: number;
  }
): Promise<OptimizationResult> {
  const maxTarget = options?.maxTargetBytes ?? MAX_IMAGE_UPLOAD_BYTES;
  const maxOriginal = options?.maxOriginalBytes ?? MAX_ORIGINAL_IMAGE_BYTES;

  // 1. Validate file format against supported types
  if (!SUPPORTED_IMAGE_MIME_TYPES.includes(file.type as SupportedImageMime)) {
    throw new Error(`${file.name}: only JPEG, PNG, WebP or AVIF images are allowed.`);
  }

  // 2. Reject files exceeding 50 MB
  if (file.size > maxOriginal) {
    throw new Error('Image is too large to process. Please choose an image under 50 MB.');
  }

  // 3. Rule A: If already within 10 MB, accept directly without compression
  if (file.size <= maxTarget) {
    return {
      file,
      compressed: false,
      originalBytes: file.size,
      optimizedBytes: file.size,
      originalType: file.type,
      optimizedType: file.type,
      compressionRatio: 0,
    };
  }

  // 4. Rule B & C: File exceeds 10 MB, perform browser-side optimization
  options?.onProgress?.({
    stage: 'optimizing',
    message: 'Optimizing image...',
    percent: 10,
  });

  let decoded: Awaited<ReturnType<ImageOptimizationEngine['decode']>>;
  try {
    decoded = await activeEngine.decode(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${file.name}: ${msg}`);
  }

  try {
    // Check for any animated format (WebP, APNG, AVIF sequence)
    if (decoded.isAnimated) {
      throw new Error(
        `${file.name}: Animated images larger than ${MAX_IMAGE_UPLOAD_LABEL} cannot be automatically compressed without losing animation. Please compress this file before uploading.`
      );
    }

    // Determine target format:
    // If the image has transparency, use WebP to preserve alpha with lossy compression.
    // If opaque, use WebP (or JPEG if original was JPEG).
    let targetMime: string = 'image/webp';
    if (!decoded.hasAlpha && file.type === 'image/jpeg') {
      targetMime = 'image/jpeg';
    } else {
      targetMime = 'image/webp';
    }

    // Dimension safety clamp: cap canvas dimensions at MAX_SAFE_CANVAS_DIMENSION (4096px)
    // while strictly preserving original aspect ratio.
    const maxDimension = Math.max(decoded.width, decoded.height);
    const baseScale = maxDimension > MAX_SAFE_CANVAS_DIMENSION ? MAX_SAFE_CANVAS_DIMENSION / maxDimension : 1.0;
    const baseW = Math.max(1, Math.round(decoded.width * baseScale));
    const baseH = Math.max(1, Math.round(decoded.height * baseScale));

    let chosenBlob: Blob | null = null;
    let finalW = baseW;
    let finalH = baseH;

    for (let i = 0; i < OPTIMIZATION_LADDER.length; i++) {
      const step = OPTIMIZATION_LADDER[i];
      const targetW = Math.max(1, Math.round(baseW * step.scale));
      const targetH = Math.max(1, Math.round(baseH * step.scale));

      options?.onProgress?.({
        stage: 'optimizing',
        message: 'Optimizing image...',
        percent: Math.min(90, 15 + Math.round((i / OPTIMIZATION_LADDER.length) * 75)),
      });

      try {
        const candidateBlob = await activeEngine.encode(decoded.rawSource, {
          width: decoded.width,
          height: decoded.height,
          targetWidth: targetW,
          targetHeight: targetH,
          mimeType: targetMime,
          quality: step.quality,
        });

        // Strict verification: measure the actual candidate blob size
        if (candidateBlob.size <= maxTarget) {
          chosenBlob = candidateBlob;
          finalW = targetW;
          finalH = targetH;
          break;
        }
      } catch (encodeErr) {
        console.warn('[image-optimizer] step failed', encodeErr);
      }
    }

    // Strict boundary enforcement: NEVER upload original if compression fails
    if (!chosenBlob || chosenBlob.size > maxTarget) {
      throw new Error(
        `${file.name}: Could not compress image below ${MAX_IMAGE_UPLOAD_LABEL}. Please choose an image with smaller dimensions.`
      );
    }

    const targetExt = mimeToExtension(targetMime);
    const newFileName = replaceFileExtension(file.name, targetExt);
    const optimizedFile = new File([chosenBlob], newFileName, {
      type: targetMime,
      lastModified: Date.now(),
    });

    const savedBytes = Math.max(0, file.size - optimizedFile.size);
    const ratio = Math.round((savedBytes / file.size) * 100);

    options?.onProgress?.({
      stage: 'done',
      message: `Optimized from ${formatBytes(file.size)} to ${formatBytes(optimizedFile.size)} (${ratio}% smaller)`,
      percent: 100,
    });

    return {
      file: optimizedFile,
      compressed: true,
      originalBytes: file.size,
      optimizedBytes: optimizedFile.size,
      originalType: file.type,
      optimizedType: targetMime,
      width: finalW,
      height: finalH,
      compressionRatio: ratio,
    };
  } finally {
    decoded.close();
  }
}
