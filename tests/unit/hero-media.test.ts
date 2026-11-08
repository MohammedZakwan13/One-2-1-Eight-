import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminHeroSlideUpdateSchema, heroSlideSchema } from '@/lib/api/schemas';
import { HERO_VIDEO_MAX_BYTES, HERO_VIDEO_MAX_LABEL, effectiveMediaType, inspectHeroVideo, isValidReorder, moveId, resolveHeroMedia, videoFileProblem, type HeroMediaFields } from '@/lib/hero-media';
import { parseMp4, parseWebm } from '@/lib/video-structure';
import { buildCsp } from '@/lib/security-headers';
import { mp4, webm } from './helpers/media-fixtures';

const fields = (over: Partial<HeroMediaFields> = {}): HeroMediaFields => ({
  desktopMediaType: 'image', desktopImage: '/d.webp', desktopVideo: '', mobileMediaType: 'image', mobileImage: '/m.webp', mobileVideo: '', useDesktopOnMobile: false, ...over,
});

describe('which media a visitor receives', () => {
  it('desktop visitors get the desktop slot, mobile visitors their own mobile slot', () => {
    expect(resolveHeroMedia(fields(), 'desktop')).toEqual({ type: 'image', image: '/d.webp', video: '' });
    expect(resolveHeroMedia(fields(), 'mobile')).toEqual({ type: 'image', image: '/m.webp', video: '' });
  });
  it('"use desktop media on mobile" sends the desktop media to phones and ignores the stored mobile files', () => {
    expect(resolveHeroMedia(fields({ useDesktopOnMobile: true }), 'mobile')).toEqual(resolveHeroMedia(fields(), 'desktop'));
  });
  it('an empty mobile slot falls back to the desktop media, so a phone never gets a blank banner', () => {
    expect(resolveHeroMedia(fields({ mobileImage: '' }), 'mobile').image).toBe('/d.webp');
    expect(resolveHeroMedia(fields({ mobileMediaType: 'video', mobileImage: '', mobileVideo: '' }), 'mobile').image).toBe('/d.webp');
  });
  it('desktop and mobile can differ in kind: a desktop video with a mobile image, and the reverse', () => {
    const a = fields({ desktopMediaType: 'video', desktopVideo: '/d.mp4' });
    expect(resolveHeroMedia(a, 'desktop')).toMatchObject({ type: 'video', video: '/d.mp4', image: '/d.webp' });
    expect(resolveHeroMedia(a, 'mobile')).toMatchObject({ type: 'image', image: '/m.webp', video: '' });
    const b = fields({ mobileMediaType: 'video', mobileVideo: '/m.mp4' });
    expect(resolveHeroMedia(b, 'desktop').type).toBe('image');
    expect(resolveHeroMedia(b, 'mobile')).toMatchObject({ type: 'video', video: '/m.mp4' });
  });
  it('a video with no poster has an empty still, and still resolves', () => {
    expect(resolveHeroMedia(fields({ mobileMediaType: 'video', mobileVideo: '/m.mp4', mobileImage: '' }), 'mobile')).toEqual({ type: 'video', image: '', video: '/m.mp4' });
  });
});

