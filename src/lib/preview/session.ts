import type { Redis } from 'ioredis';
import { AppError, type ErrorCode } from '../errors.js';
import type { ByteRange } from '../http/range.js';
import { previewSourceFor, rankPreviewFormats, type Codec, type Source } from '../youtube/formats.js';
import type { MetadataService } from '../youtube/metadata.js';
import type { Deadline } from './deadline.js';
import type { PreviewStats } from './types.js';
import { openChunk, UpstreamError, type Opened, type UpstreamDeps } from './upstream.js';

type Json = Record<string, unknown>;

export interface SessionDeps extends UpstreamDeps {
  // `forget` (de la caché en memoria del info JSON) obliga a releer Redis antes de decidir si hace falta refrescar
  metadata: Pick<MetadataService, 'refresh' | 'readInfoJson'> & { forget?: (videoId: string) => void };
  redis: Redis;
  warn: (msg: string, obj?: object) => void;
  retryDelayMs?: number;
  retryJitterMs?: number;
  availableWaitMs?: number;
}

export interface PrepareOptions {
  /**
   * Tamaño ya conocido del archivo (p. ej. el del índice de segmentos, sacado de un Content-Range) para cuando la info
   * no trae `filesize` ni `clen`: evita la sonda `bytes=0-0`. Si googlevideo dice otro, la sesión lo trata como un
   * cambio de archivo, igual que con el tamaño de la info.
   */
  sizeHint?: number | null;
  /**
   * false: sin tamaño conocido no se hace la sonda; el total sale del Content-Range de la primera apertura, que tiene
   * que ser un rango explícito con `end` (lo usa el índice, que siempre pide la cabecera).
   */
  probe?: boolean;
}

export const forbiddenKey = (videoId: string, formatId: string) => `pv:forbidden:${videoId}:${formatId}`;
const FORBIDDEN_TTL_SEC = 120;
const SAME_MIN_LEFT_SEC = 300;
const FRESH_INFO_SEC = 60;
const RESUMES = 3;

const nowSec = () => Math.floor(Date.now() / 1000);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export const codeOf = (e: unknown): ErrorCode => (e instanceof AppError ? e.code : 'INTERNAL');

/**
 * Qué fuente abre la sesión: el mejor audio por códec (escucha, como siempre) o un formato concreto de la lista
 * permitida para el video en streaming (variantes avc1 ≤ maxHeight + mejor m4a).
 */
export type SourceSelector = Codec | undefined | { formatId: string; maxHeight: number };

// null: el formato pedido no está (o ya no está) en la lista permitida
export function selectSource(info: Json, selector: SourceSelector): Source | null {
  if (typeof selector === 'object') return previewSourceFor(info, selector.formatId, selector.maxHeight);
  return rankPreviewFormats(info, selector)[0] ?? null;
}

