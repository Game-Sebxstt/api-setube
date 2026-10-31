import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { AppError } from '../lib/errors.js';
import { HLS_CONTENT_TYPE, masterPlaylist, mediaPlaylist, type HlsAudio, type HlsVariant } from '../lib/preview/hls.js';
import { createInfoCache } from '../lib/preview/info-cache.js';
import { createPreviewLeases, MAX_CONNS_PER_PLAYER, MAX_MEDIA_CONNS_PER_PLAYER, MEDIA_LEASE_GRACE_MS } from '../lib/preview/leases.js';
import { createPreviewProxy } from '../lib/preview/proxy.js';
import { createSegmentIndex } from '../lib/preview/segment-index.js';
import type { SessionDeps } from '../lib/preview/session.js';
import { previewAudioRendition, previewSourceFor, videoPreviewRenditions, type VideoRendition } from '../lib/youtube/formats.js';
import type { Meta } from '../lib/youtube/metadata.js';
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
// El sid es obligatorio en el video: todas las peticiones del reproductor (playlists, video y audio) cuentan como
// un solo hueco por IP y conservan la gracia entre segmentos. Los playlists lo propagan en cada URI.
export const MediaQuery = Type.Object({ sid: Sid }, { additionalProperties: false });
export const HlsQuery = MediaQuery;

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

  // Playlists HLS: mismas comprobaciones que /media (habilitado, apagado, origen, directo, duración)
  async function loadVideo(req: FastifyRequest, videoId: string): Promise<{ meta: Meta; info: Record<string, unknown> }> {
    if (!config.previewEnabled || !config.previewVideoEnabled) throw new AppError('SERVICE_UNAVAILABLE');
    if (app.lifecycle.draining) throw new AppError('SERVER_SHUTDOWN');
    proxy.checkOrigin(req);
    const meta = await app.yt.metadata.get(videoId);
    if (meta.live) throw new AppError('LIVE_NOT_SUPPORTED');
    if (meta.duration > config.maxDurationAudioSec) throw new AppError('LIMIT_DURATION');
    const info = (await infoCache.readInfoJson(videoId)) ?? (await infoCache.refresh(videoId)).infoJson;
    return { meta, info };
  }

  const sendPlaylist = (reply: FastifyReply, body: string) =>
    reply.header('content-type', HLS_CONTENT_TYPE).header('cache-control', 'private, max-age=600').send(body);

  // Precalentado en segundo plano: el reproductor pide estos dos playlists justo después del master
  const warm = (videoId: string, formatId: string) => {
    index.get(videoId, formatId).catch(() => undefined);
  };

  const hlsRoute = {
    exposeHeadRoute: false,
    helmet,
    config: { rateLimit: { max: config.previewSegmentRateLimitMax, timeWindow: 60_000 } },
    onSend: errorNoStore,
  } as const;

  app.get(
    '/api/videos/:videoId/hls/master.m3u8',
    { ...hlsRoute, schema: { params: VideoParams, querystring: HlsQuery, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } } },
    async (req, reply) => {
      const { videoId } = req.params;
      const { meta, info } = await loadVideo(req, videoId);
      const plan = hlsPlan(info, meta.duration, config.previewVideoMaxHeight);
      if (!plan) throw new AppError('FORMAT_UNAVAILABLE');
      warm(videoId, plan.audio.formatId);
      warm(videoId, plan.start);
      return sendPlaylist(reply, masterPlaylist({ variants: plan.variants, audio: plan.audio, sid: req.query.sid }));
    },
  );

  app.get(
    '/api/videos/:videoId/hls/:formatId.m3u8',
    { ...hlsRoute, schema: { params: MediaParams, querystring: HlsQuery, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } } },
    async (req, reply) => {
      const { videoId, formatId } = req.params;
      const { info } = await loadVideo(req, videoId);
      // Como en /media: un formato fuera de la lista permitida es un recurso que no existe → 404
      const unavailable = () => new AppError('FORMAT_UNAVAILABLE', { status: 404 });
      const src = previewSourceFor(info, formatId, config.previewVideoMaxHeight);
      if (!src) throw unavailable();
      // Si el navegador se va, deja de esperar (el cálculo compartido sigue para los demás)
      const ac = new AbortController();
      const onClose = () => ac.abort();
      reply.raw.once('close', onClose);
      try {
        let ix = await index.get(videoId, formatId, ac.signal);
        // El índice en memoria no mira el tamaño: si la info actual dice otro archivo, se recalcula una vez
        if (src.size !== null && ix.size !== src.size) {
          index.forget(videoId, formatId);
          ix = await index.get(videoId, formatId, ac.signal);
        }
        return sendPlaylist(reply, mediaPlaylist(ix, req.query.sid));
      } catch (e) {
        if (e instanceof AppError && e.code === 'FORMAT_UNAVAILABLE') throw unavailable();
        throw e;
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
};

const START_QUALITY = 720;

/**
 * Variantes del master en orden: primero la de arranque (720p o la más cercana por debajo; si no hay, la más baja),
 * después el resto de menor a mayor. hls.js empieza por la primera del master si el cliente no fija startLevel.
 * null si no hay variantes de video o falta el m4a.
 */
export function hlsPlan(info: Record<string, unknown>, durationSec: number, maxHeight: number) {
  const renditions = videoPreviewRenditions(info, maxHeight);
  const audio = previewAudioRendition(info);
  if (renditions.length === 0 || !audio) return null;
  const perSec = (size: number | null) => (size !== null && durationSec > 0 ? (size * 8) / durationSec : null);
  const below = renditions.filter((r) => r.quality <= START_QUALITY);
  const start = (below.length ? below[below.length - 1] : renditions[0]) as VideoRendition;
  const ordered = [start, ...renditions.filter((r) => r !== start)];
  const variants: HlsVariant[] = ordered.map((r) => {
    const w = r.width ?? Math.round((r.height * 16) / 9);
    // Media real (tamaño / duración); si falta, el tbr de yt-dlp; si tampoco, ~0,1 bits por píxel
    const videoBps = perSec(r.size) ?? (r.tbr !== null ? r.tbr * 1000 : w * r.height * (r.fps ?? 30) * 0.1);
    return { formatId: r.formatId, videoBps, width: r.width, height: r.height, fps: r.fps, codec: r.vcodec };
  });
  const hlsAudio: HlsAudio = {
    formatId: audio.formatId,
    bps: perSec(audio.size) ?? (audio.abr !== null ? audio.abr * 1000 : 128_000),
    codec: audio.acodec,
  };
  return { variants, audio: hlsAudio, start: start.formatId };
}

export default previewRoute;
