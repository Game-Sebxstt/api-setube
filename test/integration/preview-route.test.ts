import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ipHash } from '../../src/lib/ip.js';
import { pvIpsKey } from '../../src/lib/preview/leases.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { fakeMp4 } from '../unit/helpers/mp4.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, pattern, serve, videoFormat } from '../unit/helpers/upstream.js';
import { buildTestApp } from './helpers/app.js';
import { countKeys, createTestRedis, type TestRedis } from './helpers/redis.js';

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
// /media exige el sid del reproductor
const SID3 = '3'.repeat(32);
const MEDIA_S = `${MEDIA}?sid=${SID3}`;

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
    const partial = await app.inject({ method: 'GET', url: MEDIA_S, headers: { range: 'bytes=4000-4999' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-type']).toBe('video/mp4');
    expect(partial.headers['content-range']).toBe(`bytes 4000-4999/${d.data.length}`);
    expect(partial.rawPayload.equals(d.data.subarray(4000, 5000))).toBe(true);
    const full = await app.inject({ method: 'GET', url: MEDIA_S });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(d.data)).toBe(true);
    const out = await app.inject({ method: 'GET', url: MEDIA_S, headers: { range: `bytes=${d.data.length}-` } });
    expect(out.statusCode).toBe(416);
    expect(out.headers['content-range']).toBe(`bytes */${d.data.length}`);
    expectError(await app.inject({ method: 'GET', url: `/api/videos/jNQXAC9IVRw/media/251?sid=${SID3}` }), 404, 'FORMAT_UNAVAILABLE');
    expectError(await app.inject({ method: 'GET', url: MEDIA }), 400, 'INVALID_INPUT');
    await new Promise((r) => setTimeout(r, 50));
    // Todas las peticiones son del mismo reproductor: un solo hueco, que conserva (gracia) hasta que se cierra la app
    const key = pvIpsKey(ipHash('127.0.0.1', built.config.ipHashSalt));
    expect(await t.redis.zrange(key, 0, -1)).toEqual([`s:${SID3}`]);
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
    expectError(await app.inject({ method: 'GET', url: MEDIA_S }), 503, 'SERVICE_UNAVAILABLE');
    expectError(await app.inject({ method: 'GET', url: MEDIA_S }), 503, 'SERVICE_UNAVAILABLE');
    const limited = await app.inject({ method: 'GET', url: MEDIA_S });
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
      const res = await app.inject({ method: 'GET', url: MEDIA_S, headers: { range: `bytes=${i * 100}-${i * 100 + 99}` } });
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

// Playlists HLS del video en streaming sobre MP4 fragmentados sintéticos (ftyp + moov + sidx + fragmentos)
function hlsDeps() {
  const files: Record<string, ReturnType<typeof fakeMp4>> = {
    '136': fakeMp4({ fragments: 9, fragmentSize: 4000 }),
    '140': fakeMp4({ fragments: 2, fragmentSize: 2500, duration: 15360 * 9 }),
  };
  const info = infoWith([videoFormat('136', 720, files['136']!.data.length), audioFormat('140', files['140']!.data.length)]);
  const metadata = {
    get: async () => fakeMeta({ duration: 18 }),
    readInfoJson: async () => info,
    refresh: async () => ({ meta: fakeMeta(), infoJson: info }),
  } as unknown as MetadataService;
  const f = fakeFetch((c) => serve(files[new URL(c.url).searchParams.get('itag') ?? '']!.data, c, { contentType: 'video/mp4' }));
  return { files, calls: f.calls, deps: { fetch: f.fetch, youtube: { metadata }, preview: { retryDelayMs: 0, retryJitterMs: 0 } } };
}

const HLS = '/api/videos/jNQXAC9IVRw/hls';

describe('playlists HLS con Redis real', () => {
  it('master → media playlist → init y segmentos por /media; el índice queda en Redis para otra instancia', async () => {
    const h = hlsDeps();
    ({ app } = await buildTestApp(t, { deps: h.deps }));
    const master = await app.inject({ method: 'GET', url: `${HLS}/master.m3u8?sid=${SID3}` });
    expect(master.statusCode).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.body).toContain(`URI="140.m3u8?sid=${SID3}"`);
    expect(master.body).toContain(`\n136.m3u8?sid=${SID3}\n`);
    // El precalentado deja los dos índices en Redis
    const until = Date.now() + 3000;
    while ((await countKeys(t, 'pv:idx:*')) < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(await countKeys(t, 'pv:idx:*')).toBe(2);

    for (const id of ['136', '140']) {
      const pl = await app.inject({ method: 'GET', url: `${HLS}/${id}.m3u8?sid=${SID3}` });
      expect(pl.statusCode).toBe(200);
      expect(pl.body.startsWith('#EXTM3U\n')).toBe(true);
      expect(pl.body.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
      const ranges = [...pl.body.matchAll(/BYTERANGE[:=]"?(\d+)@(\d+)"?/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const parts: Buffer[] = [];
      for (const [len, off] of ranges) {
        const res = await app.inject({ method: 'GET', url: `/api/videos/jNQXAC9IVRw/media/${id}?sid=${SID3}`, headers: { range: `bytes=${off}-${off + len - 1}` } });
        expect(res.statusCode).toBe(206);
        parts.push(res.rawPayload);
      }
      const file = h.files[id]!;
      expect(Buffer.concat(parts).equals(Buffer.concat([file.data.subarray(0, file.initEnd), file.data.subarray(file.sidxEnd)]))).toBe(true);
    }
    const before = h.calls.length;
    await app.close();

    // Otra instancia (memoria vacía) saca el índice de Redis: los playlists no tocan googlevideo
    const h2 = hlsDeps();
    ({ app } = await buildTestApp(t, { deps: h2.deps }));
    const again = await app.inject({ method: 'GET', url: `${HLS}/136.m3u8?sid=${SID3}` });
    expect(again.statusCode).toBe(200);
    expect(h2.calls).toHaveLength(0);
    expect(before).toBeGreaterThan(0);
  });

  it('los playlists usan PREVIEW_SEGMENT_RATE_LIMIT_MAX: 429 RATE_LIMITED no-store con retry-after', async () => {
    const h = hlsDeps();
    ({ app } = await buildTestApp(t, { deps: h.deps, env: { PREVIEW_SEGMENT_RATE_LIMIT_MAX: '2', RATE_LIMIT_MAX: '1' } }));
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'GET', url: `${HLS}/136.m3u8?sid=${SID3}` })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: `${HLS}/136.m3u8?sid=${SID3}` });
    expectError(limited, 429, 'RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // El master tiene su propio contador y no gasta el global (RATE_LIMIT_MAX 1)
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'GET', url: `${HLS}/master.m3u8?sid=${SID3}` })).statusCode).toBe(200);
    expectError(await app.inject({ method: 'GET', url: `${HLS}/master.m3u8?sid=${SID3}` }), 429, 'RATE_LIMITED');
  });
});
