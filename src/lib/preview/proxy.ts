import { createHash } from 'node:crypto';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type ErrorCode } from '../errors.js';
import { parseRange } from '../http/range.js';
import { clientIp, ipHash } from '../ip.js';
import { binaryHeaders } from '../jobs/stream-item.js';
import type { MetadataService } from '../youtube/metadata.js';
import { createDeadline, withDeadline } from './deadline.js';
import type { PreviewLease, PreviewLeases } from './leases.js';
import type { SegmentIndexService } from './segment-index.js';
import { createSession, type PreviewSession, type SessionDeps, type SourceSelector } from './session.js';
import type { Outcome, PreviewConn, PreviewStats } from './types.js';

// Proxy con Range de googlevideo compartido por /audio (escucha) y /media/:formatId (video en streaming):
// origen, leases, plazo, 206/200/416, ETag/If-Range, vigilante de inactividad y la línea preview_finished.

export interface PreviewTuning {
  deadlineMs?: number;
  headersTimeoutMs?: number;
  watchdogMs?: number;
  upstreamIdleMs?: number;
  idleTimeoutMs?: number;
  leaseMs?: number;
  renewMs?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  /** Gracia del hueco por IP tras el último segmento de /media (por defecto MEDIA_LEASE_GRACE_MS). */
  mediaLeaseGraceMs?: number;
}

export type ProxyKind = 'audio' | 'media';

export interface ServeOpts {
  kind: ProxyKind;
  videoId: string;
  sid: string | undefined;
  selector: SourceSelector;
  /** Conexiones simultáneas del mismo reproductor antes de cortar la más antigua. */
  maxConns: number;
  /** Tiempo que el reproductor conserva su hueco por IP tras su última conexión (0: se suelta en el acto). */
  leaseGraceMs?: number;
}

interface Preview extends PreviewConn {
  res: ServerResponse;
  lease: PreviewLease | null;
  code?: ErrorCode;
  stats?: PreviewStats;
  watchdog?: NodeJS.Timeout;
  status: number;
  start: number;
  conns: number;
  /** Milisegundos desde que llegó la petición hasta enviar las cabeceras (null si acabó en error antes). */
  ttfbMs: number | null;
}

export interface PreviewProxyDeps {
  tuning: PreviewTuning;
  leases: PreviewLeases;
  session: SessionDeps;
  /** Índice de segmentos: /media lo invalida si ve otro tamaño o el formato deja de estar disponible. */
  index?: SegmentIndexService;
  /** De dónde sale la meta (directo, duración); por defecto `app.yt.metadata`. */
  meta?: Pick<MetadataService, 'get'>;
}

const QUIET = new Set<Outcome>(['client_closed', 'idle', 'superseded']);
const RANGE_416 = { status: 416, message: 'El rango pedido no es válido.' };
// Errores tras los que el índice en memoria del formato puede estar viejo
const STALE_INDEX = new Set<ErrorCode>(['UPSTREAM_FORBIDDEN', 'FORMAT_UNAVAILABLE']);

