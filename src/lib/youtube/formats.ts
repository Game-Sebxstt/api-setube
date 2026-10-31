import { isIP } from 'node:net';

export type OutputFormat = 'mp3' | 'm4a' | 'wav' | 'mp4';
export type Mp3Quality = 128 | 192 | 320;
export type Mp4Quality = 360 | 480 | 720 | 1080 | 'best';
export type Quality = Mp3Quality | Mp4Quality | null;
export type FormatGap = 'only_fragmented' | 'no_avc1' | 'no_m4a';
export type Protocol = 'https' | 'm3u8_native';

export interface AudioFormat {
  formatId: string;
  abr: number | null;
  bytes: number | null;
}
export interface HlsAudioFormat {
  formatId: string;
  abr: number | null;
  bytes: null;
  acodec: string;
}
export interface VideoFormat {
  height: number;
  formatId: string;
  fps: number | null;
  bytes: number | null;
}

export interface MetaFormats {
  audio: { opus?: AudioFormat; m4a?: AudioFormat; hls?: HlsAudioFormat };
  formatGaps: FormatGap[];
  video: VideoFormat[];
  audioForVideo?: { formatId: string; bytes: number | null };
}

export interface RawFormat {
  format_id?: unknown;
  protocol?: unknown;
  ext?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  abr?: unknown;
  tbr?: unknown;
  height?: unknown;
  fps?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
  format_note?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bytesOf = (f: RawFormat) => {
  const b = num(f.filesize) ?? num(f.filesize_approx);
  return b === null ? null : Math.round(b);
};
const isAudioOnly = (f: RawFormat) => str(f.acodec) !== '' && str(f.acodec) !== 'none' && (str(f.vcodec) === 'none' || str(f.vcodec) === '');
const isHttps = (f: RawFormat) => str(f.protocol) === 'https';
const rate = (f: RawFormat) => num(f.abr) ?? num(f.tbr) ?? 0;

function best<T extends RawFormat>(list: T[], score: (f: T) => number): T | undefined {
  let out: T | undefined;
  for (const f of list) if (!out || score(f) > score(out)) out = f;
  return out;
}

const toAudio = (f: RawFormat): AudioFormat => ({ formatId: str(f.format_id), abr: num(f.abr), bytes: bytesOf(f) });

export function deriveFormats(raw: readonly RawFormat[]): MetaFormats {
  const formats = raw.filter((f) => str(f.format_id) !== '' && str(f.format_note) !== 'storyboard' && str(f.ext) !== 'mhtml');
  const audioAll = formats.filter(isAudioOnly);
  const audioHttps = audioAll.filter(isHttps);
  const opus = best(audioHttps.filter((f) => str(f.acodec).startsWith('opus')), rate);
  const m4a = best(audioHttps.filter((f) => str(f.ext) === 'm4a' && str(f.acodec).startsWith('mp4a')), rate);

  const audio: MetaFormats['audio'] = {};
  if (opus) audio.opus = toAudio(opus);
  if (m4a) audio.m4a = toAudio(m4a);
  if (audioHttps.length === 0) {
    const hls = best(audioAll.filter((f) => str(f.protocol) === 'm3u8_native'), rate);
    if (hls) audio.hls = { formatId: str(hls.format_id), abr: num(hls.abr), bytes: null, acodec: str(hls.acodec) };
  }

  const avc1All = formats.filter(
    (f) => str(f.vcodec).startsWith('avc1') && str(f.acodec) === 'none' && str(f.ext) === 'mp4' && (num(f.height) ?? 0) > 0,
  );
  const avc1 = avc1All.filter((f) => isHttps(f) && (num(f.height) ?? 0) <= 1080);
  const byHeight = new Map<number, RawFormat>();
  for (const f of avc1) {
    const h = num(f.height) as number;
    const prev = byHeight.get(h);
    if (!prev || (num(f.tbr) ?? 0) > (num(prev.tbr) ?? 0)) byHeight.set(h, f);
  }
  const video: VideoFormat[] = [...byHeight.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([height, f]) => ({ height, formatId: str(f.format_id), fps: num(f.fps), bytes: bytesOf(f) }));

  const gaps = new Set<FormatGap>();
  if ((audioHttps.length === 0 && audioAll.length > 0) || (video.length === 0 && avc1All.some((f) => !isHttps(f)))) {
    gaps.add('only_fragmented');
  }
  if (avc1All.length === 0) gaps.add('no_avc1');
  if (!m4a) gaps.add('no_m4a');

  const out: MetaFormats = { audio, formatGaps: [...gaps], video };
  if (audio.m4a) out.audioForVideo = { formatId: audio.m4a.formatId, bytes: audio.m4a.bytes };
  return out;
}

export interface SelectionProc {
  role: 'A' | 'V';
  formatId: string;
  bytes: number | null;
}

export interface Selection {
  format: OutputFormat;
  quality: Quality;
  ext: 'mp3' | 'm4a' | 'wav' | 'mp4';
  contentType: 'audio/mpeg' | 'audio/mp4' | 'audio/wav' | 'video/mp4';
  procs: SelectionProc[];
  protocol: Protocol;
  transcode: boolean;
  height?: number;
}

export type SelectResult = { ok: true; selection: Selection } | { ok: false; code: 'FORMAT_UNAVAILABLE'; reason: FormatGap };

const CONTENT_TYPE = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4' } as const;

function audioGap(meta: MetaFormats): FormatGap {
  return meta.formatGaps.includes('only_fragmented') ? 'only_fragmented' : 'no_m4a';
}

export function selectFormats(
  meta: MetaFormats,
  format: OutputFormat,
  quality: Quality,
  opts: { audioHlsFallback: boolean },
): SelectResult {
  const base = { format, quality, ext: format, contentType: CONTENT_TYPE[format] } as const;

  if (format === 'mp4') {
    if (meta.video.length === 0) {
      return { ok: false, code: 'FORMAT_UNAVAILABLE', reason: meta.formatGaps.includes('no_avc1') ? 'no_avc1' : 'only_fragmented' };
    }
    if (!meta.audioForVideo) return { ok: false, code: 'FORMAT_UNAVAILABLE', reason: 'no_m4a' };
    const target = quality === 'best' || quality === null ? 1080 : (quality as number);
    const below = meta.video.filter((v) => v.height <= target);
    // Mayor altura ≤ H; si no hay ninguna, la más baja disponible
    const v = below.length ? (below[below.length - 1] as VideoFormat) : (meta.video[0] as VideoFormat);
    return {
      ok: true,
      selection: {
        ...base,
        procs: [
          { role: 'V', formatId: v.formatId, bytes: v.bytes },
          { role: 'A', formatId: meta.audioForVideo.formatId, bytes: meta.audioForVideo.bytes },
        ],
        protocol: 'https',
        transcode: false,
        height: v.height,
      },
    };
  }

  const { opus, m4a, hls } = meta.audio;
  if (format === 'm4a') {
    const src = m4a ?? opus;
    if (src) {
      return {
        ok: true,
        selection: { ...base, procs: [{ role: 'A', formatId: src.formatId, bytes: src.bytes }], protocol: 'https', transcode: !m4a },
      };
    }
  } else {
    const src = best([opus, m4a].filter((x): x is AudioFormat => !!x), (a) => a.abr ?? 0);
    if (src) {
      return {
        ok: true,
        selection: { ...base, procs: [{ role: 'A', formatId: src.formatId, bytes: src.bytes }], protocol: 'https', transcode: false },
      };
    }
  }
  if (hls && opts.audioHlsFallback) {
    return {
      ok: true,
      selection: {
        ...base,
        procs: [{ role: 'A', formatId: hls.formatId, bytes: null }],
        protocol: 'm3u8_native',
        transcode: format === 'm4a' && !hls.acodec.startsWith('mp4a'),
      },
    };
  }
  return { ok: false, code: 'FORMAT_UNAVAILABLE', reason: hls ? 'only_fragmented' : audioGap(meta) };
}

export function estimateBytes(
  meta: MetaFormats & { duration: number },
  format: OutputFormat,
  quality: Quality,
  opts: { audioHlsFallback: boolean },
): number | null {
  const d = meta.duration;
  if (format === 'mp3') return Math.round((((quality as number | null) ?? 192) * 1000) / 8 * d);
  if (format === 'wav') return 44100 * 2 * 2 * d + 44;
  const r = selectFormats(meta, format, quality, opts);
  if (!r.ok) return null;
  if (r.selection.transcode) return Math.round((192 * 1000) / 8 * d);
  let total = 0;
  for (const p of r.selection.procs) {
    if (p.bytes === null) return null;
    total += p.bytes;
  }
  return total;
}

export type Codec = 'aac' | 'opus';

export interface Source {
  formatId: string;
  url: string;
  headers: Record<string, string>;
  size: number | null;
  contentType: 'audio/mp4' | 'audio/webm' | 'video/mp4';
  expire: number;
  availableAt: number | null;
  urlIpFamily: 4 | 6 | null;
}

const DRC = /(^|-)drc(-|$)/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function googlevideoUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.endsWith('.googlevideo.com') ? u : null;
  } catch {
    return null;
  }
}

function previewHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const lk = k.toLowerCase();
      if (lk === 'cookie' || lk === 'accept-encoding' || lk === 'range' || typeof v !== 'string') continue;
      out[k] = v;
    }
  }
  out['Accept-Encoding'] = 'identity';
  return out;
}

const ipFamily = (u: URL): 4 | 6 | null => {
  const fam = isIP(u.searchParams.get('ip') ?? '');
  return fam === 4 || fam === 6 ? fam : null;
};

const posInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

// Orden total y estable: la misma info siempre produce el mismo primer candidato
export function rankPreviewFormats(info: Record<string, unknown>, codec?: Codec): Source[] {
  const formats = Array.isArray(info.formats) ? info.formats.filter(isObj) : [];
  type Cand = { f: Record<string, unknown>; u: URL; group: Codec };
  const cands: Cand[] = [];
  for (const f of formats) {
    if (str(f.vcodec) !== 'none' || str(f.acodec) === '' || str(f.acodec) === 'none') continue;
    if (str(f.protocol) !== 'https' || f.has_drm === true || str(f.format_id) === '') continue;
    const u = googlevideoUrl(f.url);
    if (!u) continue;
    const acodec = str(f.acodec);
    const ext = str(f.ext);
    if (ext === 'm4a' && acodec.startsWith('mp4a')) cands.push({ f, u, group: 'aac' });
    else if (ext === 'webm' && acodec.startsWith('opus')) cands.push({ f, u, group: 'opus' });
  }
  const first: Codec = codec === 'opus' ? 'opus' : 'aac';
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
  const asc = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);
  const lc = (s: string) => (s.startsWith('mp4a.40.2') ? 0 : s.startsWith('mp4a.40.5') ? 1 : 2);
  cands.sort((a, b) => {
    const ida = str(a.f.format_id);
    const idb = str(b.f.format_id);
    return (
      asc(a.group === first ? 0 : 1, b.group === first ? 0 : 1) ||
      asc(DRC.test(ida) ? 1 : 0, DRC.test(idb) ? 1 : 0) ||
      asc(n(b.f.language_preference), n(a.f.language_preference)) ||
      asc(lc(str(a.f.acodec)), lc(str(b.f.acodec))) ||
      asc(n(b.f.quality), n(a.f.quality)) ||
      asc(n(b.f.abr), n(a.f.abr)) ||
      (ida < idb ? -1 : ida > idb ? 1 : 0)
    );
  });
  return cands.map(({ f, u, group }) => toSource(f, u, group === 'aac' ? 'audio/mp4' : 'audio/webm'));
}

