import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type ErrorCode } from '../lib/errors.js';
import { contentDisposition } from '../lib/http/content-disposition.js';
import { clientIp, ipHash } from '../lib/ip.js';
import { Semaphore } from '../lib/jobs/semaphore.js';
import { openSession, type Session } from '../lib/jobs/session.js';
import { archiveName, runArchive } from '../lib/jobs/stream-archive.js';
import { binaryHeaders, serveFile } from '../lib/jobs/stream-item.js';
import { archiveQueue, readJob, rejectJob, type JobView } from '../lib/jobs/store.js';
import { prepareItem, type PipelineDeps, type Prepared, type StreamCtx } from '../lib/media/pipeline.js';
import { estimateBytes, forceZip64, type OutputFormat } from '../lib/youtube/formats.js';
import type { Meta } from '../lib/youtube/metadata.js';
import { ErrorResponse } from '../schemas/common.js';
import { ItemParams, JobParams } from '../schemas/jobs.js';
import { critical } from './jobs.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZIP_AUDIO = new Set<OutputFormat>(['mp3', 'm4a']);

const ABORT_CODES: Record<string, ErrorCode> = {
  canceled: 'JOB_CANCELED',
  SERVER_SHUTDOWN: 'SERVER_SHUTDOWN',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  lock_lost: 'JOB_BUSY',
  client_closed: 'DOWNLOAD_INTERRUPTED',
};

const downloadsRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const tuning = app.deps.streams ?? {};
  const semaphore = new Semaphore({
    redis: app.redis,
    pubsub: app.pubsub,
    slots: config.convertConcurrency,
    holdLeaseMs: config.slotLeaseMs,
    waitLeaseMs: config.waitLeaseMs,
    queueMax: config.queueMax,
    waitTimeoutMs: config.queueWaitTimeoutMs,
    log: app.log,
    renewMs: tuning.slotRenewMs,
  });
  app.decorate('semaphore', semaphore);

  const routeHelmet = {
    frameguard: false as const,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { 'default-src': ["'none'"], 'frame-ancestors': config.corsOrigins },
    },
  };

  async function reject(log: FastifyBaseLogger, jobId: string, err: AppError, itemId?: string): Promise<never> {
    if (err.code !== 'JOB_NOT_FOUND') {
      await rejectJob(app.redis, jobId, { code: err.code, message: err.message, itemId, details: err.details }, config.jobTtlSec).catch(
        (e: Error) => log.warn({ err: { message: e.message } }, 'reject_job_failed'),
      );
    }
    throw err;
  }

  const rateLimit = {
    max: 20,
    timeWindow: 60_000,
    errorResponseBuilder: (req: FastifyRequest, ctx: { ttl: number }) => {
      const retryAfterSec = Math.max(1, Math.ceil(ctx.ttl / 1000));
      const id = (req.params as { id?: string } | undefined)?.id;
      if (id && UUID.test(id)) {
        rejectJob(app.redis, id, { code: 'RATE_LIMITED', details: { retryAfterSec } }, config.jobTtlSec).catch((e: Error) =>
          req.log.debug({ err: { message: e.message } }, 'reject_job_failed'),
        );
      }
      return new AppError('RATE_LIMITED', { details: { retryAfterSec } });
    },
  };

  const pipelineDeps = (log: FastifyBaseLogger): PipelineDeps => ({
    config,
    redis: app.redis,
    metadata: app.yt.metadata,
    semaphore,
    log,
    timers: tuning.timers,
  });

  async function open(req: FastifyRequest, jobId: string, view: JobView, itemId?: string): Promise<Session> {
    if (app.lifecycle.streams.size >= config.maxStreamsPerInstance) await reject(req.log, jobId, new AppError('INSTANCE_BUSY'), itemId);
    let session: Session;
    try {
      session = await openSession({
        redis: app.redis,
        pubsub: app.pubsub,
        lifecycle: app.lifecycle,
        log: req.log,
        view,
        jobId,
        ipHash: ipHash(clientIp(req, config), config.ipHashSalt),
        maxPerIp: config.maxStreamsPerIp,
        slotLeaseMs: config.slotLeaseMs,
        jobTtlSec: config.jobTtlSec,
        heartbeatMs: tuning.heartbeatMs,
        lockTtlMs: tuning.lockTtlMs,
        throttleMs: tuning.throttleMs,
      });
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('SERVICE_UNAVAILABLE', { cause: e });
      return reject(req.log, jobId, err, itemId);
    }
    try {
      if ((await semaphore.queueLength()) >= config.queueMax) await reject(req.log, jobId, new AppError('QUEUE_FULL'), itemId);
    } catch (e) {
      await session.close();
      throw e instanceof AppError ? e : new AppError('SERVICE_UNAVAILABLE', { cause: e });
    }
    return session;
  }

  const ctxOf = (req: FastifyRequest, jobId: string, view: JobView, s: Session): StreamCtx => ({
    deps: pipelineDeps(req.log),
    jobId,
    streamId: s.streamId,
    format: view.meta.format,
    quality: view.meta.quality,
    reporter: s.reporter,
    signal: s.signal,
    isCanceled: s.isCanceled,
  });

  async function loadJob(req: FastifyRequest, jobId: string, itemId?: string): Promise<JobView> {
    if (app.lifecycle.draining) await reject(req.log, jobId, new AppError('SERVER_SHUTDOWN'), itemId);
    const view = await critical(readJob(app.redis, jobId, { slotLeaseMs: config.slotLeaseMs }), req.log);
    if (!view) throw new AppError('JOB_NOT_FOUND');
    if (view.snapshot.status === 'canceled') await reject(req.log, jobId, new AppError('JOB_CANCELED'), itemId);
    return view;
  }

  function hijack(reply: FastifyReply, s: Session) {
    reply.hijack();
    s.onAbort(() => {
      if (!reply.raw.destroyed) reply.raw.destroy();
    });
  }

  app.get(
    '/api/jobs/:id/items/:itemId/file',
    {
      exposeHeadRoute: false,
      helmet: routeHelmet,
      config: { rateLimit },
      schema: { params: ItemParams, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const { id: jobId, itemId } = req.params;
      const view = await loadJob(req, jobId, itemId);
      const item = view.snapshot.items.find((i) => i.itemId === itemId);
      if (!item) return reject(req.log, jobId, new AppError('ITEM_NOT_FOUND'), itemId);
      if (item.errorKind === 'validation') return reject(req.log, jobId, new AppError('ITEM_INVALID'), itemId);
      if (item.status === 'canceled') return reject(req.log, jobId, new AppError('JOB_CANCELED'), itemId);

      const session = await open(req, jobId, view, itemId);
      const ctx = ctxOf(req, jobId, view, session);
      try {
        let prepared: Prepared;
        try {
          prepared = await prepareItem(ctx, itemId);
          if (session.signal.aborted) throw session.signal.reason;
        } catch (e) {
          const reason = session.signal.aborted ? String(session.signal.reason) : null;
          const err = reason
            ? new AppError(ABORT_CODES[reason] ?? 'INTERNAL')
            : e instanceof AppError
              ? e
              : new AppError('INTERNAL', { cause: e });
          if (err.code === 'INTERNAL' && !reason) req.log.error({ err: e }, 'prepare_failed');
          if (reason === 'canceled') await session.reporter.transition(itemId, 'canceled');
          else await session.reporter.fail(itemId, err.code);
          req.log.info({ jobId, itemId, videoId: item.videoId, format: view.meta.format, quality: view.meta.quality, outcome: 'error', code: err.code, attempt: session.reporter.get(itemId).attempt }, 'item_finished');
          return await reject(req.log, jobId, new AppError(err.code, { details: err.details }), itemId);
        }
        hijack(reply, session);
        await serveFile({ ctx, abort: session.abort, itemId, prepared, res: reply.raw, baseHeaders: reply.getHeaders() as OutgoingHttpHeaders });
      } finally {
        await session.close();
      }
    },
  );

  app.get(
    '/api/jobs/:id/archive',
    {
      exposeHeadRoute: false,
      helmet: routeHelmet,
      config: { rateLimit },
      schema: { params: JobParams, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const jobId = req.params.id;
      const view = await loadJob(req, jobId);
      const ordered = view.meta.itemIds.flatMap((id) => (view.raw[id] ? [view.raw[id]] : []));
      const queue = archiveQueue(ordered);
      if (queue.length === 0) return reject(req.log, jobId, new AppError('NO_VALID_ITEMS'));
      const excluded = ordered.filter((i) => i.errorKind === 'validation');

      const session = await open(req, jobId, view);
      const ctx = ctxOf(req, jobId, view, session);
      try {
        let estimatedTotal: number | null = 0;
        try {
          const metas = await app.redis.mget(...queue.map((i) => `meta:${i.videoId}`));
          for (const raw of metas) {
            const m = raw ? (JSON.parse(raw) as Meta | { error: string }) : null;
            const b = m && !('error' in m) ? estimateBytes(m, view.meta.format, view.meta.quality, { audioHlsFallback: config.audioHlsFallback }) : null;
            if (b === null) {
              estimatedTotal = null;
              break;
            }
            estimatedTotal += b;
          }
        } catch {
          estimatedTotal = null;
        }
        const format = view.meta.format;
        hijack(reply, session);
        reply.raw.writeHead(
          200,
          binaryHeaders(reply.getHeaders() as OutgoingHttpHeaders, 'application/zip', contentDisposition(archiveName(format))),
        );
        // Cabeceras antes de esperar turno: Node las retendría hasta el primer byte del ZIP
        reply.raw.flushHeaders();
        await runArchive({
          ctx,
          abort: session.abort,
          queue,
          excluded,
          dest: reply.raw,
          parallel: ZIP_AUDIO.has(format) ? config.zipParallelAudio : 1,
          forceZip64: forceZip64(format, estimatedTotal),
          ext: format,
        });
      } finally {
        await session.close();
      }
    },
  );
};

export default downloadsRoute;
