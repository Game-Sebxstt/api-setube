import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, ERROR_CATALOG, type ErrorCode } from '../lib/errors.js';
import { ipHash } from '../lib/ip.js';
import { cancelJob, createJob, readJob, type NewItem } from '../lib/jobs/store.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import type { OutputFormat, Quality } from '../lib/youtube/formats.js';
import type { Meta } from '../lib/youtube/metadata.js';
import { ErrorResponse } from '../schemas/common.js';
import { CancelResponse, CreateJobResponse, createJobBody, JobParams, SnapshotResponse } from '../schemas/jobs.js';

export const PREVALIDATION_BUDGET_MS = 15_000;

const MP3 = new Set<unknown>([128, 192, 320]);
const MP4 = new Set<unknown>([360, 480, 720, 1080, 'best']);
const DEFINITIVE = new Set<ErrorCode>(['PRIVATE_VIDEO', 'VIDEO_UNAVAILABLE']);

export async function critical<T>(p: Promise<T>, log: FastifyBaseLogger): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof AppError) throw e;
    log.error({ err: { message: (e as Error).message } }, 'redis_critical_failed');
    throw new AppError('SERVICE_UNAVAILABLE', { cause: e });
  }
}

export function resolveQuality(format: OutputFormat, quality: unknown): Quality {
  const bad = () => new AppError('INVALID_INPUT', { details: [{ path: '/quality', keyword: 'quality', message: 'calidad no válida para el formato' }] });
  if (format === 'mp3') {
    if (quality === undefined) return 192;
    if (!MP3.has(quality)) throw bad();
    return quality as Quality;
  }
  if (format === 'mp4') {
    if (quality === undefined) return 720;
    if (!MP4.has(quality)) throw bad();
    return quality as Quality;
  }
  if (quality !== undefined) throw bad();
  return null;
}

type PreInfo = { title: string | null; duration: number | null; live: boolean; verified: boolean } | { error: ErrorCode };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

const jobsRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const Body = createJobBody(config.maxItemsPerJob);

  app.post(
    '/api/jobs',
    {
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      // LIMIT_ITEMS antes del esquema, para dar un mensaje claro (413)
      preValidation: async (req) => {
        const items = (req.body as { items?: unknown } | null)?.items;
        if (Array.isArray(items) && items.length > config.maxItemsPerJob) {
          throw new AppError('LIMIT_ITEMS', { details: { max: config.maxItemsPerJob } });
        }
      },
      schema: { body: Body, response: { 201: CreateJobResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const { items, format } = req.body;
      const quality = resolveQuality(format, req.body.quality);
      await verifyTurnstile({
        secret: config.turnstileSecret,
        token: req.body.turnstileToken,
        remoteIp: req.ip,
        fetch: app.deps.fetch,
        log: req.log,
      });

      const ids = [...new Set(items.map((i) => i.videoId))];
      const cached = await critical(app.redis.mget(...ids.flatMap((id) => [`meta:${id}`, `meta:lite:${id}`])), req.log);
      const info = new Map<string, PreInfo>();
      const missing: string[] = [];
      ids.forEach((id, i) => {
        const full = cached[i * 2];
        const lite = cached[i * 2 + 1];
        try {
          if (full) {
            const m = JSON.parse(full) as Meta | { error: ErrorCode };
            if ('error' in m) {
              if (DEFINITIVE.has(m.error)) info.set(id, { error: m.error });
              else missing.push(id);
            } else info.set(id, { title: m.title, duration: m.duration, live: m.live, verified: true });
            return;
          }
          if (lite) {
            const l = JSON.parse(lite) as { title: string | null; duration: number | null };
            info.set(id, { title: l.title, duration: l.duration, live: false, verified: false });
            return;
          }
        } catch {
          /* caché corrupta: se trata como miss */
        }
        missing.push(id);
      });
      if (missing.length) {
        const work = missing.map((id) =>
          app.yt.metadata.get(id).then(
            (m) => void info.set(id, { title: m.title, duration: m.duration, live: m.live, verified: true }),
            (e: unknown) => {
              if (e instanceof AppError && DEFINITIVE.has(e.code)) info.set(id, { error: e.code });
            },
          ),
        );
        await Promise.race([Promise.allSettled(work), sleep(PREVALIDATION_BUDGET_MS)]);
      }

      const limit = format === 'mp4' ? config.maxDurationVideoSec : config.maxDurationAudioSec;
      const newItems: NewItem[] = items.map(({ videoId }) => {
        const p = info.get(videoId);
        if (!p) return { videoId, title: null, duration: null, durationVerified: false };
        if ('error' in p) return { videoId, title: null, duration: null, durationVerified: false, validationError: p.error };
        const base = { videoId, title: p.title, duration: p.duration, durationVerified: p.verified };
        if (p.live) return { ...base, validationError: 'LIVE_NOT_SUPPORTED' };
        if (p.duration !== null && p.duration > limit) return { ...base, validationError: 'LIMIT_DURATION' };
        return base;
      });

      if (newItems.every((i) => i.validationError)) {
        throw new AppError('NO_VALID_ITEMS', {
          details: newItems.map((i, n) => ({
            itemId: `i${n}`,
            videoId: i.videoId,
            error: { code: i.validationError, message: ERROR_CATALOG[i.validationError as ErrorCode].message },
          })),
        });
      }

      const jobId = randomUUID();
      const now = Date.now();
      const { items: created } = await critical(
        createJob(app.redis, { jobId, format, quality, ipHash: ipHash(req.ip, config.ipHashSalt), items: newItems, ttlSec: config.jobTtlSec, now }),
        req.log,
      );
      reply.code(201);
      return {
        jobId,
        format,
        quality,
        expiresAt: new Date(now + config.jobTtlSec * 1000).toISOString(),
        items: created.map((it) => ({
          itemId: it.itemId,
          videoId: it.videoId,
          title: it.title,
          duration: it.duration,
          status: it.status === 'error' ? ('error' as const) : ('pending' as const),
          ...(it.error ? { error: it.error, errorKind: 'validation' as const } : {}),
        })),
      };
    },
  );

  app.get(
    '/api/jobs/:id',
    { schema: { params: JobParams, response: { 200: SnapshotResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } } },
    async (req, reply) => {
      const view = await critical(readJob(app.redis, req.params.id, { slotLeaseMs: config.slotLeaseMs }), req.log);
      if (!view) throw new AppError('JOB_NOT_FOUND');
      reply.header('cache-control', 'no-store');
      return view.snapshot;
    },
  );

  app.delete(
    '/api/jobs/:id',
    {
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { params: JobParams, response: { 202: CancelResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const r = await critical(cancelJob(app.redis, req.params.id, config.jobTtlSec), req.log);
      if (r === 0) throw new AppError('JOB_NOT_FOUND');
      reply.code(202);
      return { jobId: req.params.id, status: 'canceled' as const };
    },
  );
};

export default jobsRoute;
