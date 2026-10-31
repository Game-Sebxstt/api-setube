import { AppError } from '../errors.js';
import { createDeadline, withDeadline } from './deadline.js';
import { Mp4IndexError, parseMp4Index, type Mp4Index, type Mp4Segment } from './mp4-index.js';
import { createSession, type SessionDeps } from './session.js';

// Índice de segmentos de un formato (offsets y duraciones del sidx) para generar los playlists HLS por rangos de bytes.
// Se calcula una vez por formato: Redis (compartido entre instancias) y una caché pequeña en memoria (la más rápida).

export interface SegmentIndex extends Mp4Index {
  videoId: string;
  formatId: string;
  /** Tamaño exacto del archivo según el Content-Range de googlevideo. */
  size: number;
  contentType: string;
}

export interface SegmentIndexDeps {
  /** Dependencias de la sesión que abre la cabecera, con la misma escalera de 403/410 que el proxy. */
  session: SessionDeps;
  /** TTL en Redis (INFO_JSON_TTL_SEC). */
  ttlSec: number;
  /** Altura máxima de las variantes permitidas (PREVIEW_VIDEO_MAX_HEIGHT). */
  maxHeight: number;
  memMax?: number;
  memTtlMs?: number;
  deadlineMs?: number;
  initialBytes?: number;
  maxBytes?: number;
}

export const indexKey = (videoId: string, formatId: string, size: number) => `pv:idx:${videoId}:${formatId}:${size}`;

const INITIAL_BYTES = 64 * 1024;
const MAX_BYTES = 1024 * 1024;

// En Redis los segmentos van como [offset, size, start, duration, sap] para que el JSON ocupe poco.
// sap = (starts_with_SAP ? 8 : 0) | SAP_type, así sobreviven los dos valores. La v1 (sin SAP_type si no había SAP)
// se descarta y se recalcula.
const VERSION = 2;
type Stored = {
  v: typeof VERSION;
  ct: string;
  size: number;
  initEnd: number;
  sidxEnd: number;
  timescale: number;
  ept: number;
  seg: [number, number, number, number, number][];
};

const SAP_FLAG = 8;

function encode(ix: SegmentIndex): string {
  const stored: Stored = {
    v: VERSION,
    ct: ix.contentType,
    size: ix.size,
    initEnd: ix.initEnd,
    sidxEnd: ix.sidxEnd,
    timescale: ix.timescale,
    ept: ix.earliestPresentationTime,
    seg: ix.segments.map((s) => [s.offset, s.size, s.start, s.duration, (s.startsWithSap ? SAP_FLAG : 0) | (s.sapType & 7)]),
  };
  return JSON.stringify(stored);
}

const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// null si el valor no tiene la forma esperada (versión vieja, basura): se recalcula
function decode(raw: string, videoId: string, formatId: string, size: number): SegmentIndex | null {
  let s: Partial<Stored>;
  try {
    s = JSON.parse(raw) as Partial<Stored>;
  } catch {
    return null;
  }
  if (s.v !== VERSION || s.size !== size || typeof s.ct !== 'string' || !Array.isArray(s.seg) || s.seg.length === 0) return null;
  if (!safe(s.initEnd) || !safe(s.sidxEnd) || !safe(s.timescale) || s.timescale === 0 || !safe(s.ept)) return null;
  const segments: Mp4Segment[] = [];
  for (const r of s.seg) {
    if (!Array.isArray(r) || r.length !== 5 || !r.every(safe) || r[4] > 15) return null;
    const [offset, len, start, duration, sap] = r;
    segments.push({ offset, size: len, start, duration, startsWithSap: (sap & SAP_FLAG) !== 0, sapType: sap & 7 });
  }
  return {
    videoId,
    formatId,
    size,
    contentType: s.ct,
    initEnd: s.initEnd,
    sidxEnd: s.sidxEnd,
    timescale: s.timescale,
    earliestPresentationTime: s.ept,
    segments,
  };
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(b);
  return Buffer.concat(parts);
}

