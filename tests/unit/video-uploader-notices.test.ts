import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The admin upload summary stays compact: routine conversion notices are not shown, and no notice is shown twice. */
describe('banner video uploader notices (source guards)', () => {
  const src = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
  it('shows only warning-level notes from the processing info, de-duplicated', () => {
    expect(src).toContain("note.level === 'warning'");
    expect(src).toContain('new Set(');
  });
  it('does not render the plain warnings list as well when the processing info is present (that doubled every notice)', () => {
    expect(src).toMatch(/notes\.length > 0 && !\(value && summary\[value\]\?\.info\)/);
  });
  it('keeps the compact summary, mode selector and preview', () => {
    for (const needle of ['hb-video-facts', 'hb-video-modes', 'Ready to publish', '<video']) expect(src).toContain(needle);
  });
  it('the backend still produces the conversion note for logs and job data (diagnostics are untouched)', () => {
    expect(readFileSync('lib/backend/video-transcode.ts', 'utf8')).toContain('Converted for browser playback because');
  });
});
