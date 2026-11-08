/**
 * Lightweight structural readers for the two containers a hero banner video may use. Pure (no I/O, no dependencies, no transcoding).
 *
 * They walk the container's own box / element tree (ISO BMFF for MP4, EBML for WebM) and report the codec each track DECLARES. That is
 * a reliable way to tell H.264 from HEVC, AV1, ProRes, VP9 and so on, which a byte-string scan is not (a codec tag can appear in the
 * brand list, in metadata or by chance in the media data). It still does not prove a file will play: profile, level, bitrate and the
 * visitor's decoder decide that, so callers must never describe the result as guaranteed browser compatibility.
 */

export type ParseFailure = { ok: false; reason: 'not_this_format' | 'incomplete' | 'no_video' | 'malformed'; detail: string };

// ───────────── MP4 / QuickTime (ISO base media file format) ─────────────

export type Mp4Info = {
  brand: string;
  /** The first video track's sample-entry code (e.g. avc1, hvc1, av01, vp09, apch), or '' when there is none. */
  videoCodec: string;
  /** H.264 profile_idc from the avcC box, when the video is H.264. */
  avcProfile: number | null;
  audioCodecs: string[];
  /** True when the movie index (`moov`) comes before the media data, so playback can start before the download ends. */
  fastStart: boolean;
};

type Box = { type: string; start: number; header: number; end: number };

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** Boxes directly inside [from, to). `complete` is false when a box claims to extend past `to` (a cut-off file) or is malformed. */
function readBoxes(b: Uint8Array, from: number, to: number): { boxes: Box[]; complete: boolean } {
  const boxes: Box[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = u32(b, pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return { boxes, complete: false };
      size = u32(b, pos + 8) * 2 ** 32 + u32(b, pos + 12);
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header) return { boxes, complete: false };
    if (pos + size > to) return { boxes, complete: false };
    boxes.push({ type: fourcc(b, pos + 4), start: pos, header, end: pos + size });
    pos += size;
    if (boxes.length > 100_000) return { boxes, complete: false };
  }
  return { boxes, complete: pos === to };
}

const child = (b: Uint8Array, parent: Box, type: string): Box | undefined => readBoxes(b, parent.start + parent.header, parent.end).boxes.find(box => box.type === type);

export function parseMp4(b: Uint8Array): { ok: true; info: Mp4Info } | ParseFailure {
  if (b.length < 16 || fourcc(b, 4) !== 'ftyp') return { ok: false, reason: 'not_this_format', detail: 'no ftyp box' };
  const top = readBoxes(b, 0, b.length);
  if (!top.complete) return { ok: false, reason: 'incomplete', detail: 'the file ends in the middle of a box (it looks cut off or damaged)' };
  const first = top.boxes[0];
  const brand = first && first.type === 'ftyp' ? fourcc(b, first.start + first.header) : '';
  const moov = top.boxes.find(box => box.type === 'moov');
  if (!moov) return { ok: false, reason: 'incomplete', detail: 'it has no movie header (moov)' };
  const mdat = top.boxes.find(box => box.type === 'mdat');

  let videoCodec = '';
  let avcProfile: number | null = null;
  const audioCodecs: string[] = [];
  for (const trak of readBoxes(b, moov.start + moov.header, moov.end).boxes.filter(box => box.type === 'trak')) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = mdia && child(b, mdia, 'hdlr');
    if (!mdia || !hdlr || hdlr.end - (hdlr.start + hdlr.header) < 12) continue;
    const handler = fourcc(b, hdlr.start + hdlr.header + 8);
    const minf = child(b, mdia, 'minf');
    const stbl = minf && child(b, minf, 'stbl');
    const stsd = stbl && child(b, stbl, 'stsd');
    if (!stsd || stsd.end - (stsd.start + stsd.header) < 16) continue;
    const entryAt = stsd.start + stsd.header + 8; // fullbox version/flags (4) + entry_count (4)
    if (u32(b, stsd.start + stsd.header + 4) < 1 || entryAt + 8 > stsd.end) continue;
    const entry = fourcc(b, entryAt + 4);
    if (handler === 'soun') { audioCodecs.push(entry); continue; }
    if (handler !== 'vide' || videoCodec) continue; // only the first video track matters: it is the one a browser plays
    videoCodec = entry;
    if (entry === 'avc1' || entry === 'avc3') {
      const entrySize = u32(b, entryAt);
      const end = Math.min(stsd.end, entryAt + entrySize);
      const kids = readBoxes(b, entryAt + 8 + 78, end).boxes; // VisualSampleEntry fixed fields are 78 bytes, then child boxes
      const avcC = kids.find(box => box.type === 'avcC');
      if (avcC && avcC.end - (avcC.start + avcC.header) >= 2) avcProfile = b[avcC.start + avcC.header + 1];
    }
  }
  if (!videoCodec) return { ok: false, reason: 'no_video', detail: 'it has no video track' };
  return { ok: true, info: { brand, videoCodec, avcProfile, audioCodecs, fastStart: !mdat || moov.start < mdat.start } };
}

