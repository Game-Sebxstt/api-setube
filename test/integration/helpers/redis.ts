import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { commandOptions, subscriberOptions } from '../../../src/plugins/redis.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6390';

function assertNotForeignRedis(url: string): void {
  const u = new URL(url);
  const port = u.port || '6379';
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname) && port === '6379') {
    throw new Error('TEST_REDIS_URL apunta a 127.0.0.1:6379 (Redis ajeno): prohibido');
  }
}

export interface TestRedis {
  redis: Redis;
  subscriber: Redis;
  prefix: string;
  cleanup(): Promise<void>;
}

export async function createTestRedis(): Promise<TestRedis> {
  assertNotForeignRedis(TEST_REDIS_URL);
  const prefix = `t:${randomUUID()}:`;
  const noRetry = { lazyConnect: true, retryStrategy: () => null };
  const redis = new Redis(TEST_REDIS_URL, commandOptions({ ...noRetry, keyPrefix: prefix }));
  const subscriber = new Redis(TEST_REDIS_URL, subscriberOptions(noRetry));
  const raw = new Redis(TEST_REDIS_URL, commandOptions(noRetry));
  try {
    await Promise.all([redis.connect(), subscriber.connect(), raw.connect()]);
    if ((await raw.ping()) !== 'PONG') throw new Error('PING sin PONG');
  } catch (e) {
    redis.disconnect();
    subscriber.disconnect();
    raw.disconnect();
    throw new Error(`Redis de test no disponible en TEST_REDIS_URL: ${(e as Error).message}`, { cause: e });
  }

  async function cleanup(): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await raw.unlink(...keys);
      } while (cursor !== '0');
    } finally {
      await Promise.allSettled([redis.quit(), subscriber.quit(), raw.quit()]);
    }
  }

  return { redis, subscriber, prefix, cleanup };
}

export async function countKeys(t: TestRedis, pattern = '*'): Promise<number> {
  let cursor = '0';
  let n = 0;
  const raw = t.redis.duplicate({ keyPrefix: '' });
  try {
    do {
      const [next, keys] = await raw.scan(cursor, 'MATCH', `${t.prefix}${pattern}`, 'COUNT', 500);
      cursor = next;
      n += keys.length;
    } while (cursor !== '0');
  } finally {
    raw.disconnect();
  }
  return n;
}