export function createSegmentIndex(d: SegmentIndexDeps) {
  const redis = d.session.redis;
  const warn = d.session.warn;
  const memMax = d.memMax ?? 64;
  const memTtlMs = d.memTtlMs ?? 10 * 60_000;
  const initialBytes = d.initialBytes ?? INITIAL_BYTES;
  const maxBytes = d.maxBytes ?? MAX_BYTES;
  const mem = new Map<string, { ix: SegmentIndex; until: number }>();
  const inflight = new Map<string, Promise<SegmentIndex>>();
  const stats = { builds: 0, redisHits: 0, memHits: 0 };

  const memKey = (videoId: string, formatId: string) => `${videoId}:${formatId}`;

  function remember(ix: SegmentIndex): SegmentIndex {
    const k = memKey(ix.videoId, ix.formatId);
    mem.delete(k);
    mem.set(k, { ix, until: Date.now() + memTtlMs });
    while (mem.size > memMax) mem.delete(mem.keys().next().value as string);
    return ix;
  }

  function peek(videoId: string, formatId: string): SegmentIndex | null {
    const k = memKey(videoId, formatId);
    const e = mem.get(k);
    if (!e) return null;
    if (e.until <= Date.now()) {
      mem.delete(k);
      return null;
    }
    mem.delete(k);
    mem.set(k, e);
    return e.ix;
  }

  async function readRedis(key: string, videoId: string, formatId: string, size: number): Promise<SegmentIndex | null> {
    try {
      const raw = await redis.get(key);
      return raw ? decode(raw, videoId, formatId, size) : null;
    } catch {
      warn('preview_index_cache_unavailable');
      return null;
    }
  }

  async function build(videoId: string, formatId: string): Promise<SegmentIndex> {
    const ac = new AbortController();
    const deadline = createDeadline(d.deadlineMs ?? 20_000);
    const s = createSession(d.session, videoId, { formatId, maxHeight: d.maxHeight }, ac.signal);
    try {
      // Sin tamaño en la info, el total sale del Content-Range de la cabecera: sin sonda bytes=0-0 previa
      await withDeadline(s.prepare(deadline, { probe: false }), deadline, ac.signal);
      // Con el tamaño de la info (filesize/clen) el índice puede salir de Redis sin tocar googlevideo
      const known = s.total;
      if (known > 0) {
        const cached = await readRedis(indexKey(videoId, formatId, known), videoId, formatId, known);
        if (cached) {
          stats.redisHits++;
          return remember(cached);
        }
      }

      stats.builds++;
      let buf: Buffer = Buffer.alloc(0);
      let want = initialBytes;
      for (;;) {
        // El total exacto sale del Content-Range de cada apertura (no de filesize_approx)
        const end = Math.min(want, maxBytes, s.total || want) - 1;
        const first = await withDeadline(s.openFirst({ start: buf.length, end, suffix: false }, deadline), deadline, ac.signal);
        const part = await withDeadline(collect(s.stream(first.opened, first.end)), deadline, ac.signal);
        buf = buf.length ? Buffer.concat([buf, part]) : part;
        const total = s.total;
        const r = parseMp4Index(buf, { totalSize: total });
        if (r.kind === 'ok') {
          const ix: SegmentIndex = { videoId, formatId, size: total, contentType: s.src.contentType, ...r.index };
          try {
            await redis.set(indexKey(videoId, formatId, total), encode(ix), 'EX', d.ttlSec);
          } catch {
            warn('preview_index_cache_unavailable');
          }
          return remember(ix);
        }
        if (r.needBytes > maxBytes || buf.length >= Math.min(maxBytes, total)) {
          warn('preview_index_too_large', { videoId, formatId, needBytes: r.needBytes });
          throw new AppError('FORMAT_UNAVAILABLE');
        }
        want = Math.min(Math.max(r.needBytes, buf.length * 2), maxBytes);
      }
    } catch (e) {
      if (e instanceof Mp4IndexError) {
        warn('preview_index_invalid', { videoId, formatId, reason: e.reason });
        throw new AppError('FORMAT_UNAVAILABLE');
      }
      throw e;
    } finally {
      deadline.clear();
      ac.abort();
    }
  }

  return {
    /**
     * Índice del formato: memoria → Redis → cabecera de googlevideo (64 KiB, crece hasta 1 MiB).
     * Las peticiones simultáneas del mismo formato comparten el mismo cálculo; `signal` solo corta la espera de quien llama.
     */
    get(videoId: string, formatId: string, signal?: AbortSignal): Promise<SegmentIndex> {
      const hit = peek(videoId, formatId);
      if (hit) {
        stats.memHits++;
        return Promise.resolve(hit);
      }
      const k = memKey(videoId, formatId);
      let p = inflight.get(k);
      if (!p) {
        const started = build(videoId, formatId).finally(() => inflight.delete(k));
        started.catch(() => undefined);
        inflight.set(k, started);
        p = started;
      }
      if (!signal) return p;
      if (signal.aborted) return Promise.reject(new AppError('DOWNLOAD_INTERRUPTED'));
      const shared = p;
      return new Promise<SegmentIndex>((resolve, reject) => {
        const onAbort = () => reject(new AppError('DOWNLOAD_INTERRUPTED'));
        signal.addEventListener('abort', onAbort, { once: true });
        shared.then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    },
    peek,
    /** Olvida el índice en memoria (p. ej. si el proxy ve que el tamaño del archivo cambió). */
    forget(videoId: string, formatId: string): void {
      mem.delete(memKey(videoId, formatId));
    },
    stats,
  };
}

export type SegmentIndexService = ReturnType<typeof createSegmentIndex>;
