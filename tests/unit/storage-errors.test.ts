import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyStorageError } from '@/lib/backend/storage-errors';

const ctx = { bucket: 'banner-media', limitLabel: '100 MB' };

describe('storage error classification', () => {
  it('a connection reset during a big upload is NOT reported as a DNS/network problem', () => {
    const v = classifyStorageError({ name: 'StorageUnknownError', message: 'fetch failed', cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } }, ctx);
    expect(v.code).toBe('storage_connection_dropped');
    expect(v.message).not.toMatch(/DNS/);
    expect(v.message).toMatch(/network-level reset/); expect(v.message).not.toMatch(/too large|refused the file/i); // never reported as a size problem
  });
  it('a real DNS or refused connection is still reported as unreachable', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(classifyStorageError({ message: 'fetch failed', cause: { code } }, ctx).code).toBe('storage_unreachable');
    }
  });
  it('an explicit 413 explains the bucket and project limits', () => {
    const v = classifyStorageError({ message: 'The object exceeded the maximum allowed size', status: 413 }, ctx);
    expect(v).toMatchObject({ status: 413, code: 'file_too_large' }); expect(v.message).toMatch(/0013/);
  });
});

describe('banner storage asks the bucket before uploading', () => {
  const src = readFileSync('lib/backend/banner-storage.ts', 'utf8');
  it('checks the live bucket limit first and refuses an oversize file without sending it', () => {
    expect(src).toContain('assertBucketAccepts(bytes.byteLength, mime)');
    expect(src.indexOf('assertBucketAccepts(bytes.byteLength')).toBeLessThan(src.indexOf('.upload(path'));
    expect(src).toContain('bucket_limit_too_small');
  });
  it('checks the effective output limit (default 50 MB, configurable) before anything is sent to Storage', () => {
    expect(src.indexOf('bytes.byteLength > limit')).toBeGreaterThan(-1);
    expect(src.indexOf('bytes.byteLength > limit')).toBeLessThan(src.indexOf('.upload(path'));
    expect(src).toContain('HERO_VIDEO_MAX_OUTPUT_MB');
  });
});
