import { createHash } from 'node:crypto';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { AppError, type ErrorCode } from '../lib/errors.js';
import { parseRange } from '../lib/http/range.js';
import { clientIp, ipHash } from '../lib/ip.js';
import { binaryHeaders } from '../lib/jobs/stream-item.js';
import { createDeadline, withDeadline } from '../lib/preview/deadline.js';
import { createPreviewLeases, type PreviewLease } from '../lib/preview/leases.js';
import { createSession, type PreviewSession } from '../lib/preview/session.js';
import type { Outcome, PreviewConn, PreviewStats } from '../lib/preview/types.js';
import { throttledWarn } from '../lib/youtube/oembed.js';
import { ErrorResponse } from '../schemas/common.js';
import { VideoParams } from '../schemas/videos.js';

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
}

export const PreviewQuery = Type.Object(
  {
    codec: Type.Optional(Type.Union([Type.Literal('aac'), Type.Literal('opus')])),
    sid: Type.Optional(Type.String({ pattern: '^[0-9a-f]{32}$' })),
  },
  { additionalProperties: false },
);

interface Preview extends PreviewConn {
  res: ServerResponse;
  lease: PreviewLease | null;
  code?: ErrorCode;
  stats?: PreviewStats;
  watchdog?: NodeJS.Timeout;
  status: number;
  start: number;
  conns: number;
}

const QUIET = new Set<Outcome>(['client_closed', 'idle', 'superseded']);
const RANGE_416 = { status: 416, message: 'El rango pedido no es válido.' };

function safeOrigin(h: string): string | null {
  try {
    const o = new URL(h).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

const previewRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const tuning = app.deps.preview ?? {};
  const warn = throttledWarn(app.log);
  const leases = createPreviewLeases(app.redis, {
    maxPerIp: config.previewMaxStreamsPerIp,
    leaseMs: tuning.leaseMs,
    renewMs: tuning.renewMs,
    warn,
  });
  const active = new Set<Preview>();

  app.addHook('preClose', async () => {
    for (const pv of active) {
      pv.outcome ??= 'shutdown';
      pv.abort.abort();
      if (!pv.res.destroyed) pv.res.destroy();
    }
  });

  // <audio> pide en modo no-cors: se frena el hotlinking por Origin o, en su defecto, Referer
  function checkOrigin(req: FastifyRequest): void {
    const raw = req.headers.origin ?? req.headers.referer;
    if (raw === undefined) return;
    const o = safeOrigin(String(raw));
    if (!o || !config.corsOrigins.includes(o)) throw new AppError('INVALID_INPUT', { status: 403, message: 'Origen no permitido.' });
  }

  app.get(
    '/api/videos/:videoId/audio',
    {
      exposeHeadRoute: false,
      helmet: {
        frameguard: false,
        contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
      },
      config: { rateLimit: { max: config.previewRateLimitMax, timeWindow: 60_000 } },
      schema: { params: VideoParams, querystring: PreviewQuery, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
      onSend: async (_req, reply, payload) => {
        if (reply.statusCode >= 400) reply.header('cache-control', 'no-store');
        return payload;
      },
    },
    async (req, reply) => {
      if (!config.previewEnabled) throw new AppError('SERVICE_UNAVAILABLE');
      if (app.lifecycle.draining) throw new AppError('SERVER_SHUTDOWN');
      checkOrigin(req);
      if (active.size >= config.previewMaxStreamsPerInstance) throw new AppError('INSTANCE_BUSY');

      const { videoId } = req.params;
      const { codec, sid } = req.query;
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
      };
      active.add(pv);
      const deadline = createDeadline(tuning.deadlineMs ?? 60_000);
      let cleaned = false;

      const logFinished = () => {
        const s = pv.stats;
        const outcome = pv.outcome as Outcome;
        const line = {
          videoId,
          formatId: s?.formatId ?? null,
          status: pv.status,
          start: pv.start,
          bytes: s?.bytes ?? 0,
          ms: Date.now() - startedAt,
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
        logFinished();
      };
      reply.raw.once('close', cleanup);

      const signal = pv.abort.signal;
      let session: PreviewSession | null = null;
      let first: Awaited<ReturnType<PreviewSession['openFirst']>>;
      let partial: boolean;
      try {
        const lease = await leases.acquire(ipHash(clientIp(req, config), config.ipHashSalt), sid ?? null, pv);
        if (cleaned) {
          void lease.release();
          throw new AppError('DOWNLOAD_INTERRUPTED');
        }
        pv.lease = lease;
        pv.conns = lease.conns;

        const meta = await withDeadline(app.yt.metadata.get(videoId), deadline, signal);
        if (meta.live) throw new AppError('LIVE_NOT_SUPPORTED');
        if (meta.duration > config.maxDurationAudioSec) throw new AppError('LIMIT_DURATION');

        const s = createSession(
          {
            fetch: app.deps.upstreamFetch,
            chunkBytes: config.previewChunkBytes,
            headersTimeoutMs: tuning.headersTimeoutMs,
            metadata: app.yt.metadata,
            redis: app.redis,
            warn,
            retryDelayMs: tuning.retryDelayMs,
            retryJitterMs: tuning.retryJitterMs,
          },
          videoId,
          codec,
          signal,
        );
        session = s;
        pv.stats = s.stats;
        await withDeadline(s.prepare(deadline), deadline, signal);

        let range = parseRange(req.headers.range, s.total);
        if (range === 'invalid') throw new AppError('INVALID_INPUT', RANGE_416);
        const ifRange = req.headers['if-range'];
        if (range && ifRange !== undefined && ifRange !== s.etag) range = null;
        partial = range !== null;
        first = await withDeadline(s.openFirst(range, deadline), deadline, signal);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError('INTERNAL');
        if (!(e instanceof AppError)) req.log.error({ errName: (e as Error | undefined)?.name ?? typeof e }, 'preview_internal');
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
    },
  );
};

export default previewRoute;
