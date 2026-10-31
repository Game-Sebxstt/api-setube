import type { Mp4Segment } from './mp4-index.js';
import type { SegmentIndex } from './segment-index.js';

// Playlists HLS VOD (RFC 8216) del video en streaming: fMP4 por rangos de bytes sobre los formatos adaptativos de
// YouTube. El master lista una variante avc1 por calidad y un grupo de audio AAC; cada media playlist apunta a
// /api/videos/:videoId/media/:formatId con EXT-X-MAP (init) y EXT-X-BYTERANGE (fragmentos del sidx agrupados).

export const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
/** Duración objetivo de cada segmento del playlist: se agrupan fragmentos consecutivos del sidx hasta llegar a ella. */
export const TARGET_SEGMENT_SEC = 6;
// Un segmento no crece por encima de esto salvo que el siguiente fragmento no empiece en un keyframe
const MAX_GROUP_FACTOR = 1.5;
const AUDIO_GROUP = 'aud';

export interface HlsVariant {
  formatId: string;
  /** Media de bits por segundo del video (sin el audio). */
  videoBps: number;
  width: number | null;
  height: number;
  fps: number | null;
  /** CODECS del video (avc1.PPCCLL). */
  codec: string;
}

export interface HlsAudio {
  formatId: string;
  /** Media de bits por segundo del audio. */
  bps: number;
  /** CODECS del audio (mp4a.40.2, mp4a.40.5…). */
  codec: string;
}

export interface MasterInput {
  /** En el orden en que deben aparecer: la primera es la de arranque de hls.js. */
  variants: HlsVariant[];
  audio: HlsAudio;
  sid: string;
}

/** Segmento del playlist: uno o varios fragmentos consecutivos del sidx. */
export interface HlsSegment {
  offset: number;
  size: number;
  /** Duración en segundos. */
  duration: number;
  independent: boolean;
}

// Factor entre la media y el pico declarado en BANDWIDTH: el sidx da el pico real, pero el master no espera a los
// índices para no retrasar el arranque. hls.js elige calidad con AVERAGE-BANDWIDTH.
export const PEAK_FACTOR = 1.5;

const AVC1 = /^avc1\.[0-9A-Fa-f]{6}$/;
const MP4A = /^mp4a\.40\.\d{1,2}$/;
/** avc1 Main 3.1: el códec por defecto si yt-dlp no trae el perfil exacto (hls.js lo vuelve a leer del avcC). */
export const DEFAULT_AVC1 = 'avc1.4d401f';
export const DEFAULT_MP4A = 'mp4a.40.2';

export const normalizeVideoCodec = (c: string): string => (AVC1.test(c) ? c : DEFAULT_AVC1);
export const normalizeAudioCodec = (c: string): string => (MP4A.test(c) ? c : DEFAULT_MP4A);

// Atributo quoted-string: sin comillas, CR ni LF (RFC 8216 §4.2); los valores vienen ya validados por patrón
function quoted(v: string): string {
  if (/["\r\n]/.test(v)) throw new Error('valor de atributo HLS inválido');
  return `"${v}"`;
}

const q = (sid: string) => `?sid=${encodeURIComponent(sid)}`;
/** URI del media playlist de un formato, relativa al master (…/hls/master.m3u8). */
export const mediaPlaylistUri = (formatId: string, sid: string) => `${encodeURIComponent(formatId)}.m3u8${q(sid)}`;
/** URI de los bytes de un formato, relativa al media playlist (…/hls/<formatId>.m3u8 → …/media/<formatId>). */
export const mediaUri = (formatId: string, sid: string) => `../media/${encodeURIComponent(formatId)}${q(sid)}`;

export function masterPlaylist(m: MasterInput): string {
  if (m.variants.length === 0) throw new Error('master sin variantes');
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=${quoted(AUDIO_GROUP)},NAME=${quoted('Audio')},DEFAULT=YES,AUTOSELECT=YES,URI=${quoted(mediaPlaylistUri(m.audio.formatId, m.sid))}`,
  ];
  const audioCodec = normalizeAudioCodec(m.audio.codec);
  for (const v of m.variants) {
    const avg = Math.max(1, Math.round(v.videoBps + m.audio.bps));
    const attrs = [`BANDWIDTH=${Math.round(avg * PEAK_FACTOR)}`, `AVERAGE-BANDWIDTH=${avg}`];
    if (v.width !== null) attrs.push(`RESOLUTION=${v.width}x${v.height}`);
    if (v.fps !== null && v.fps > 0) attrs.push(`FRAME-RATE=${v.fps.toFixed(3)}`);
    attrs.push(`CODECS=${quoted(`${normalizeVideoCodec(v.codec)},${audioCodec}`)}`, `AUDIO=${quoted(AUDIO_GROUP)}`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, mediaPlaylistUri(v.formatId, m.sid));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Agrupa fragmentos consecutivos del sidx en segmentos de ~`targetSec`. Un segmento solo empieza en un fragmento que
 * arranca en un keyframe (starts_with_SAP); si el sidx no marca ninguno, cada fragmento es una frontera posible.
 */
export function groupSegments(ix: Pick<SegmentIndex, 'timescale' | 'segments'>, targetSec = TARGET_SEGMENT_SEC): HlsSegment[] {
  const anySap = ix.segments.some((s) => s.startsWithSap);
  const canStart = (s: Mp4Segment) => !anySap || s.startsWithSap;
  const target = targetSec * ix.timescale;
  const max = target * MAX_GROUP_FACTOR;
  const out: HlsSegment[] = [];
  let cur: { offset: number; size: number; ticks: number; independent: boolean } | null = null;
  const flush = () => {
    if (cur) out.push({ offset: cur.offset, size: cur.size, duration: cur.ticks / ix.timescale, independent: cur.independent });
  };
  for (const s of ix.segments) {
    const join = cur !== null && (!canStart(s) || (cur.ticks < target && cur.ticks + s.duration <= max));
    if (cur && join) {
      cur.size += s.size;
      cur.ticks += s.duration;
      continue;
    }
    flush();
    cur = { offset: s.offset, size: s.size, ticks: s.duration, independent: s.startsWithSap };
  }
  flush();
  return out;
}

const extinf = (sec: number) => sec.toFixed(5);

export function mediaPlaylist(ix: Pick<SegmentIndex, 'formatId' | 'initEnd' | 'timescale' | 'segments'>, sid: string, targetSec = TARGET_SEGMENT_SEC): string {
  const segs = groupSegments(ix, targetSec);
  if (segs.length === 0) throw new Error('playlist sin segmentos');
  const uri = mediaUri(ix.formatId, sid);
  // RFC 8216 §4.3.3.1: cada EXTINF redondeado al entero más cercano ≤ TARGETDURATION
  const targetDuration = Math.max(1, ...segs.map((s) => Math.round(Number(extinf(s.duration)))));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  if (segs.every((s) => s.independent)) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  // El init es [0, initEnd): ftyp + moov. El sidx que va detrás no hace falta en el navegador
  lines.push(`#EXT-X-MAP:URI=${quoted(uri)},BYTERANGE=${quoted(`${ix.initEnd}@0`)}`);
  for (const s of segs) lines.push(`#EXTINF:${extinf(s.duration)},`, `#EXT-X-BYTERANGE:${s.size}@${s.offset}`, uri);
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}
