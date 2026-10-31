import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ipHash } from '../../src/lib/ip.js';
import { pvIpsKey } from '../../src/lib/preview/leases.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, pattern, serve, videoFormat } from '../unit/helpers/upstream.js';
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

const MEDIA = '/api/videos/jNQXAC9IVRw/media/136';

// Video 720p sin audio y el m4a, del mismo tamaño (los dos salen de `data`)
function videoDeps(size = 50_000) {
  const data = pattern(size);
  const info = infoWith([videoFormat('136', 720, size), audioFormat('140', size), audioFormat('251', size)]);
  const metadata = {
    get: async () => fakeMeta(),
    readInfoJson: async () => info,
    refresh: async () => ({ meta: fakeMeta(), infoJson: info }),
  } as unknown as MetadataService;
  return { data, fetch: fakeFetch((c) => serve(data, c, { contentType: 'video/mp4' })).fetch, youtube: { metadata }, preview: { retryDelayMs: 0, retryJitterMs: 0 } };
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

  it('/media: 206 con los bytes exactos, 200 sin Range y 416 fuera de rango, sin dejar leases colgados', async () => {
    const d = videoDeps();
    const built = await buildTestApp(t, { deps: d });
    app = built.app;
    const partial = await app.inject({ method: 'GET', url: `${MEDIA}?sid=${'3'.repeat(32)}`, headers: { range: 'bytes=4000-4999' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-type']).toBe('video/mp4');
    expect(partial.headers['content-range']).toBe(`bytes 4000-4999/${d.data.length}`);
    expect(partial.rawPayload.equals(d.data.subarray(4000, 5000))).toBe(true);
    const full = await app.inject({ method: 'GET', url: MEDIA });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(d.data)).toBe(true);
    const out = await app.inject({ method: 'GET', url: MEDIA, headers: { range: `bytes=${d.data.length}-` } });
    expect(out.statusCode).toBe(416);
    expect(out.headers['content-range']).toBe(`bytes */${d.data.length}`);
    expectError(await app.inject({ method: 'GET', url: '/api/videos/jNQXAC9IVRw/media/251' }), 404, 'FORMAT_UNAVAILABLE');
    await new Promise((r) => setTimeout(r, 50));
    // Sin sid se suelta en el acto; el reproductor con sid conserva su hueco (gracia) hasta que se cierra la app
    const key = pvIpsKey(ipHash('127.0.0.1', built.config.ipHashSalt));
    expect(await t.redis.zrange(key, 0, -1)).toEqual([`s:${'3'.repeat(32)}`]);
    await app.close();
    expect(await t.redis.zcard(key)).toBe(0);
  });

  it('/media: el hueco del reproductor sigue en el ZSET entre segmentos y desaparece al vencer la gracia', async () => {
    const d = videoDeps();
    const built = await buildTestApp(t, { deps: { ...d, preview: { ...d.preview, mediaLeaseGraceMs: 400 } }, env: { PREVIEW_MAX_STREAMS_PER_IP: '1' } });
    app = built.app;
    const key = pvIpsKey(ipHash('127.0.0.1', built.config.ipHashSalt));
    const sidA = 'a'.repeat(32);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: `${MEDIA}?sid=${sidA}`, headers: { range: `bytes=${i * 1000}-${i * 1000 + 999}` } });
      expect(res.statusCode).toBe(206);
      expect(await t.redis.zrange(key, 0, -1)).toEqual([`s:${sidA}`]);
    }
    // Otro reproductor de la misma IP no ocupa el hueco durante la gracia
    expectError(await app.inject({ method: 'GET', url: `${MEDIA}?sid=${'c'.repeat(32)}`, headers: { range: 'bytes=0-999' } }), 429, 'TOO_MANY_PREVIEWS');
    await new Promise((r) => setTimeout(r, 600));
    expect(await t.redis.zcard(key)).toBe(0);
    const other = await app.inject({ method: 'GET', url: `${MEDIA}?sid=${'c'.repeat(32)}`, headers: { range: 'bytes=0-999' } });
    expect(other.statusCode).toBe(206);
  });

  it('/media desactivado: 503 y después 429 de su propio rate limit (PREVIEW_SEGMENT_RATE_LIMIT_MAX), sin gastar el de /audio', async () => {
    ({ app } = await buildTestApp(t, {
      env: { PREVIEW_SEGMENT_RATE_LIMIT_MAX: '2', PREVIEW_RATE_LIMIT_MAX: '1', PREVIEW_VIDEO_ENABLED: 'false', CORS_ORIGINS: 'https://setube.example' },
      deps: videoDeps(),
    }));
    expectError(await app.inject({ method: 'GET', url: MEDIA }), 503, 'SERVICE_UNAVAILABLE');
    expectError(await app.inject({ method: 'GET', url: MEDIA }), 503, 'SERVICE_UNAVAILABLE');
    const limited = await app.inject({ method: 'GET', url: MEDIA });
    expectError(limited, 429, 'RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // /audio tiene su propio contador: la primera petición pasa aunque /media esté agotado
    const audio = await app.inject({ method: 'GET', url: URL_, headers: { range: 'bytes=0-9' } });
    expect(audio.statusCode).toBe(206);
    expectError(await app.inject({ method: 'GET', url: URL_ }), 429, 'RATE_LIMITED');
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ preview: true, previewVideo: false });
  });

  it('/media no consume el rate limit global (RATE_LIMIT_MAX): cada segmento es una petición', async () => {
    ({ app } = await buildTestApp(t, { env: { RATE_LIMIT_MAX: '2', PREVIEW_SEGMENT_RATE_LIMIT_MAX: '50' }, deps: videoDeps() }));
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: MEDIA, headers: { range: `bytes=${i * 100}-${i * 100 + 99}` } });
      expect(res.statusCode).toBe(206);
    }
  });

  it('tope por IP con /media: el 2.º reproductor recibe 429; el mismo sid por /audio comparte el hueco', async () => {
    const d = videoDeps(64 * 1024 * 1024);
    ({ app } = await buildTestApp(t, { env: { PREVIEW_MAX_STREAMS_PER_IP: '1' }, deps: d }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const http = await import('node:http');
    const sid1 = '4'.repeat(32);
    const held = await new Promise<import('node:http').ClientRequest>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `${MEDIA}?sid=${sid1}`, agent: false }, (res) => {
        res.pause();
        resolve(req);
      });
      req.on('error', () => undefined);
    });
    expectError(await app.inject({ method: 'GET', url: `${MEDIA}?sid=${'5'.repeat(32)}` }), 429, 'TOO_MANY_PREVIEWS');
    const same = await app.inject({ method: 'GET', url: `${URL_}?sid=${sid1}`, headers: { range: 'bytes=0-9' } });
    expect(same.statusCode).toBe(206);
    held.destroy();
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