export function createSession(d: SessionDeps, videoId: string, selector: SourceSelector, sessionSignal: AbortSignal) {
  const byFormat = typeof selector === 'object';
  const budget = { same: 2, original: 1, refresh: 1, resumes: RESUMES };
  const stats: PreviewStats = { formatId: null, refreshed: false, resumes: 0, redirects: 0, bytes: 0, retry403: 'none', urlIpFamily: null };
  const retryDelay = () => (d.retryDelayMs ?? 300) + Math.floor(Math.random() * (d.retryJitterMs ?? 500));
  let src: Source | null = null;
  let total: number | null = null;
  let effectiveUrl = '';
  let epoch = 0;
  let chunkCtl: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const cur = (): Source => {
    if (!src) throw new AppError('INTERNAL');
    return src;
  };

  function pick(info: Json): Source {
    const first = selectSource(info, selector);
    if (!first) throw new AppError('FORMAT_UNAVAILABLE');
    return first;
  }

  function adopt(next: Source, info: Json): void {
    src = next;
    effectiveUrl = next.url;
    epoch = typeof info.epoch === 'number' ? info.epoch : 0;
    stats.formatId = next.formatId;
    stats.urlIpFamily = next.urlIpFamily;
  }

  async function isForbidden(formatId: string): Promise<boolean> {
    try {
      return (await d.redis.get(forbiddenKey(videoId, formatId))) !== null;
    } catch {
      return false;
    }
  }

  async function markForbidden(phase: 'pre' | 'stream'): Promise<never> {
    const s = cur();
    stats.retry403 = 'failed';
    await d.redis.set(forbiddenKey(videoId, s.formatId), '1', 'EX', FORBIDDEN_TTL_SEC).catch(() => undefined);
    d.warn('preview_forbidden', {
      videoId,
      formatId: s.formatId,
      phase,
      sinceExtractSec: epoch ? nowSec() - epoch : null,
      urlIpFamily: s.urlIpFamily,
    });
    throw new AppError('UPSTREAM_FORBIDDEN');
  }

  async function freshInfo(): Promise<Json> {
    d.metadata.forget?.(videoId);
    const cached = await d.metadata.readInfoJson(videoId);
    if (cached && typeof cached.epoch === 'number' && nowSec() - cached.epoch < FRESH_INFO_SEC) {
      const first = selectSource(cached, selector);
      if (first && first.url !== cur().url) return cached;
    }
    return (await d.metadata.refresh(videoId)).infoJson;
  }

  // Escalones ante 403/410; devuelve true si cambió la identidad (formato o tamaño)
  async function ladder(phase: 'pre' | 'stream', signal: AbortSignal): Promise<boolean> {
    const s = cur();
    if (s.expire - nowSec() > SAME_MIN_LEFT_SEC && budget.same > 0) {
      budget.same--;
      stats.retry403 = 'same';
      await sleep(retryDelay(), signal);
      return false;
    }
    if (effectiveUrl !== s.url && budget.original > 0) {
      budget.original--;
      stats.retry403 = 'original';
      effectiveUrl = s.url;
      return false;
    }
    if (budget.refresh > 0) {
      budget.refresh--;
      stats.retry403 = 'refresh';
      stats.refreshed = true;
      const info = await freshInfo();
      // Por formato: tras refrescar tiene que seguir el mismo formatId; si desaparece, YouTube ya no lo sirve
      if (byFormat && !selectSource(info, selector)) {
        stats.retry403 = 'failed';
        d.warn('preview_format_gone', { videoId, formatId: s.formatId, phase });
        throw new AppError('UPSTREAM_FORBIDDEN');
      }
      const next = pick(info);
      const changed = next.formatId !== s.formatId || (next.size !== null && total !== null && next.size !== total);
      if (changed && phase === 'stream') throw new AppError('UPSTREAM_FORBIDDEN');
      adopt(next, info);
      return changed;
    }
    return markForbidden(phase);
  }

  async function prepare(deadline: Deadline, opts: PrepareOptions = {}): Promise<void> {
    const signal = AbortSignal.any([sessionSignal, deadline.signal]);
    let info = await d.metadata.readInfoJson(videoId);
    if (!info) {
      info = (await d.metadata.refresh(videoId)).infoJson;
      budget.refresh = 0;
      stats.refreshed = true;
    }
    adopt(pick(info), info);
    const s = cur();
    if (await isForbidden(s.formatId)) {
      stats.retry403 = 'failed';
      throw new AppError('UPSTREAM_FORBIDDEN');
    }
    if (s.availableAt !== null) {
      const waitMs = (s.availableAt - Date.now() / 1000) * 1000;
      if (waitMs > (d.availableWaitMs ?? 5000)) throw new AppError('UPSTREAM_ERROR');
      if (waitMs > 0) await sleep(waitMs, signal);
      if (signal.aborted) throw abortedError(deadline);
    }
    total = s.size ?? (opts.sizeHint && opts.sizeHint > 0 ? opts.sizeHint : null);
    if (total === null && opts.probe !== false) {
      const probe = await openPre(0, 0, true, deadline);
      probe.opened.body.cancel().catch(() => undefined);
      total = probe.opened.total;
    }
  }

  function abortedError(deadline: Deadline): AppError {
    return new AppError(!sessionSignal.aborted && deadline.timedOut() ? 'UPSTREAM_TIMEOUT' : 'DOWNLOAD_INTERRUPTED');
  }

  // Apertura previa a las cabeceras; si la identidad cambia solo se acepta pidiendo desde el byte 0
  async function openPre(start: number, end: number, fromZero: boolean, deadline: Deadline): Promise<{ opened: Opened; changed: boolean }> {
    const signal = AbortSignal.any([sessionSignal, deadline.signal]);
    let netRetries = 1;
    let sizeRetries = 1;
    let changed = false;
    const onChange = () => {
      if (!fromZero) throw new AppError('UPSTREAM_FORBIDDEN');
      changed = true;
    };
    for (;;) {
      if (signal.aborted) throw abortedError(deadline);
      try {
        const opened = await openChunk(d, effectiveUrl, cur().headers, start, end, total, signal);
        effectiveUrl = opened.finalUrl;
        stats.redirects += opened.redirects;
        return { opened, changed };
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        switch (e.kind) {
          case 'forbidden':
          case 'gone':
            if (await ladder('pre', signal)) {
              onChange();
              total = cur().size;
            }
            continue;
          case 'size':
            onChange();
            if (sizeRetries-- <= 0) throw new AppError('UPSTREAM_ERROR');
            total = e.total ?? null;
            continue;
          case 'range':
            if (e.total) total = e.total;
            throw new AppError('INVALID_INPUT', { status: 416, message: 'El rango pedido no es válido.' });
          case 'blocked':
            throw new AppError('UPSTREAM_BLOCKED');
          case 'network':
            if (netRetries-- > 0) {
              await sleep(d.retryDelayMs ?? 300, signal);
              continue;
            }
            throw new AppError('UPSTREAM_ERROR');
          case 'timeout':
            throw new AppError('UPSTREAM_TIMEOUT');
          case 'aborted':
            throw abortedError(deadline);
          default:
            throw new AppError('UPSTREAM_ERROR');
        }
      }
    }
  }

  async function openFirst(range: ByteRange | null, deadline: Deadline): Promise<{ opened: Opened; start: number; end: number }> {
    // null solo con prepare({ probe: false }): entonces hay un rango explícito y el total sale de esta apertura
    const before = total;
    const start = range?.start ?? 0;
    let end = range?.end ?? (before ?? 0) - 1;
    const fromZero = start === 0 && !range?.suffix;
    const { opened, changed } = await openPre(start, end, fromZero, deadline);
    if (changed || opened.total !== before) {
      total = opened.total;
      const toEnd = range === null || (before !== null && end >= before - 1);
      end = toEnd ? opened.total - 1 : Math.min(end, opened.total - 1);
    }
    return { opened, start, end };
  }

  async function openNext(pos: number, end: number): Promise<Opened> {
    for (;;) {
      if (sessionSignal.aborted) throw new AppError('DOWNLOAD_INTERRUPTED');
      chunkCtl = new AbortController();
      const signal = AbortSignal.any([sessionSignal, chunkCtl.signal]);
      try {
        const opened = await openChunk(d, effectiveUrl, cur().headers, pos, end, total, signal);
        effectiveUrl = opened.finalUrl;
        stats.redirects += opened.redirects;
        return opened;
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        if (sessionSignal.aborted) throw new AppError('DOWNLOAD_INTERRUPTED');
        switch (e.kind) {
          case 'forbidden':
          case 'gone':
            await ladder('stream', sessionSignal);
            continue;
          case 'blocked':
            throw new AppError('UPSTREAM_BLOCKED');
          case 'range':
          case 'size':
            throw new AppError('UPSTREAM_ERROR');
          default:
            spendResume();
            await sleep(d.retryDelayMs ?? 300, sessionSignal);
        }
      }
    }
  }

  function spendResume(): void {
    if (budget.resumes <= 0) throw new AppError('UPSTREAM_ERROR');
    budget.resumes--;
    stats.resumes++;
  }

  async function* stream(first: Opened, end: number): AsyncGenerator<Buffer> {
    let pos = first.start;
    let opened: Opened | null = first;
    try {
      while (pos <= end) {
        opened ??= await openNext(pos, end);
        const limit = Math.min(end, opened.end);
        const r = opened.body.getReader();
        reader = r;
        try {
          for (;;) {
            session.waitingSince = Date.now();
            let chunk: Awaited<ReturnType<typeof r.read>>;
            try {
              chunk = await r.read();
            } catch {
              if (sessionSignal.aborted) throw new AppError('DOWNLOAD_INTERRUPTED');
              break;
            }
            session.waitingSince = null;
            if (chunk.done) break;
            const v = chunk.value;
            let buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
            if (buf.length > limit - pos + 1) buf = buf.subarray(0, limit - pos + 1);
            pos += buf.length;
            stats.bytes += buf.length;
            if (buf.length) yield buf;
            if (pos > limit) break;
          }
        } finally {
          session.waitingSince = null;
          reader = null;
          r.cancel().catch(() => undefined);
        }
        if (sessionSignal.aborted) throw new AppError('DOWNLOAD_INTERRUPTED');
        if (pos > opened.end || pos > end) budget.resumes = RESUMES;
        else spendResume();
        opened = null;
      }
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('UPSTREAM_ERROR');
      if (!sessionSignal.aborted) stats.failCode = err.code;
      throw err;
    } finally {
      chunkCtl?.abort();
      if (opened) opened.body.cancel().catch(() => undefined);
    }
  }

  const session = {
    get src(): Source {
      return cur();
    },
    get total(): number {
      return total ?? 0;
    },
    get etag(): string {
      return `"${cur().formatId}-${total ?? 0}"`;
    },
    stats,
    waitingSince: null as number | null,
    // Corta el tramo en curso para que stream() lo reabra desde la posición actual
    kickChunk(): void {
      chunkCtl?.abort();
      reader?.cancel().catch(() => undefined);
    },
    prepare,
    openFirst,
    stream,
  };
  return session;
}

export type PreviewSession = ReturnType<typeof createSession>;
