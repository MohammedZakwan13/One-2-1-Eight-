/**
 * Shared image upload limits for admin merchandising: products, categories, hero banners, and Luxe feature.
 *
 * Rules:
 * - Images up to 10 MB are accepted directly without re-compression.
 * - Images larger than 10 MB (up to 50 MB) are automatically compressed in the browser before upload.
 * - Original images exceeding 50 MB are rejected upfront with a clear error message.
 * - The backend (/api/v1/admin/uploads) and Supabase Storage media bucket enforce the 10 MB cap.
 */

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_LABEL = '10 MB';

export const MAX_ORIGINAL_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_ORIGINAL_IMAGE_LABEL = '50 MB';

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
