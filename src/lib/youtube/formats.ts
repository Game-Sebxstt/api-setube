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

const ZIP64_THRESHOLD = 3.5 * 2 ** 30;

export function forceZip64(format: OutputFormat, estimatedTotal: number | null): boolean {
  return format === 'wav' || format === 'mp4' || estimatedTotal == null || estimatedTotal > ZIP64_THRESHOLD;
}
