import { buildApp, type AppDeps } from '../../../src/app.js';
import { loadConfig, type Config } from '../../../src/config/env.js';
import { TEST_REDIS_URL, type TestRedis } from './redis.js';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', REDIS_URL: TEST_REDIS_URL, ...env });
}

export async function buildTestApp(t: TestRedis, opts: { env?: Record<string, string>; deps?: AppDeps } = {}) {
  const config = testConfig(opts.env);
  const app = await buildApp({
    config,
    deps: { redis: t.redis, subscriber: t.subscriber, logger: false, ...opts.deps },
  });
  await app.ready();
  return { app, config };
}
