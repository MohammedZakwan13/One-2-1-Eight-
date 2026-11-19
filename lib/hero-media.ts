import { parseMp4, parseWebm } from './video-structure';

/**
 * Shared (browser + server) rules for hero banner media. Pure: no I/O, no path aliases.
 *
 * Images keep using the existing `media` bucket and the 10 MB image limit (lib/upload-limits.ts).
 * Videos use their own `banner-media` bucket (migration 0010) and the cap below. The cap is a deliberate product limit chosen for
 * a homepage background video, not a provider maximum; it is enforced three times: in the browser, in the upload route and by the
 * bucket's own `file_size_limit`.
 */

export type HeroMediaType = 'image' | 'video';

export const HERO_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
/** What the server stores WITHOUT converting (the original rules): an MP4 (H.264) or WebM (VP8/VP9) of at most 12 MB. */
export const HERO_VIDEO_FORMATS_LABEL = 'MP4 (H.264) or WebM (VP8/VP9)';
/**
 * What the admin may pick: any common video. Larger or non-MP4 files are converted on the server (when FFmpeg is installed) into an H.264 MP4 of at
 * most 12 MB. The browser only filters by extension / MIME type as a convenience; the server re-checks the real contents.
 */
export const HERO_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'webm'] as const;
export const HERO_VIDEO_ACCEPT = ['video/*', ...HERO_VIDEO_EXTENSIONS.map(ext => `.${ext}`)].join(',');
export const HERO_VIDEO_PICKER_LABEL = 'MP4, MOV, MKV, AVI, WMV, FLV, MPEG, M4V, 3GP or WebM';

/** The browser-side check, repeated by the server from the file's bytes. Returns a message, or null when the file may be uploaded. */
export function videoFileProblem(file: { name: string; type: string; size: number }): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!file.type.startsWith('video/') && !(HERO_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return `${file.name}: please choose a video file (${HERO_VIDEO_PICKER_LABEL}).`;
  if (file.size === 0) return `${file.name}: that file is empty.`;
  // No source-size check here on purpose: any size is uploaded in chunks, and the 12 MB limit applies to the PROCESSED video only.
  return null;
}

export type VideoSniff = { ext: 'mp4' | 'webm'; mime: 'video/mp4' | 'video/webm'; warnings: string[]; /** The codec the first video track declares. */ codec: string };
export type VideoRejection = { reason: 'unrecognised' | 'unsupported_container' | 'unsupported_codec' | 'invalid_video'; message: string };

const AUDIO_WARNING = 'This video has an audio track. The banner always plays muted, so the sound is never heard; removing it makes the file smaller.';

const CONVERT_HINT = 'Convert it to MP4 with H.264 video, for example: ffmpeg -i input.mov -c:v libx264 -c:a aac -movflags +faststart output.mp4 (or export "Most Compatible" from your phone or editor).';

const CODEC_NAMES: Record<string, string> = { hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)', dvh1: 'Dolby Vision (HEVC)', dvhe: 'Dolby Vision (HEVC)', av01: 'AV1', vp09: 'VP9 inside an MP4', apch: 'Apple ProRes', apcn: 'Apple ProRes', apcs: 'Apple ProRes', apco: 'Apple ProRes', mp4v: 'MPEG-4 Part 2', s263: 'H.263', mjpa: 'Motion JPEG', jpeg: 'Motion JPEG' };
const WEBM_CODECS: Record<string, string> = { V_VP8: 'VP8', V_VP9: 'VP9' };

/**
 * Identifies a real MP4 or WebM file from its CONTENTS (never from the name or the browser-declared MIME type) by reading the container's
 * own structure (lib/video-structure.ts), not by searching for text.
 *   MP4:  an `ftyp` box, a complete box tree, and a first video track whose declared codec is H.264 (avc1 / avc3). Every other codec
 *         (HEVC, AV1, ProRes, MPEG-4 Part 2, VP9-in-MP4, ...) is refused by name, so nothing is accepted just because it is NOT on a deny list.
 *   WebM: the EBML DocType `webm` and a first video track declaring V_VP8 or V_VP9. Matroska (.mkv) is refused.
 *   QuickTime (`qt  ` brand, a .mov that phones often save under a .MP4 name) is refused with its own explanation, including the codec found inside.
 * What this proves: the container is well formed and the first video track declares a codec this screen supports. What it cannot prove:
 * that every browser will play it. Profile, level, bitrate, the audio track and the visitor's decoder still decide that, so the wording
 * only ever says "supported formats" and never that a file is certain to play. Warnings (not refusals): an H.264 profile outside the common 8-bit
 * Baseline/Main/High set, an index (`moov`) placed after the media data (slow start), and an audio track that a muted banner never plays.
 */
