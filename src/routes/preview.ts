import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from 'typebox';
import { AppError } from '../lib/errors.js';
import { createInfoCache } from '../lib/preview/info-cache.js';
import { createPreviewLeases, MAX_CONNS_PER_PLAYER, MAX_MEDIA_CONNS_PER_PLAYER, MEDIA_LEASE_GRACE_MS } from '../lib/preview/leases.js';
import { createPreviewProxy } from '../lib/preview/proxy.js';
import { createSegmentIndex } from '../lib/preview/segment-index.js';
import type { SessionDeps } from '../lib/preview/session.js';
import { throttledWarn } from '../lib/youtube/oembed.js';
import { ErrorResponse, VideoId } from '../schemas/common.js';
import { VideoParams } from '../schemas/videos.js';

export type { PreviewTuning } from '../lib/preview/proxy.js';

const Sid = Type.String({ pattern: '^[0-9a-f]{32}$' });

export const PreviewQuery = Type.Object(
  {
    codec: Type.Optional(Type.Union([Type.Literal('aac'), Type.Literal('opus')])),
    sid: Type.Optional(Sid),
  },
  { additionalProperties: false },
);

// formatId de yt-dlp (140, 136, 140-drc…); además tiene que estar en la lista permitida del video
export const FORMAT_ID_PATTERN = '^[0-9A-Za-z-]{1,24}$';
export const MediaParams = Type.Object(
  { videoId: VideoId, formatId: Type.String({ pattern: FORMAT_ID_PATTERN }) },
  { additionalProperties: false },
);
export const MediaQuery = Type.Object({ sid: Type.Optional(Sid) }, { additionalProperties: false });

// La respuesta es binaria: el documento no se puede enmarcar ni cargar nada
const helmet = {
  frameguard: false,
  contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
} as const;

const errorNoStore = async (_req: unknown, reply: FastifyReply, payload: unknown) => {
  if (reply.statusCode >= 400) reply.header('cache-control', 'no-store');
  return payload;
};

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
  // Info JSON parseado en memoria (~60 s): las peticiones seguidas al mismo video no vuelven a leerlo y parsearlo de Redis
  const infoCache = createInfoCache(app.yt.metadata);
  const sessionDeps: SessionDeps = {
    fetch: app.deps.upstreamFetch,
    chunkBytes: config.previewChunkBytes,
    headersTimeoutMs: tuning.headersTimeoutMs,
    metadata: infoCache,
    redis: app.redis,
    warn,
    retryDelayMs: tuning.retryDelayMs,
    retryJitterMs: tuning.retryJitterMs,
  };
  // Índice de segmentos por formato (para los playlists HLS); /media lo invalida si ve otro archivo
  const index = createSegmentIndex({ session: sessionDeps, ttlSec: config.infoJsonTtlSec, maxHeight: config.previewVideoMaxHeight });
  const proxy = createPreviewProxy(app, { tuning, leases, session: sessionDeps, index });

  app.get(
    '/api/videos/:videoId/audio',
    {
      exposeHeadRoute: false,
      helmet,
      config: { rateLimit: { max: config.previewRateLimitMax, timeWindow: 60_000 } },
      schema: { params: VideoParams, querystring: PreviewQuery, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
      onSend: errorNoStore,
    },
    async (req, reply) => {
      if (!config.previewEnabled) throw new AppError('SERVICE_UNAVAILABLE');
      const { codec, sid } = req.query;
      await proxy.serve(req, reply, { kind: 'audio', videoId: req.params.videoId, sid, selector: codec, maxConns: MAX_CONNS_PER_PLAYER });
    },
  );

  // Segmentos del video en streaming (HLS fMP4 por rangos de bytes): variantes avc1 ≤ PREVIEW_VIDEO_MAX_HEIGHT y el mejor m4a
  app.get(
    '/api/videos/:videoId/media/:formatId',
    {
      exposeHeadRoute: false,
      helmet,
      config: { rateLimit: { max: config.previewSegmentRateLimitMax, timeWindow: 60_000 } },
      schema: { params: MediaParams, querystring: MediaQuery, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
      onSend: errorNoStore,
    },
    async (req, reply) => {
      if (!config.previewEnabled || !config.previewVideoEnabled) throw new AppError('SERVICE_UNAVAILABLE');
      const { videoId, formatId } = req.params;
      await proxy.serve(req, reply, {
        kind: 'media',
        videoId,
        sid: req.query.sid,
        selector: { formatId, maxHeight: config.previewVideoMaxHeight },
        maxConns: MAX_MEDIA_CONNS_PER_PLAYER,
        // El reproductor conserva su hueco por IP entre segmento y segmento (buffer lleno o pausa)
        leaseGraceMs: tuning.mediaLeaseGraceMs ?? MEDIA_LEASE_GRACE_MS,
      });
    },
  );
};

export default previewRoute;