function safeOrigin(h: string): string | null {
  try {
    const o = new URL(h).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

export function createPreviewProxy(app: FastifyInstance, d: PreviewProxyDeps) {
  const { config } = app;
  const { tuning, leases } = d;
  const active = new Set<Preview>();

  app.addHook('preClose', async () => {
    for (const pv of active) {
      pv.outcome ??= 'shutdown';
      pv.abort.abort();
      if (!pv.res.destroyed) pv.res.destroy();
    }
    // Los huecos en gracia se sueltan ya; los de las conexiones recién cortadas, al cerrarse sin gracia
    await leases.close();
  });

  // <audio>/<video> piden en modo no-cors: se frena el hotlinking por Origin o, en su defecto, Referer
  function checkOrigin(req: FastifyRequest): void {
    const raw = req.headers.origin ?? req.headers.referer;
    if (raw === undefined) return;
    const o = safeOrigin(String(raw));
    if (!o || !config.corsOrigins.includes(o)) throw new AppError('INVALID_INPUT', { status: 403, message: 'Origen no permitido.' });
  }

  async function serve(req: FastifyRequest, reply: FastifyReply, o: ServeOpts): Promise<void> {
    if (app.lifecycle.draining) throw new AppError('SERVER_SHUTDOWN');
    checkOrigin(req);
    if (active.size >= config.previewMaxStreamsPerInstance) throw new AppError('INSTANCE_BUSY');

    const { videoId, sid, kind } = o;
    const startedAt = Date.now();
    const pv: Preview = {
      id: req.id,
      abort: new AbortController(),
      res: reply.raw,
      outcome: null,
      lease: null,
      status: 0,
      start: 0,
      conns: 0,
      ttfbMs: null,
    };
    active.add(pv);
    const deadline = createDeadline(tuning.deadlineMs ?? 60_000);
    let cleaned = false;

    // El formato pedido (no el de stats: si ya no está en la lista, la sesión no llega a adoptarlo)
    const requested = typeof o.selector === 'object' ? o.selector.formatId : null;
    const forgetIndex = () => {
      if (kind === 'media' && d.index && requested) d.index.forget(videoId, requested);
    };

    const logFinished = () => {
      const s = pv.stats;
      const outcome = pv.outcome as Outcome;
      const line = {
        kind,
        videoId,
        formatId: s?.formatId ?? null,
        status: pv.status,
        start: pv.start,
        bytes: s?.bytes ?? 0,
        ms: Date.now() - startedAt,
        // Sobrecarga del servidor: hasta enviar las cabeceras (hooks, lease, meta, sesión y apertura de googlevideo)
        ttfbMs: pv.ttfbMs,
        outcome,
        code: pv.code,
        refreshed: s?.refreshed ?? false,
        resumes: s?.resumes ?? 0,
        redirects: s?.redirects ?? 0,
        retry403: s?.retry403 ?? 'none',
        urlIpFamily: s?.urlIpFamily ?? null,
        sid: sid ? createHash('sha256').update(sid).digest('hex').slice(0, 8) : null,
        conns: pv.conns,
      };
      if (QUIET.has(outcome)) req.log.debug(line, 'preview_finished');
      else req.log.info(line, 'preview_finished');
    };

    // Único dueño de la liberación y de la línea preview_finished
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      active.delete(pv);
      clearInterval(pv.watchdog);
      deadline.clear();
      pv.abort.abort();
      void pv.lease?.release();
      pv.outcome ??= pv.stats?.failCode ? 'error' : reply.raw.writableFinished ? 'ok' : 'client_closed';
      pv.code ??= pv.stats?.failCode;
      if (pv.code && STALE_INDEX.has(pv.code)) forgetIndex();
      logFinished();
    };
    reply.raw.once('close', cleanup);

    const signal = pv.abort.signal;
    let session: PreviewSession | null = null;
    let first: Awaited<ReturnType<PreviewSession['openFirst']>>;
    let partial: boolean;
    try {
      const lease = await leases.acquire(ipHash(clientIp(req, config), config.ipHashSalt), sid ?? null, pv, o.maxConns, o.leaseGraceMs ?? 0);
      if (cleaned) {
        void lease.release();
        throw new AppError('DOWNLOAD_INTERRUPTED');
      }
      pv.lease = lease;
      pv.conns = lease.conns;

      const meta = await withDeadline((d.meta ?? app.yt.metadata).get(videoId), deadline, signal);
      if (meta.live) throw new AppError('LIVE_NOT_SUPPORTED');
      if (meta.duration > config.maxDurationAudioSec) throw new AppError('LIMIT_DURATION');

      const s = createSession(d.session, videoId, o.selector, signal);
      session = s;
      pv.stats = s.stats;
      // Sin tamaño en la info, el del índice (sacado del Content-Range) ahorra la sonda bytes=0-0 en cada segmento
      const sizeHint = kind === 'media' && d.index && requested ? (d.index.peek(videoId, requested)?.size ?? null) : null;
      await withDeadline(s.prepare(deadline, { sizeHint }), deadline, signal);

      let range = parseRange(req.headers.range, s.total);
      if (range === 'invalid') throw new AppError('INVALID_INPUT', RANGE_416);
      const ifRange = req.headers['if-range'];
      if (range && ifRange !== undefined && ifRange !== s.etag) range = null;
      partial = range !== null;
      first = await withDeadline(s.openFirst(range, deadline), deadline, signal);
      // El índice en memoria no mira el tamaño: si googlevideo sirve otro archivo, se recalcula en el próximo playlist
      if (kind === 'media' && d.index) {
        const ix = d.index.peek(videoId, s.src.formatId);
        if (ix && ix.size !== s.total) forgetIndex();
      }
    } catch (e) {
      let err = e instanceof AppError ? e : new AppError('INTERNAL');
      if (!(e instanceof AppError)) req.log.error({ errName: (e as Error | undefined)?.name ?? typeof e }, 'preview_internal');
      // /media: el formato pedido no está (o ya no está) en la lista permitida del video → 404
      if (kind === 'media' && err.code === 'FORMAT_UNAVAILABLE') err = new AppError('FORMAT_UNAVAILABLE', { status: 404 });
      if (!cleaned) {
        pv.outcome = 'error';
        pv.code = err.code;
        pv.status = err.statusCode;
      }
      if (err.statusCode === 416 && session) reply.header('content-range', `bytes */${session.total}`);
      cleanup();
      throw err;
    }

    deadline.clear();
    const s = session as PreviewSession;
    const { opened, start, end } = first;
    const total = s.total;
    pv.status = partial ? 206 : 200;
    pv.start = start;

    reply.hijack();
    const res = reply.raw;
    res.on('error', () => undefined);
    const headers: OutgoingHttpHeaders = {
      ...binaryHeaders(reply.getHeaders() as OutgoingHttpHeaders, s.src.contentType, 'inline'),
      'Content-Length': String(end - start + 1),
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
      'Accept-Ranges': 'bytes',
      ETag: s.etag,
      'Cache-Control': 'private, max-age=600',
      'Content-Disposition': 'inline',
    };
    res.writeHead(pv.status, headers);
    // Desde que llegó la petición: incluye el rate limit y el resto de hooks, no solo este manejador
    pv.ttfbMs = Math.round(reply.elapsedTime);

    const idleTimeoutMs = tuning.idleTimeoutMs ?? config.previewIdleTimeoutMs;
    const upstreamIdleMs = tuning.upstreamIdleMs ?? 20_000;
    let drainSince: number | null = null;
    pv.watchdog = setInterval(() => {
      const now = Date.now();
      if (res.writableNeedDrain) {
        drainSince ??= now;
        if (now - drainSince > idleTimeoutMs) {
          pv.outcome ??= 'idle';
          res.destroy();
        }
        return;
      }
      drainSince = null;
      const w = s.waitingSince;
      if (w !== null && now - w > upstreamIdleMs) {
        s.waitingSince = null;
        s.kickChunk();
      }
    }, tuning.watchdogMs ?? 5000);
    pv.watchdog.unref?.();

    try {
      // objectMode false: highWaterMark cuenta bytes y el backpressure de res frena la lectura de upstream
      await pipeline(Readable.from(s.stream(opened, end), { objectMode: false, highWaterMark: 64 * 1024 }), res);
    } catch {
      if (!res.destroyed) res.destroy();
    } finally {
      cleanup();
    }
  }

  return { serve, checkOrigin, active };
}

export type PreviewProxy = ReturnType<typeof createPreviewProxy>;