export function inspectHeroVideo(bytes: Uint8Array): { ok: true; video: VideoSniff } | { ok: false; error: VideoRejection } {
  const bad = (reason: VideoRejection['reason'], message: string) => ({ ok: false as const, error: { reason, message } });
  const notVideo = () => bad('unrecognised', `That file is not a ${HERO_VIDEO_FORMATS_LABEL} video. Its contents do not match any supported video format, whatever its file name says.`);

  const webm = parseWebm(bytes);
  if (webm.ok || webm.reason !== 'not_this_format') {
    if (!webm.ok) return bad('invalid_video', `This WebM/Matroska file cannot be used: ${webm.detail}.`);
    if (webm.info.docType !== 'webm') return bad('unsupported_container', 'This is a Matroska (.mkv) file. Only WebM (VP8 or VP9) and MP4 (H.264) are allowed. Re-export it as WebM or MP4.');
    const codec = WEBM_CODECS[webm.info.videoCodec];
    if (!codec) return bad('unsupported_codec', `This WebM uses the video codec ${webm.info.videoCodec.replace(/^V_/, '')}, which this screen does not accept. Use VP8 or VP9 (or an MP4 with H.264).`);
    return { ok: true, video: { ext: 'webm', mime: 'video/webm', warnings: webm.info.audioCodecs.length ? [AUDIO_WARNING] : [], codec } };
  }

  const mp4 = parseMp4(bytes);
  if (!mp4.ok) {
    if (mp4.reason === 'not_this_format') return notVideo();
    return bad('invalid_video', `This MP4 cannot be used: ${mp4.detail}. Upload the file again, or export it again from your editor.`);
  }
  const { brand, videoCodec, avcProfile, audioCodecs, fastStart } = mp4.info;
  const isH264 = videoCodec === 'avc1' || videoCodec === 'avc3';
  const codecName = CODEC_NAMES[videoCodec] ?? `the "${videoCodec.trim()}" codec`;
  if (brand === 'qt  ') {
    const inside = isH264 ? '' : ` that uses ${codecName}${videoCodec === 'hvc1' || videoCodec === 'hev1' ? ', the iPhone default,' : ''}`;
    return bad('unsupported_container', `This is a QuickTime (.mov) video${inside} even though it is named .MP4. Browsers cannot reliably play it. ${CONVERT_HINT}`);
  }
  if (['heic', 'heix', 'mif1', 'avif', 'avis'].includes(brand)) return bad('unrecognised', 'That file is a picture (HEIC/AVIF), not a video.');
  if (['3gp4', '3gp5', '3gp6', '3g2a'].includes(brand)) return bad('unsupported_container', `This is a 3GP phone video. Browsers cannot reliably play it. ${CONVERT_HINT}`);
  if (!isH264) return bad('unsupported_codec', `This MP4 uses ${codecName}, which many browsers cannot play. ${CONVERT_HINT}`);

  const warnings: string[] = [];
  if (avcProfile !== null && ![66, 77, 88, 100].includes(avcProfile)) warnings.push('This H.264 video uses a High 10 / 4:2:2 / 4:4:4 profile that some browsers cannot play. Baseline, Main or High (8-bit) is the safest choice.');
  if (!fastStart) warnings.push('This MP4 is not optimised for streaming ("fast start"). It may start playing late on slow connections. Re-export it with the faststart option.');
  if (audioCodecs.length) warnings.push(AUDIO_WARNING);
  return { ok: true, video: { ext: 'mp4', mime: 'video/mp4', warnings, codec: 'H.264' } };
}

// ───────────── what a visitor receives ─────────────

export type HeroMediaFields = {
  desktopMediaType: HeroMediaType;
  desktopImage: string;
  desktopVideo: string;
  mobileMediaType: HeroMediaType;
  mobileImage: string;
  mobileVideo: string;
  useDesktopOnMobile: boolean;
};

export type ResolvedMedia = { type: HeroMediaType; image: string; video: string };

/**
 * Video is optional. A slot is a VIDEO slot only while it actually has a video file; a slot marked "video" whose file was removed is an
 * image slot (its still image, previously the poster, is the banner image). Used by the admin form, the save rules and the storefront.
 */
export const effectiveMediaType = (type: HeroMediaType, video: string): HeroMediaType => (type === 'video' && video ? 'video' : 'image');

const slot = (type: HeroMediaType, image: string, video: string): ResolvedMedia => ({ type: effectiveMediaType(type, video), image, video });
const hasMedia = (media: ResolvedMedia) => (media.type === 'video' ? Boolean(media.video) : Boolean(media.image));

/**
 * The media a visitor on the given device should get. Mobile uses its own slot unless "use desktop media on mobile" is on or the
 * mobile slot is empty, in which case it falls back to the desktop slot, so a visitor never gets a blank banner.
 * `image` is the still picture: the image itself, or the poster of a video (may be empty).
 */
export function resolveHeroMedia(fields: HeroMediaFields, device: 'desktop' | 'mobile'): ResolvedMedia {
  const desktop = slot(fields.desktopMediaType, fields.desktopImage, fields.desktopVideo);
  if (device === 'desktop') return desktop;
  const mobile = slot(fields.mobileMediaType, fields.mobileImage, fields.mobileVideo);
  return fields.useDesktopOnMobile || !hasMedia(mobile) ? desktop : mobile;
}

/** The still image used for social previews and as the first paint: the first non-empty still of the desktop then mobile slot. */
export const heroStill = (fields: HeroMediaFields): string => fields.desktopImage || fields.mobileImage || '';

export const isValidReorder = (current: string[], next: string[]): boolean =>
  current.length === next.length && new Set(next).size === next.length && next.every(id => current.includes(id));

/** New order with `id` moved one step (negative = earlier). Unchanged when it is already at the edge. */
export function moveId(ids: string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
