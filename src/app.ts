import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import ajvFormats from 'ajv-formats';
import type { Redis } from 'ioredis';
import type { Config } from './config/env.js';
import { Lifecycle, registerLifecycle } from './lib/lifecycle.js';
import { loggerOptions } from './lib/logger.js';
import { configureProc } from './lib/media/proc.js';
import type { PubSub } from './lib/pubsub.js';
import { createMetadata, type MetadataService } from './lib/youtube/metadata.js';
import { createOembed, type OembedService } from './lib/youtube/oembed.js';
import { createPlaylists, type PlaylistService } from './lib/youtube/playlist.js';
import errorsPlugin from './plugins/errors.js';
import redisPlugin from './plugins/redis.js';
import securityPlugin from './plugins/security.js';
import type { Semaphore } from './lib/jobs/semaphore.js';
import configRoute from './routes/config.js';
import downloadsRoute from './routes/downloads.js';
import eventsRoute from './routes/events.js';
import healthRoute from './routes/health.js';
import jobsRoute from './routes/jobs.js';
import playlistsRoute from './routes/playlists.js';
import resolveRoute from './routes/resolve.js';
import videosRoute from './routes/videos.js';

export interface YoutubeServices {
  oembed: OembedService;
  metadata: MetadataService;
  playlists: PlaylistService;
}

export interface AppDeps {
  redis?: Redis;
  subscriber?: Redis;
  fetch?: typeof fetch;
  logger?: false | { stream: NodeJS.WritableStream };
  lifecycle?: Lifecycle;
  youtube?: Partial<YoutubeServices>;
  streams?: StreamTuning;
}

export interface StreamTuning {
  timers?: { tickMs?: number; stallCheckMs?: number };
  heartbeatMs?: number;
  lockTtlMs?: number;
  throttleMs?: number;
  slotRenewMs?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    redis: Redis;
    pubsub: PubSub;
    lifecycle: Lifecycle;
    yt: YoutubeServices;
    deps: { fetch: typeof fetch; streams?: StreamTuning };
    semaphore: Semaphore;
  }
}

export async function buildApp({ config, deps = {} }: { config: Config; deps?: AppDeps }): Promise<FastifyInstance> {
  const logger: FastifyServerOptions['logger'] =
    deps.logger === false ? false : loggerOptions(config, deps.logger?.stream);

  const app = Fastify({
    logger,
    bodyLimit: 65536,
    // Fastify admite número de saltos en runtime (proxy-addr), aunque sus tipos no lo declaren
    trustProxy: config.trustProxy as Exclude<FastifyServerOptions['trustProxy'], undefined>,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: {
      customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false },
      plugins: [ajvFormats as never],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.removeContentTypeParser('text/plain');

  configureProc({
    ytdlpPath: config.ytdlpPath,
    ytdlpArgsPrefix: config.ytdlpArgsPrefix,
    ffmpegPath: config.ffmpegPath,
    ffmpegArgsPrefix: config.ffmpegArgsPrefix,
    log: app.log,
  });

  const lifecycle = deps.lifecycle ?? new Lifecycle();
  app.decorate('config', config);
  app.decorate('lifecycle', lifecycle);
  app.decorate('deps', { fetch: deps.fetch ?? globalThis.fetch, streams: deps.streams });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(errorsPlugin);
  await app.register(redisPlugin, { url: config.redisUrl, redis: deps.redis, subscriber: deps.subscriber });
  await app.register(securityPlugin);
  registerLifecycle(app, lifecycle);

  const log = app.log;
  app.decorate('yt', {
    oembed: deps.youtube?.oembed ?? createOembed({ redis: app.redis, fetch: app.deps.fetch, ttlSec: config.oembedTtlSec, log }),
    metadata:
      deps.youtube?.metadata ??
      createMetadata({
        redis: app.redis,
        log,
        metaTtlSec: config.metaTtlSec,
        infoJsonTtlSec: config.infoJsonTtlSec,
        metaConcurrency: config.metaConcurrency,
      }),
    playlists:
      deps.youtube?.playlists ??
      createPlaylists({
        redis: app.redis,
        log,
        maxItems: config.maxPlaylistItems,
        ttlSec: config.playlistTtlSec,
        metaTtlSec: config.metaTtlSec,
      }),
  });

  await app.register(healthRoute);
  await app.register(configRoute);
  await app.register(resolveRoute);
  await app.register(videosRoute);
  await app.register(playlistsRoute);
  await app.register(jobsRoute);
  await app.register(eventsRoute);
  // fastify-plugin no se usa: el decorador `semaphore` queda en el scope de las rutas de descarga
  await app.register(downloadsRoute);

  return app;
}
