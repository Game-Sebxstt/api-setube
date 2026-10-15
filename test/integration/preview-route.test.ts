import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ipHash } from '../../src/lib/ip.js';
import { pvIpsKey } from '../../src/lib/preview/leases.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, pattern, serve } from '../unit/helpers/upstream.js';
import { buildTestApp } from './helpers/app.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

const URL_ = '/api/videos/jNQXAC9IVRw/audio';
let t: TestRedis;
let app: FastifyInstance;

beforeEach(async () => {
  t = await createTestRedis();
});
afterEach(async () => {
  await app?.close();
  await t.cleanup();
});

function deps(size = 5000) {
  const data = pattern(size);
  const info = infoWith([audioFormat('140', size)]);
  const metadata = {
    get: async () => fakeMeta(),
    readInfoJson: async () => info,
    refresh: async () => ({ meta: fakeMeta(), infoJson: info }),
  } as unknown as MetadataService;
  return { data, fetch: fakeFetch((c) => serve(data, c)).fetch, youtube: { metadata }, preview: { retryDelayMs: 0, retryJitterMs: 0 } };
}

const expectError = (res: { statusCode: number; headers: Record<string, unknown>; json(): unknown }, status: number, code: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  const body = res.json() as { error: { code: string; message: string }; requestId: string };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(typeof body.requestId).toBe('string');
};

describe('ruta de audio con Redis real', () => {
  it('desactivada: 503 y después 429 del rate limit propio de la ruta, ambos no-store', async () => {
    ({ app } = await buildTestApp(t, { env: { PREVIEW_RATE_LIMIT_MAX: '1', PREVIEW_ENABLED: 'false', CORS_ORIGINS: 'https://setube.example' } }));
    expectError(await app.inject({ method: 'GET', url: URL_ }), 503, 'SERVICE_UNAVAILABLE');
    expectError(await app.inject({ method: 'GET', url: URL_ }), 429, 'RATE_LIMITED');
  });

  it('206 con Range y 200 sin Range, sin dejar leases colgados', async () => {
    const d = deps();
    const built = await buildTestApp(t, { deps: d });
    app = built.app;
    const { config } = built;
    const partial = await app.inject({ method: 'GET', url: URL_, headers: { range: 'bytes=10-19' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 10-19/5000');
    expect(partial.rawPayload.equals(d.data.subarray(10, 20))).toBe(true);
    const full = await app.inject({ method: 'GET', url: URL_ });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(d.data)).toBe(true);
    expect(full.headers['accept-ranges']).toBe('bytes');
    await new Promise((r) => setTimeout(r, 50));
    expect(await t.redis.zcard(pvIpsKey(ipHash('127.0.0.1', config.ipHashSalt)))).toBe(0);
  });

  it('tope por IP con los Lua reales: el 2.º reproductor de la misma IP recibe 429 TOO_MANY_PREVIEWS', async () => {
    const d = deps(64 * 1024 * 1024);
    ({ app } = await buildTestApp(t, { env: { PREVIEW_MAX_STREAMS_PER_IP: '1' }, deps: d }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const http = await import('node:http');
    const held = await new Promise<import('node:http').ClientRequest>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `${URL_}?sid=${'1'.repeat(32)}`, agent: false }, (res) => {
        res.pause();
        resolve(req);
      });
      req.on('error', () => undefined);
    });
    const second = await app.inject({ method: 'GET', url: `${URL_}?sid=${'2'.repeat(32)}` });
    expectError(second, 429, 'TOO_MANY_PREVIEWS');
    held.destroy();
  });
});
