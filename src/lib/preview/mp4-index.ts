// Índice de fragmentos de un MP4 fragmentado (ftyp + moov + sidx + (moof/mdat)*), como los formatos
// adaptativos de YouTube. Solo lee la cabecera: con el sidx se sabe dónde empieza cada fragmento y cuánto dura.
// ISO/IEC 14496-12: cajas §4.2, sidx §8.16.3.

export interface Mp4Segment {
  /** Offset absoluto del primer byte del fragmento en el archivo. */
  offset: number;
  /** Tamaño en bytes del fragmento (moof + mdat). */
  size: number;
  /** Instante de inicio en unidades de `timescale` (desde earliest_presentation_time). */
  start: number;
  /** Duración en unidades de `timescale`. */
  duration: number;
  /** starts_with_SAP del sidx: el fragmento empieza en un punto de acceso (keyframe). */
  startsWithSap: boolean;
  /** SAP_type del sidx (1 y 2 permiten empezar a decodificar ahí; 0 es desconocido). */
  sapType: number;
}

export interface Mp4Index {
  /** Fin (exclusivo) del moov: el segmento de inicialización es [0, initEnd). */
  initEnd: number;
  /** Fin (exclusivo) del sidx; los offsets del sidx cuentan desde aquí. */
  sidxEnd: number;
  timescale: number;
  earliestPresentationTime: number;
  segments: Mp4Segment[];
}

export type Mp4IndexResult =
  | { kind: 'ok'; index: Mp4Index }
  /** La cabecera no basta: hacen falta al menos los primeros `needBytes` bytes del archivo. */
  | { kind: 'need-more'; needBytes: number };

export type Mp4IndexErrorReason =
  | 'not-mp4'
  | 'bad-box'
  | 'no-moov'
  | 'no-sidx'
  | 'bad-sidx'
  | 'hierarchical-sidx'
  | 'size-mismatch';

export class Mp4IndexError extends Error {
  readonly reason: Mp4IndexErrorReason;

  constructor(reason: Mp4IndexErrorReason, message: string) {
    super(message);
    this.name = 'Mp4IndexError';
    this.reason = reason;
  }
}

export interface ParseMp4IndexOptions {
  /**
   * Tamaño total del archivo: si se da, ninguna caja ni fragmento puede pasarse de él y tras el último
   * fragmento solo pueden quedar hasta MAX_TRAILER bytes (mfra, free).
   */
  totalSize?: number;
}