function toSource(f: Record<string, unknown>, u: URL, contentType: Source['contentType']): Source {
  return {
    formatId: str(f.format_id),
    url: f.url as string,
    headers: previewHeaders(f.http_headers),
    size: posInt(f.filesize) ?? posInt(f.clen) ?? posInt(u.searchParams.get('clen')),
    contentType,
    expire: Number(u.searchParams.get('expire')) || 0,
    availableAt: typeof f.available_at === 'number' && Number.isFinite(f.available_at) ? f.available_at : null,
    urlIpFamily: ipFamily(u),
  };
}

export interface VideoRendition extends Source {
  contentType: 'video/mp4';
  width: number | null;
  height: number;
  /** Calidad nominal (360, 720, 1080…): el lado corto, min(width, height); height si falta width. */
  quality: number;
  fps: number | null;
  tbr: number | null;
  vcodec: string;
}

/**
 * Variantes de video para el streaming HLS: avc1 en mp4 sin audio, https, sin DRM y de googlevideo; la de mayor tbr
 * por calidad. La calidad se mide por el lado corto, como YouTube: un Short 1080x1920 es 1080p y entra con maxHeight
 * 1080. width y height se conservan tal cual para el RESOLUTION del playlist.
 */
export function videoPreviewRenditions(info: Record<string, unknown>, maxHeight: number): VideoRendition[] {
  const formats = Array.isArray(info.formats) ? info.formats.filter(isObj) : [];
  const byQuality = new Map<number, VideoRendition>();
  for (const f of formats) {
    if (!str(f.vcodec).startsWith('avc1') || str(f.acodec) !== 'none' || str(f.ext) !== 'mp4') continue;
    if (str(f.protocol) !== 'https' || f.has_drm === true || str(f.format_id) === '') continue;
    const height = posInt(f.height);
    if (height === null) continue;
    const width = posInt(f.width);
    const quality = width === null ? height : Math.min(width, height);
    if (quality > maxHeight) continue;
    const u = googlevideoUrl(f.url);
    if (!u) continue;
    const r: VideoRendition = {
      ...toSource(f, u, 'video/mp4'),
      contentType: 'video/mp4',
      width,
      height,
      quality,
      fps: num(f.fps),
      tbr: num(f.tbr),
      vcodec: str(f.vcodec),
    };
    const prev = byQuality.get(quality);
    if (!prev || better(r, prev)) byQuality.set(quality, r);
  }
  return [...byQuality.values()].sort((a, b) => a.quality - b.quality);
}