// ───────────── WebM / Matroska (EBML) ─────────────

export type WebmInfo = { docType: string; videoCodec: string; audioCodecs: string[] };

const ID_EBML = 0x1a45dfa3;
const ID_DOCTYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;

type Element = { id: number; start: number; dataStart: number; end: number };

const vintLength = (first: number) => { for (let n = 1; n <= 8; n += 1) if (first & (0x80 >> (n - 1))) return n; return 0; };

/** Elements directly inside [from, to). Stops (without failing) at an unknown-size element it cannot skip. */
function readElements(b: Uint8Array, from: number, to: number): { elements: Element[]; ok: boolean } {
  const elements: Element[] = [];
  let pos = from;
  while (pos < to) {
    const idLength = vintLength(b[pos]);
    if (idLength === 0 || idLength > 4 || pos + idLength >= to) return { elements, ok: pos >= to };
    let id = 0;
    for (let k = 0; k < idLength; k += 1) id = id * 256 + b[pos + k];
    const sizeAt = pos + idLength;
    const sizeLength = vintLength(b[sizeAt]);
    if (sizeLength === 0 || sizeAt + sizeLength > to) return { elements, ok: false };
    let size = b[sizeAt] & (0xff >> sizeLength);
    let allOnes = size === (0xff >> sizeLength);
    for (let k = 1; k < sizeLength; k += 1) { size = size * 256 + b[sizeAt + k]; if (b[sizeAt + k] !== 0xff) allOnes = false; }
    const dataStart = sizeAt + sizeLength;
    if (allOnes) { // unknown size (live-style segment): runs to the end of its parent
      elements.push({ id, start: pos, dataStart, end: to });
      return { elements, ok: true };
    }
    if (dataStart + size > to) return { elements, ok: false };
    elements.push({ id, start: pos, dataStart, end: dataStart + size });
    pos = dataStart + size;
    if (elements.length > 100_000) return { elements, ok: false };
  }
  return { elements, ok: true };
}

const text = (b: Uint8Array, e: Element) => String.fromCharCode(...b.subarray(e.dataStart, e.end)).replace(/\0+$/, '');
const uint = (b: Uint8Array, e: Element) => { let v = 0; for (let i = e.dataStart; i < e.end; i += 1) v = v * 256 + b[i]; return v; };

export function parseWebm(b: Uint8Array): { ok: true; info: WebmInfo } | ParseFailure {
  if (b.length < 8 || u32(b, 0) !== ID_EBML) return { ok: false, reason: 'not_this_format', detail: 'no EBML header' };
  const top = readElements(b, 0, b.length).elements;
  const header = top.find(e => e.id === ID_EBML);
  const docTypeElement = header ? readElements(b, header.dataStart, header.end).elements.find(e => e.id === ID_DOCTYPE) : undefined;
  const docType = docTypeElement ? text(b, docTypeElement) : '';
  const segment = top.find(e => e.id === ID_SEGMENT);
  if (!segment) return { ok: false, reason: 'incomplete', detail: 'it has no segment (the file looks cut off or damaged)' };

  let videoCodec = '';
  const audioCodecs: string[] = [];
  for (const element of readElements(b, segment.dataStart, segment.end).elements) {
    if (element.id !== ID_TRACKS) continue;
    for (const entry of readElements(b, element.dataStart, element.end).elements.filter(e => e.id === ID_TRACK_ENTRY)) {
      const fields = readElements(b, entry.dataStart, entry.end).elements;
      const type = fields.find(e => e.id === ID_TRACK_TYPE);
      const codec = fields.find(e => e.id === ID_CODEC_ID);
      if (!type || !codec) continue;
      if (uint(b, type) === 1 && !videoCodec) videoCodec = text(b, codec);
      else if (uint(b, type) === 2) audioCodecs.push(text(b, codec));
    }
  }
  if (!videoCodec) return { ok: false, reason: 'no_video', detail: 'it has no video track' };
  return { ok: true, info: { docType, videoCodec, audioCodecs } };
}
