/**
 * Builders for small, STRUCTURALLY valid MP4 / QuickTime / WebM / Matroska files, so the tests exercise the real container parser
 * instead of hand-made byte strings. They contain no real video data, only the boxes / elements the parser reads.
 */
const ascii = (text: string) => Array.from(text, ch => ch.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const zeros = (n: number) => new Array<number>(n).fill(0);
const flat = (...parts: number[][]) => parts.flat();

const box = (type: string, ...payload: number[][]) => { const body = flat(...payload); return flat(u32(8 + body.length), ascii(type), body); };

type Track = { handler: 'vide' | 'soun'; entry: number[] };
const trak = ({ handler, entry }: Track) => box('trak', box('mdia', box('hdlr', u32(0), u32(0), ascii(handler), zeros(13)), box('minf', box('stbl', box('stsd', u32(0), u32(1), entry)))));

const videoEntry = (codec: string, avcProfile: number) => {
  const config = codec === 'avc1' || codec === 'avc3' ? box('avcC', [1, avcProfile, 0, 31]) : codec === 'hvc1' || codec === 'hev1' ? box('hvcC', zeros(23)) : [];
  return box(codec, zeros(78), config);
};

export type Mp4Options = {
  brand?: string;
  /** Sample-entry code of the first video track (avc1, hvc1, av01, vp09, apch, mp4v ...). `null` = no video track at all. */
  video?: string | null;
  avcProfile?: number;
  audio?: string | null;
  moovFirst?: boolean;
  /** Extra text placed in the ftyp compatible-brands list and in an unrelated `free` box, to prove codec tags there are ignored. */
  noise?: string;
  /** Cuts the file short by this many bytes. */
  truncateBy?: number;
};

export function mp4(options: Mp4Options = {}): Uint8Array {
  const { brand = 'isom', video = 'avc1', avcProfile = 100, audio = null, moovFirst = true, noise = '', truncateBy = 0 } = options;
  const ftyp = box('ftyp', ascii(brand.padEnd(4, ' ')), u32(0), ascii('isom'), ascii(noise.slice(0, 4).padEnd(4, ' ')));
  const tracks = [...(video === null ? [] : [trak({ handler: 'vide', entry: videoEntry(video, avcProfile) })]), ...(audio ? [trak({ handler: 'soun', entry: box(audio, zeros(28)) })] : [])];
  const moov = box('moov', box('mvhd', zeros(100)), ...tracks);
  const mdat = box('mdat', zeros(64));
  const free = noise ? box('free', ascii(noise)) : [];
  const bytes = Uint8Array.from(moovFirst ? flat(ftyp, free, moov, mdat) : flat(ftyp, free, mdat, moov));
  return truncateBy ? bytes.subarray(0, bytes.length - truncateBy) : bytes;
}

// ───────────── EBML (WebM / Matroska) ─────────────

const idBytes = (id: number) => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; };
const element = (id: number, ...payload: number[][]) => { const body = flat(...payload); return flat(idBytes(id), [0x10 | ((body.length >>> 24) & 0x0f), (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255], body); };

export type WebmOptions = { docType?: string; video?: string | null; audio?: string | null; truncateBy?: number; unknownSizeSegment?: boolean };

export function webm(options: WebmOptions = {}): Uint8Array {
  const { docType = 'webm', video = 'V_VP9', audio = null, truncateBy = 0, unknownSizeSegment = false } = options;
  const entry = (type: number, codec: string) => element(0xae, element(0xd7, [type]), element(0x83, [type]), element(0x86, ascii(codec)));
  const tracks = element(0x1654ae6b, ...(video === null ? [] : [entry(1, video)]), ...(audio ? [entry(2, audio)] : []));
  const cluster = element(0x1f43b675, element(0xe7, [0]));
  const content = flat(element(0x1549a966, element(0x2ad7b1, [0x0f, 0x42, 0x40])), tracks, cluster);
  const segment = unknownSizeSegment ? flat(idBytes(0x18538067), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], content) : element(0x18538067, content);
  const bytes = Uint8Array.from(flat(element(0x1a45dfa3, element(0x4282, ascii(docType))), segment));
  return truncateBy ? bytes.subarray(0, bytes.length - truncateBy) : bytes;
}
