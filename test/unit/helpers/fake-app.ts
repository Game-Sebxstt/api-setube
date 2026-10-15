import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { buildApp, type AppDeps } from '../../../src/app.js';
import { loadConfig } from '../../../src/config/env.js';

type Handler = (...args: unknown[]) => unknown;

export function fakeRedis(handlers: Record<string, Handler> = {}): Redis {
  const target = Object.assign(new EventEmitter(), { status: 'ready' }) as unknown as EventEmitter & Record<string, unknown>;
  const run = (name: string, args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') return void (cb as (e: Error | null) => void)(new Error(`fake redis: ${name}`));
    const h = handlers[name];
    return h ? Promise.resolve().then(() => h(...args)) : Promise.reject(new Error(`fake redis: ${name}`));
  };
  target.defineCommand = (name: string) => {
    target[name] = (...args: unknown[]) => run(name, args);
  };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return (t as Record<string | symbol, unknown>)[p];
      if (typeof p === 'string' && handlers[p]) return (...args: unknown[]) => run(p, args);
      return undefined;
    },
  }) as unknown as Redis;
}

export const ORIGIN = 'https://setube.example';

export async function buildFakeApp(handlers: Record<string, Handler> = {}, deps: AppDeps = {}, env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6390', CORS_ORIGINS: ORIGIN, ...env });
  const app = await buildApp({
    config,
    deps: { redis: fakeRedis(handlers), subscriber: fakeRedis(), logger: false, ...deps },
  });
  await app.ready();
  return app;
}
