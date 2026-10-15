import fp from 'fastify-plugin';
import { Redis, type RedisOptions } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { PubSub } from '../lib/pubsub.js';

const retryStrategy = (times: number) => Math.min(50 * 2 ** Math.max(0, times - 1), 2000);

export function commandOptions(extra: RedisOptions = {}): RedisOptions {
  return {
    enableAutoPipelining: true,
    connectTimeout: 5000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 2,
    retryStrategy,
    ...extra,
  };
}

export function subscriberOptions(extra: RedisOptions = {}): RedisOptions {
  return {
    connectTimeout: 5000,
    maxRetriesPerRequest: null,
    autoResubscribe: false,
    retryStrategy,
    ...extra,
  };
}

export function watchConnection(conn: Redis, log: FastifyBaseLogger, name: string): void {
  let down = false;
  conn.on('error', (e: Error & { code?: string }) => {
    if (down) return;
    down = true;
    log.error({ err: { message: e.message, code: e.code }, conn: name }, 'redis_error');
  });
  conn.on('ready', () => {
    if (!down) return;
    down = false;
    log.info({ conn: name }, 'redis_recovered');
  });
}

export interface RedisPluginOptions {
  url: string;
  redis?: Redis | undefined;
  subscriber?: Redis | undefined;
}

export default fp<RedisPluginOptions>(
  async (app, opts) => {
    const ownsRedis = !opts.redis;
    const ownsSub = !opts.subscriber;
    const redis = opts.redis ?? new Redis(opts.url, commandOptions());
    const subscriber = opts.subscriber ?? new Redis(opts.url, subscriberOptions());
    if (ownsRedis) watchConnection(redis, app.log, 'commands');
    if (ownsSub) watchConnection(subscriber, app.log, 'subscriber');

    app.decorate('redis', redis);
    app.decorate('pubsub', new PubSub(subscriber, app.log));

    app.addHook('onClose', async () => {
      await Promise.allSettled([
        ownsRedis ? redis.quit() : Promise.resolve(),
        ownsSub ? subscriber.quit() : Promise.resolve(),
      ]);
    });
  },
  { name: 'setube-redis' },
);