interface BoxHeader {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

// Llegar a una de estas sin haber visto moov y sidx significa que el archivo no sirve para HLS por rangos
const MEDIA = new Set(['moof', 'mdat', 'mfra']);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// Bytes que pueden quedar tras el último fragmento (mfra de ffmpeg, free): más es un índice que no cubre el archivo
export const MAX_TRAILER = 64 * 1024;

function isPrintableType(buf: Uint8Array, at: number): boolean {
  for (let i = at; i < at + 4; i++) {
    const c = buf[i]!;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// null: falta la cabecera de la caja (hacen falta al menos `start + 16` bytes)
function readBoxHeader(buf: Uint8Array, view: DataView, start: number): BoxHeader | null {
  if (start + 8 > buf.length) return null;
  if (!isPrintableType(buf, start + 4)) throw new Mp4IndexError('bad-box', `tipo de caja ilegible en ${start}`);
  const type = String.fromCharCode(buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!);
  const size32 = view.getUint32(start);
  if (size32 === 1) {
    if (start + 16 > buf.length) return null;
    const large = view.getBigUint64(start + 8);
    if (large > MAX_SAFE) throw new Mp4IndexError('bad-box', `caja ${type} demasiado grande en ${start}`);
    const size = Number(large);
    if (size < 16) throw new Mp4IndexError('bad-box', `caja ${type} con tamaño ${size} en ${start}`);
    return { type, start, headerSize: 16, size };
  }
  // tamaño 0: la caja llega hasta el final del archivo; solo es válido en la última (mdat), nunca antes del índice
  if (size32 === 0) throw new Mp4IndexError('bad-box', `caja ${type} sin tamaño en ${start}`);
  if (size32 < 8) throw new Mp4IndexError('bad-box', `caja ${type} con tamaño ${size32} en ${start}`);
  return { type, start, headerSize: 8, size: size32 };
}

function readUint64(view: DataView, at: number, what: string): number {
  const v = view.getBigUint64(at);
  if (v > MAX_SAFE) throw new Mp4IndexError('bad-sidx', `${what} fuera de rango`);
  return Number(v);
}

function parseSidx(view: DataView, box: BoxHeader): Omit<Mp4Index, 'initEnd'> {
  const end = box.start + box.size;
  let p = box.start + box.headerSize;
  if (p + 4 > end) throw new Mp4IndexError('bad-sidx', 'sidx truncado');
  const version = view.getUint8(p);
  if (version > 1) throw new Mp4IndexError('bad-sidx', `versión de sidx ${version} no soportada`);
  p += 4; // version + flags
  const fixed = version === 0 ? 4 + 4 + 4 + 4 + 2 + 2 : 4 + 4 + 8 + 8 + 2 + 2;
  if (p + fixed > end) throw new Mp4IndexError('bad-sidx', 'sidx truncado');
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  let earliestPresentationTime: number;
  let firstOffset: number;
  if (version === 0) {
    earliestPresentationTime = view.getUint32(p);
    firstOffset = view.getUint32(p + 4);
    p += 8;
  } else {
    earliestPresentationTime = readUint64(view, p, 'earliest_presentation_time');
    firstOffset = readUint64(view, p + 8, 'first_offset');
    p += 16;
  }
  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;
  if (timescale === 0) throw new Mp4IndexError('bad-sidx', 'timescale 0');
  if (count === 0) throw new Mp4IndexError('bad-sidx', 'sidx sin referencias');
  if (p + count * 12 > end) throw new Mp4IndexError('bad-sidx', `sidx truncado: ${count} referencias no caben`);

  const sidxEnd = end;
  let offset = sidxEnd + firstOffset;
  let start = earliestPresentationTime;
  const segments: Mp4Segment[] = [];
  for (let i = 0; i < count; i++, p += 12) {
    const ref = view.getUint32(p);
    if (ref >>> 31 === 1) throw new Mp4IndexError('hierarchical-sidx', 'el sidx apunta a otro sidx (índice jerárquico)');
    const size = ref & 0x7fffffff;
    const duration = view.getUint32(p + 4);
    const sap = view.getUint32(p + 8);
    if (size === 0) throw new Mp4IndexError('bad-sidx', `referencia ${i} con tamaño 0`);
    if (duration === 0) throw new Mp4IndexError('bad-sidx', `referencia ${i} con duración 0`);
    segments.push({ offset, size, start, duration, startsWithSap: sap >>> 31 === 1, sapType: (sap >>> 28) & 0x7 });
    offset += size;
    start += duration;
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(start)) {
    throw new Mp4IndexError('bad-sidx', 'offsets o tiempos fuera de rango');
  }
  return { sidxEnd, timescale, earliestPresentationTime, segments };
}

/**
 * Lee el índice de fragmentos de los primeros bytes de un MP4 fragmentado.
 * Devuelve `need-more` con el prefijo mínimo necesario si `buf` no llega al final del sidx,
 * y lanza `Mp4IndexError` si el archivo no es un MP4 fragmentado con sidx de un nivel.
 */
export function parseMp4Index(buf: Uint8Array, opts: ParseMp4IndexOptions = {}): Mp4IndexResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  let initEnd: number | null = null;
  let sidx: Omit<Mp4Index, 'initEnd'> | null = null;
  let first = true;

  while (initEnd === null || sidx === null) {
    if (opts.totalSize !== undefined && pos >= opts.totalSize) {
      throw new Mp4IndexError(initEnd === null ? 'no-moov' : 'no-sidx', 'el archivo termina antes del índice');
    }
    const box = readBoxHeader(buf, view, pos);
    if (!box) {
      const needBytes = opts.totalSize === undefined ? pos + 16 : Math.min(pos + 16, opts.totalSize);
      if (needBytes <= buf.length) throw new Mp4IndexError('bad-box', `caja truncada al final del archivo en ${pos}`);
      return { kind: 'need-more', needBytes };
    }
    if (first) {
      if (box.type !== 'ftyp') throw new Mp4IndexError('not-mp4', `la primera caja es ${box.type}, no ftyp`);
      first = false;
    }
    const end = box.start + box.size;
    if (!Number.isSafeInteger(end)) throw new Mp4IndexError('bad-box', `caja ${box.type} fuera de rango`);
    if (opts.totalSize !== undefined && end > opts.totalSize) {
      throw new Mp4IndexError('bad-box', `caja ${box.type} más allá del final del archivo`);
    }

    if (box.type === 'moov') {
      if (initEnd !== null) throw new Mp4IndexError('bad-box', 'moov repetido');
      initEnd = end;
    } else if (box.type === 'sidx') {
      // El primer sidx manda; otro sidx detrás (daisy chain) no hace falta para el índice
      if (sidx === null) {
        if (end > buf.length) return { kind: 'need-more', needBytes: end };
        sidx = parseSidx(view, box);
      }
    } else if (MEDIA.has(box.type)) {
      throw new Mp4IndexError(initEnd === null ? 'no-moov' : 'no-sidx', `llegó ${box.type} antes del índice`);
    } else if (box.type === 'ftyp' && box.start !== 0) {
      throw new Mp4IndexError('bad-box', 'ftyp repetido');
    }
    // el resto (free, skip, uuid, emsg, styp…) se salta sin leerlo
    pos = end;
  }

  if (sidx.segments[0]!.offset < initEnd) {
    throw new Mp4IndexError('bad-sidx', 'los fragmentos empiezan dentro del segmento de inicialización');
  }
  const last = sidx.segments[sidx.segments.length - 1]!;
  const lastEnd = last.offset + last.size;
  if (opts.totalSize !== undefined) {
    const trailing = opts.totalSize - lastEnd;
    if (trailing < 0 || trailing > MAX_TRAILER) {
      throw new Mp4IndexError('size-mismatch', `los fragmentos terminan en ${lastEnd} y el archivo mide ${opts.totalSize}`);
    }
  }
  return { kind: 'ok', index: { initEnd, ...sidx } };
}
