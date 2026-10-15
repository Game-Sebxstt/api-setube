import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

export const MP3_QUALITIES = [128, 192, 320] as const;
export const MP4_QUALITIES = [360, 480, 720, 1080, 'best'] as const;

const PublicConfig = Type.Object(
  {
    maxItemsPerJob: Type.Integer(),
    maxPlaylistItems: Type.Integer(),
    maxDurationAudioSec: Type.Integer(),
    maxDurationVideoSec: Type.Integer(),
    formats: Type.Object(
      {
        mp3: Type.Array(Type.Integer()),
        m4a: Type.Array(Type.Integer()),
        wav: Type.Array(Type.Integer()),
        mp4: Type.Array(Type.Union([Type.Integer(), Type.Literal('best')])),
      },
      { additionalProperties: false },
    ),
    defaults: Type.Object({ mp3: Type.Integer(), mp4: Type.Integer() }, { additionalProperties: false }),
    turnstile: Type.Boolean(),
  },
  { additionalProperties: false },
);

const configRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const body = {
    maxItemsPerJob: config.maxItemsPerJob,
    maxPlaylistItems: config.maxPlaylistItems,
    maxDurationAudioSec: config.maxDurationAudioSec,
    maxDurationVideoSec: config.maxDurationVideoSec,
    formats: { mp3: [...MP3_QUALITIES], m4a: [], wav: [], mp4: [...MP4_QUALITIES] },
    defaults: { mp3: 192, mp4: 720 },
    turnstile: config.turnstileSecret !== null,
  };
  app.get('/api/config', { schema: { response: { 200: PublicConfig } } }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return body;
  });
};

export default configRoute;
