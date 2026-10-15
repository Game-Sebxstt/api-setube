import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Static } from 'typebox';
import type { Config } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import type { Meta } from '../lib/youtube/metadata.js';
import { thumbnailUrl } from '../lib/youtube/url.js';
import { ErrorResponse } from '../schemas/common.js';
import { VideoParams, VideoResponse } from '../schemas/videos.js';

type PublicVideo = Static<typeof VideoResponse>;

const mp3Bytes = (kbps: number, duration: number) => Math.round(((kbps * 1000) / 8) * duration);

export function toPublicVideo(meta: Meta, config: Pick<Config, 'maxDurationAudioSec' | 'maxDurationVideoSec'>): PublicVideo {
  const { opus, m4a, hls } = meta.audio;
  const src = opus ?? m4a ?? hls;
  const d = meta.duration;
  const mp4: Record<string, number | null> = {};
  const aBytes = meta.audioForVideo?.bytes ?? null;
  for (const v of meta.video) mp4[String(v.height)] = v.bytes !== null && aBytes !== null ? v.bytes + aBytes : null;
  const top = meta.video[meta.video.length - 1];
  mp4.best = top ? (mp4[String(top.height)] ?? null) : null;
  return {
    videoId: meta.videoId,
    title: meta.title,
    author: meta.author,
    duration: d,
    thumbnail: thumbnailUrl(meta.videoId),
    description: meta.description,
    live: false,
    audio: {
      sourceCodec: opus ? 'opus' : m4a ? 'aac' : (hls?.acodec.split('.')[0] ?? 'desconocido'),
      sourceAbrKbps: src?.abr != null ? Math.round(src.abr) : null,
      m4aNative: !!m4a,
    },
    videoQualities: meta.video.map((v) => v.height),
    estimatedBytes: {
      mp3: { 128: mp3Bytes(128, d), 192: mp3Bytes(192, d), 320: mp3Bytes(320, d) },
      m4a: m4a?.bytes ?? null,
      wav: 44100 * 2 * 2 * d + 44,
      mp4,
    },
    limits: { audioOk: d <= config.maxDurationAudioSec, videoOk: d <= config.maxDurationVideoSec },
  };
}

const videosRoute: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/videos/:videoId',
    {
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
      schema: { params: VideoParams, response: { 200: VideoResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const meta = await app.yt.metadata.get(req.params.videoId);
      if (meta.live) throw new AppError('LIVE_NOT_SUPPORTED');
      reply.header('cache-control', 'public, max-age=600');
      return toPublicVideo(meta, app.config);
    },
  );
};

export default videosRoute;