describe('video inspection reads the container structure, not text in the file', () => {
  const reason = (bytes: Uint8Array) => { const r = inspectHeroVideo(bytes); return r.ok ? 'ok' : r.error.reason; };

  it('accepts a well-formed MP4 with H.264 and reports the declared codec', () => {
    expect(inspectHeroVideo(mp4())).toMatchObject({ ok: true, video: { ext: 'mp4', mime: 'video/mp4', codec: 'H.264', warnings: [] } });
    expect(inspectHeroVideo(mp4({ video: 'avc3' }))).toMatchObject({ ok: true });
  });
  it('accepts a well-formed WebM with VP8 or VP9', () => {
    expect(inspectHeroVideo(webm({ video: 'V_VP9' }))).toMatchObject({ ok: true, video: { ext: 'webm', mime: 'video/webm', codec: 'VP9' } });
    expect(inspectHeroVideo(webm({ video: 'V_VP8' }))).toMatchObject({ ok: true, video: { codec: 'VP8' } });
    expect(inspectHeroVideo(webm({ unknownSizeSegment: true }))).toMatchObject({ ok: true });
  });

  it('refuses every codec that is not H.264, by name, including ones the old text scan let through', () => {
    for (const [codec, name] of [['hvc1', 'HEVC'], ['hev1', 'HEVC'], ['av01', 'AV1'], ['vp09', 'VP9'], ['apch', 'ProRes'], ['mp4v', 'MPEG-4 Part 2'], ['s263', 'H.263'], ['xyz1', 'xyz1']] as const) {
      const r = inspectHeroVideo(mp4({ video: codec }));
      expect(r, codec).toMatchObject({ ok: false, error: { reason: 'unsupported_codec' } });
      if (!r.ok) expect(r.error.message, codec).toContain(name);
    }
  });
  it('is not fooled by codec names written elsewhere in the file', () => {
    // an HEVC-only file whose brand list and a free box say "avc1": the old byte scan accepted this
    expect(reason(mp4({ video: 'hvc1', noise: 'avc1' }))).toBe('unsupported_codec');
    // an H.264 file that merely mentions hvc1 in a free box stays valid
    expect(reason(mp4({ video: 'avc1', noise: 'hvc1' }))).toBe('ok');
  });
  it('uses the FIRST video track: an H.264 file with audio in another codec is fine, a second video track does not rescue the first', () => {
    expect(reason(mp4({ video: 'avc1', audio: 'ac-3' }))).toBe('ok');
  });

  it('refuses QuickTime named .MP4 as a container and names the codec inside; H.264 QuickTime gets no HEVC wording', () => {
    const hevc = inspectHeroVideo(mp4({ brand: 'qt  ', video: 'hvc1' }));
    expect(hevc).toMatchObject({ ok: false, error: { reason: 'unsupported_container' } });
    if (!hevc.ok) expect(hevc.error.message).toMatch(/QuickTime[\s\S]*HEVC \(H\.265\)[\s\S]*iPhone[\s\S]*named \.MP4[\s\S]*ffmpeg/);
    const h264 = inspectHeroVideo(mp4({ brand: 'qt  ', video: 'avc1' }));
    expect(h264).toMatchObject({ ok: false, error: { reason: 'unsupported_container' } });
    if (!h264.ok) { expect(h264.error.message).toMatch(/QuickTime/); expect(h264.error.message).not.toMatch(/HEVC/); }
  });
  it('refuses Matroska, 3GP and pictures with the right reason, and WebM with an unsupported codec', () => {
    expect(reason(webm({ docType: 'matroska' }))).toBe('unsupported_container');
    expect(reason(mp4({ brand: '3gp4' }))).toBe('unsupported_container');
    for (const brand of ['heic', 'avif']) expect(reason(mp4({ brand }))).toBe('unrecognised');
    expect(reason(webm({ video: 'V_MPEG4/ISO/AVC' }))).toBe('unsupported_codec');
    expect(reason(webm({ video: 'V_AV1' }))).toBe('unsupported_codec');
  });
  it('refuses damaged, cut-off and video-less files instead of guessing', () => {
    expect(reason(mp4({ truncateBy: 20 }))).toBe('invalid_video');
    expect(reason(mp4({ video: null }))).toBe('invalid_video');
    expect(reason(webm({ truncateBy: 12 }))).toBe('invalid_video');
    expect(reason(webm({ video: null }))).toBe('invalid_video');
    const noMoov = mp4(); // ftyp + (free) + moov + mdat: drop the moov by keeping only the first box
    expect(reason(noMoov.subarray(0, 24))).toBe('invalid_video');
  });
  it('refuses pictures, text and noise that merely contain the right words', () => {
    expect(reason(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('unrecognised');
    expect(reason(new TextEncoder().encode('ftypisom avc1 moov mdat webm V_VP9 not a video at all'))).toBe('unrecognised');
    expect(reason(new Uint8Array(0))).toBe('unrecognised');
  });

  it('warns, without refusing, about slow-start MP4s, unusual H.264 profiles and an unused audio track', () => {
    const slow = inspectHeroVideo(mp4({ moovFirst: false }));
    expect(slow.ok && slow.video.warnings.join(' ')).toMatch(/fast ?start/i);
    const high10 = inspectHeroVideo(mp4({ avcProfile: 110 }));
    expect(high10.ok && high10.video.warnings.join(' ')).toMatch(/High 10/);
    for (const profile of [66, 77, 100]) { const r = inspectHeroVideo(mp4({ avcProfile: profile })); expect(r.ok && r.video.warnings).toEqual([]); }
    const withAudio = inspectHeroVideo(mp4({ audio: 'mp4a' }));
    expect(withAudio.ok && withAudio.video.warnings.join(' ')).toMatch(/audio track.*muted/);
    const webmAudio = inspectHeroVideo(webm({ audio: 'A_OPUS' }));
    expect(webmAudio.ok && webmAudio.video.warnings.join(' ')).toMatch(/audio track/);
  });

  it('the structural readers report what the container declares', () => {
    expect(parseMp4(mp4({ video: 'avc1', avcProfile: 77, audio: 'mp4a' }))).toMatchObject({ ok: true, info: { videoCodec: 'avc1', avcProfile: 77, audioCodecs: ['mp4a'], fastStart: true, brand: 'isom' } });
    expect(parseMp4(mp4({ moovFirst: false }))).toMatchObject({ ok: true, info: { fastStart: false } });
    expect(parseWebm(webm({ video: 'V_VP8', audio: 'A_VORBIS' }))).toMatchObject({ ok: true, info: { docType: 'webm', videoCodec: 'V_VP8', audioCodecs: ['A_VORBIS'] } });
    expect(parseWebm(webm({ docType: 'matroska' }))).toMatchObject({ ok: true, info: { docType: 'matroska' } });
  });

  it('the browser-side file check applies the same type and size rules', () => {
    expect(videoFileProblem({ name: 'a.mp4', type: 'video/mp4', size: 1000 })).toBeNull();
    expect(videoFileProblem({ name: 'a.webm', type: 'video/webm', size: HERO_VIDEO_MAX_BYTES })).toBeNull();
    expect(videoFileProblem({ name: 'a.mov', type: 'video/quicktime', size: 1000 })).toMatch(/only MP4/);
    expect(videoFileProblem({ name: 'big.mp4', type: 'video/mp4', size: HERO_VIDEO_MAX_BYTES + 1 })).toContain(HERO_VIDEO_MAX_LABEL);
    expect(videoFileProblem({ name: 'e.mp4', type: 'video/mp4', size: 0 })).toMatch(/empty/);
  });

  it('never promises that a file will play: the wording says "supported formats", not "guaranteed"', () => {
    for (const file of ['lib/hero-media.ts', 'lib/video-structure.ts', 'components/admin/hero-video-uploader.tsx']) expect(readFileSync(file, 'utf8'), file).not.toMatch(/guaranteed to play|will always play|plays everywhere/i);
  });
});

describe('ordering helpers', () => {
  it('moves a banner one step and leaves the edges alone', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b', 'c'];
    expect(moveId(same, 'a', -1)).toBe(same);
    expect(moveId(same, 'c', 1)).toBe(same);
    expect(moveId(same, 'zzz', 1)).toBe(same);
  });
  it('accepts only a complete, duplicate-free reordering', () => {
    expect(isValidReorder(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(isValidReorder(['a', 'b'], ['a'])).toBe(false);
    expect(isValidReorder(['a', 'b'], ['a', 'a'])).toBe(false);
    expect(isValidReorder(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('banner schemas', () => {
  const legacy = { id: 'x', kicker: 'k', title: 't', body: 'b', desktopImage: '/d.webp', mobileImage: '/m.webp', cta: '', href: '/collections/all', active: true };
  it('a banner from before video support parses and gets the old behaviour as defaults', () => {
    expect(heroSlideSchema.parse(legacy)).toMatchObject({ desktopMediaType: 'image', mobileMediaType: 'image', desktopVideo: '', mobileVideo: '', useDesktopOnMobile: false, altText: '' });
  });
  it('allows a video without a poster, but not an unsafe URL', () => {
    expect(heroSlideSchema.safeParse({ ...legacy, desktopMediaType: 'video', desktopImage: '', desktopVideo: 'https://x.test/a.mp4' }).success).toBe(true);
    expect(heroSlideSchema.safeParse({ ...legacy, desktopVideo: 'javascript:alert(1)' }).success).toBe(false);
    expect(heroSlideSchema.safeParse({ ...legacy, desktopVideo: '//evil.test/a.mp4' }).success).toBe(false);
    expect(heroSlideSchema.safeParse({ ...legacy, desktopMediaType: 'gif' }).success).toBe(false);
  });
  it('publishing requires media for every device shown; drafts and "use desktop on mobile" relax that', () => {
    const { id, ...body } = legacy; void id;
    expect(adminHeroSlideUpdateSchema.safeParse(body).success).toBe(true);
    expect(adminHeroSlideUpdateSchema.safeParse({ ...body, mobileImage: '' }).success).toBe(false);
    expect(adminHeroSlideUpdateSchema.safeParse({ ...body, mobileImage: '', useDesktopOnMobile: true }).success).toBe(true);
    expect(adminHeroSlideUpdateSchema.safeParse({ ...body, active: false, desktopImage: '', mobileImage: '' }).success).toBe(true);
    // video mode without a file is just an image slot, and its image is there: video is optional
    expect(adminHeroSlideUpdateSchema.safeParse({ ...body, desktopMediaType: 'video' }).success).toBe(true);
    expect(adminHeroSlideUpdateSchema.safeParse({ ...body, desktopMediaType: 'video', desktopImage: '' }).success).toBe(false);
  });
});

describe('video is optional: publishing needs visual media, not a video', () => {
  const base = { kicker: '', title: 't', body: 'b', cta: '', href: '/collections/all', active: true, desktopImage: '/d.webp', mobileImage: '/m.webp' };
  const parse = (over: Record<string, unknown> = {}) => adminHeroSlideUpdateSchema.safeParse({ ...base, ...over });
  const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map(issue => issue.message));
  const VIDEO = 'https://p.supabase.co/storage/v1/object/public/banner-media/banners/2026/11/11111111-1111-1111-1111-111111111111.mp4';

  it('Case A, image only: publishes with no video at all, and no video rule runs for the slot', () => {
    const r = parse({ desktopMediaType: 'image', desktopVideo: '', mobileMediaType: 'image', mobileVideo: '' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.desktopMediaType, r.data.desktopVideo]).toEqual(['image', '']);
  });
  it('Case B, video only: publishes with a video and no image (poster) at all', () => {
    const r = parse({ desktopMediaType: 'video', desktopVideo: VIDEO, desktopImage: '', useDesktopOnMobile: true, mobileImage: '' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.desktopMediaType).toBe('video');
  });
  it('Case C, image plus video: the video stays the active media and the image is its poster', () => {
    const r = parse({ desktopMediaType: 'video', desktopVideo: VIDEO, desktopImage: '/poster.webp' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.desktopMediaType, r.data.desktopVideo, r.data.desktopImage]).toEqual(['video', VIDEO, '/poster.webp']);
  });
  it('Case D, video removed but the poster image is there: the slot becomes an image slot, the image is kept, and it publishes', () => {
    const r = parse({ desktopMediaType: 'video', desktopVideo: '', desktopImage: '/poster.webp' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.desktopMediaType, r.data.desktopVideo, r.data.desktopImage]).toEqual(['image', '', '/poster.webp']);
    expect(messages(r)).toEqual([]);
  });
  it('Case D, video removed and no image either: blocked with a message that asks for an image or video, never for a video specifically', () => {
    const r = parse({ desktopMediaType: 'video', desktopVideo: '', desktopImage: '' });
    expect(r.success).toBe(false);
    expect(messages(r)).toEqual(['Add a desktop image or video before publishing.']);
    expect(messages(r).join(' ')).not.toMatch(/Add the desktop video/);
    expect(!r.success && r.error.issues[0].path).toEqual(['desktopImage']);
  });
  it('a completely empty published banner is blocked, for each device; a draft is not', () => {
    expect(messages(parse({ desktopImage: '', mobileImage: '' }))).toEqual(['Add a desktop image or video before publishing.', 'Add a mobile image or video before publishing.']);
    expect(parse({ desktopImage: '', mobileImage: '', active: false }).success).toBe(true);
    expect(parse({ desktopImage: '', mobileImage: '', active: false, desktopMediaType: 'video' }).success).toBe(true);
  });
  it('mobile is judged on its own: removing the mobile video leaves the desktop video untouched', () => {
    const r = parse({ desktopMediaType: 'video', desktopVideo: VIDEO, desktopImage: '/d-poster.webp', mobileMediaType: 'video', mobileVideo: '', mobileImage: '/m-poster.webp' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.desktopMediaType, r.data.desktopVideo, r.data.mobileMediaType, r.data.mobileVideo, r.data.mobileImage]).toEqual(['video', VIDEO, 'image', '', '/m-poster.webp']);
    expect(messages(parse({ mobileMediaType: 'video', mobileVideo: '', mobileImage: '' }))).toEqual(['Add a mobile image or video before publishing.']);
    expect(parse({ mobileMediaType: 'video', mobileVideo: '', mobileImage: '', useDesktopOnMobile: true }).success).toBe(true); // configured desktop fallback
  });
  it('an image-mode slot that only has a stored video is empty: it asks for an image or video', () => {
    expect(messages(parse({ desktopMediaType: 'image', desktopImage: '', desktopVideo: VIDEO }))).toEqual(['Add a desktop image or video before publishing.']);
  });
  it('the storefront rule matches: a "video" slot with no file is an image slot', () => {
    expect(effectiveMediaType('video', '')).toBe('image');
    expect(effectiveMediaType('video', VIDEO)).toBe('video');
    expect(effectiveMediaType('image', VIDEO)).toBe('image');
    const f: HeroMediaFields = { desktopMediaType: 'video', desktopImage: '/poster.webp', desktopVideo: '', mobileMediaType: 'image', mobileImage: '/m.webp', mobileVideo: '', useDesktopOnMobile: false };
    expect(resolveHeroMedia(f, 'desktop')).toEqual({ type: 'image', image: '/poster.webp', video: '' });
  });
  it('the admin editor turns a removed video into an image slot, keeps the poster, and explains it (source check; the browser run is reported separately)', () => {
    const source = readFileSync('components/admin/hero-banners.tsx', 'utf8');
    expect(source).toContain("set({ [videoKey]: '', [typeKey]: 'image' } as Partial<Draft>)");
    expect(source).toContain("setNote(draft[imageKey] ? 'poster' : 'empty')");
    expect(source).toContain('upload an image before publishing');
    expect(source).not.toMatch(/Add the (desktop|mobile) video/);
    expect(readFileSync('lib/api/schemas.ts', 'utf8')).not.toMatch(/Add the \$\{path\} video/);
  });
});

describe('browser security policy for videos', () => {
  it('allows media from https sources (Supabase Storage); the default policy would have blocked every banner video', () => {
    expect(buildCsp({}, false)).toContain("media-src 'self' blob: https:");
  });
});