// Mayor tbr; a igualdad, más fps y el format_id menor, para que la elección sea estable
function better(a: VideoRendition, b: VideoRendition): boolean {
  const ta = a.tbr ?? -1;
  const tb = b.tbr ?? -1;
  if (ta !== tb) return ta > tb;
  const fa = a.fps ?? -1;
  const fb = b.fps ?? -1;
  if (fa !== fb) return fa > fb;
  return a.formatId < b.formatId;
}

// Fuente de un formato concreto si está en la lista permitida (variantes de video + mejor m4a); si no, null
export function previewSourceFor(info: Record<string, unknown>, formatId: string, maxHeight: number): Source | null {
  const video = videoPreviewRenditions(info, maxHeight).find((r) => r.formatId === formatId);
  if (video) return video;
  const audio = previewAudioSource(info);
  return audio && audio.formatId === formatId ? audio : null;
}

// Mejor m4a (AAC) para el grupo de audio del HLS; el opus no vale en fMP4/HLS
export function previewAudioSource(info: Record<string, unknown>): Source | null {
  const first = rankPreviewFormats(info, 'aac')[0];
  return first && first.contentType === 'audio/mp4' ? first : null;
}

export interface AudioRendition extends Source {
  acodec: string;
  abr: number | null;
}

// El mismo m4a que previewAudioSource, con el códec y el bitrate para el grupo de audio del master HLS
export function previewAudioRendition(info: Record<string, unknown>): AudioRendition | null {
  const src = previewAudioSource(info);
  if (!src) return null;
  const formats = Array.isArray(info.formats) ? info.formats.filter(isObj) : [];
  const raw = formats.find((f) => str(f.format_id) === src.formatId && f.url === src.url);
  return { ...src, acodec: str(raw?.acodec), abr: num(raw?.abr) ?? num(raw?.tbr) };
}

const ZIP64_THRESHOLD = 3.5 * 2 ** 30;

export function forceZip64(format: OutputFormat, estimatedTotal: number | null): boolean {
  return format === 'wav' || format === 'mp4' || estimatedTotal == null || estimatedTotal > ZIP64_THRESHOLD;
}
