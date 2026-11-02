/**
 * Largest admin image upload. TEMPORARY 4 MB (was 5 MB): Vercel Functions reject request bodies above about 4.5 MB before the app sees them, so 4 MB keeps the app's own
 * clear error message in charge. Used by BOTH the browser check and the server check; restore a larger limit only together with direct-to-Storage uploads.
 * The Storage bucket's own 5 MB limit (migration 0001) is unchanged and simply never reached.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_LABEL = '4 MB';
