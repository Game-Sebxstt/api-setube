import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createPreviewLeases } from '../../src/lib/preview/leases.js';
import { createPreviewProxy } from '../../src/lib/preview/proxy.js';
import { createSegmentIndex } from '../../src/lib/preview/segment-index.js';
import type { SessionDeps } from '../../src/lib/preview/session.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { buildFakeApp, fakeRedis, ORIGIN } from './helpers/fake-app.js';
import { fakeMp4 } from './helpers/mp4.js';
import { audioFormat, fakeFetch, fakeMeta, gvUrl, infoWith, nowSec, pattern, serve, status, videoFormat, type Call } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const SID = 'b'.repeat(32);
const MEDIA_PATH = (formatId: string) => `/api/videos/${ID}/media/${formatId}`;
// El sid es obligatorio en /media (los playlists HLS siempre lo propagan)
const MEDIA = (formatId: string) => `${MEDIA_PATH(formatId)}?sid=${SID}`;
const AUDIO = `/api/videos/${ID}/audio`;
const MiB = 1024 * 1024;

type Line = Record<string, unknown> & { msg: string };

function memLog() {
  const lines: Line[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Line);
      cb();
    },
  });
  return { lines, stream, finished: () => lines.filter((l) => l.msg === 'preview_finished') };
}

function leaseHandlers() {
  return {
    setubeLeaseAcquire: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRenew: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRelease: vi.fn((..._a: unknown[]): unknown => 1),
    get: vi.fn((..._a: unknown[]): unknown => null),
    set: vi.fn((..._a: unknown[]): unknown => 'OK'),
  };
}

// Variantes 360p/720p/1080p de video sin audio y el audio m4a y opus, todos del mismo tamaño
const fullInfo = (size: number) =>
  infoWith([
    videoFormat('134', 360, size),
    videoFormat('136', 720, size),
    videoFormat('137', 1080, size),
    audioFormat('140', size),
    audioFormat('251', size),
  ]);

interface Opts {
  data?: Buffer;
  handler?: (c: Call, n: number) => Response | Promise<Response>;
  meta?: Partial<ReturnType<typeof fakeMeta>>;
  redis?: Record<string, (...a: unknown[]) => unknown>;
  env?: Record<string, string>;
  tuning?: AppDeps['preview'];
  info?: Record<string, unknown>;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function make(o: Opts = {}) {
  const data = o.data ?? pattern(3 * MiB);
  const f = fakeFetch(o.handler ?? ((c) => serve(data, c, { contentType: 'video/mp4' })));
  const info = o.info ?? fullInfo(data.length);
  const metadata = {
    get: vi.fn(async () => fakeMeta(o.meta)),
    readInfoJson: vi.fn(async () => info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: info })),
  };
  const log = memLog();
  const redis = o.redis ?? leaseHandlers();
  const app = await buildFakeApp(
    redis,
    {
      fetch: f.fetch,
      youtube: { metadata: metadata as unknown as MetadataService },
      logger: { stream: log.stream },
      preview: { watchdogMs: 50, idleTimeoutMs: 60_000, upstreamIdleMs: 200, renewMs: 50, retryDelayMs: 0, retryJitterMs: 0, ...o.tuning },
    },
    { LOG_LEVEL: 'debug', PREVIEW_CHUNK_BYTES: '1048576', ...o.env },
  );
  apps.push(app);
  return { app, f, metadata, log, redis, data };
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (b: Buffer) => parts.push(b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function openPaused(port: number, path: string) {
  return new Promise<{ res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.pause();
      resolve({ res, req });
    });
    req.on('error', () => undefined);
    setTimeout(() => reject(new Error('sin respuesta')), 5000).unref();
  });
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;

describe('GET /api/videos/:videoId/media/:formatId: coste por segmento', () => {
  it('segmentos seguidos: la meta se lee una vez y cada segmento abre googlevideo una sola vez', async () => {
    const { app, f, metadata, log } = await make();
    const port = await listen(app);
    for (const range of ['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2999']) {
      expect((await get(port, MEDIA('136'), { range })).status).toBe(206);
    }
    expect(metadata.get).toHaveBeenCalledTimes(1);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2999']);
    await waitFor(() => log.finished().length === 3);
    // ttfbMs: sobrecarga del servidor hasta las cabeceras
    for (const l of log.finished()) expect(l.ttfbMs).toEqual(expect.any(Number));
  });

  it('sin tamaño en la info, el del índice evita la sonda bytes=0-0 en cada segmento', async () => {
    const mp4 = fakeMp4({ fragments: 6, fragmentSize: 3000 });
    const info = infoWith([videoFormat('134', 360, null), videoFormat('136', 720, null), audioFormat('140', null)]);
    const { app, f } = await make({ data: mp4.data, info });
    const port = await listen(app);
    const pl = await get(port, `/api/videos/${ID}/hls/136.m3u8?sid=${SID}`);
    expect(pl.status).toBe(200);
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-65535']);
    const [offset, size] = mp4.fragments[2] as [number, number];
    const range = `bytes=${offset}-${offset + size - 1}`;
    const r = await get(port, MEDIA('136'), { range });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes ${offset}-${offset + size - 1}/${mp4.data.length}`);
    expect(r.body.equals(mp4.data.subarray(offset, offset + size))).toBe(true);
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-65535', range]);
  });

  it('un error de la meta no se guarda: la siguiente petición vuelve a preguntar', async () => {
    const { app, metadata } = await make({ data: pattern(100) });
    metadata.get.mockRejectedValueOnce(new Error('redis caído'));
    const port = await listen(app);
    expect((await get(port, MEDIA('136'), { range: 'bytes=0-9' })).status).toBe(500);
    expect((await get(port, MEDIA('136'), { range: 'bytes=0-9' })).status).toBe(206);
    expect(metadata.get).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/videos/:videoId/media/:formatId: respuestas', () => {
  it('206 con los bytes exactos, video/mp4, ETag por formato y CORS que expone los rangos', async () => {
    const { app, data, log } = await make();
    const port = await listen(app);
    const r = await get(port, MEDIA('136'), { range: 'bytes=1000-1999', origin: ORIGIN });
    expect(r.status).toBe(206);
    expect(r.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '1000',
      'content-range': `bytes 1000-1999/${data.length}`,
      'accept-ranges': 'bytes',
      etag: `"136-${data.length}"`,
      'cache-control': 'private, max-age=600',
      'content-disposition': 'inline',
      'access-control-allow-origin': ORIGIN,
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    });
    const exposed = String(r.headers['access-control-expose-headers']).toLowerCase().split(/,\s*/);
    expect(exposed).toEqual(expect.arrayContaining(['content-range', 'accept-ranges', 'content-length', 'x-request-id']));
    expect(r.body.equals(data.subarray(1000, 2000))).toBe(true);
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ kind: 'media', formatId: '136', status: 206, start: 1000, bytes: 1000, outcome: 'ok' });
  });

  it('200 sin Range con el archivo entero en tramos de 1 MiB', async () => {
    const { app, f, data } = await make();
    const port = await listen(app);
    const r = await get(port, MEDIA('134'));
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(data.length));
    expect(r.headers['content-range']).toBeUndefined();
    expect(r.body.equals(data)).toBe(true);
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-3145727']);
    expect(f.calls.every((c) => c.url.includes('itag=134'))).toBe(true);
  });

  it('416 fuera de rango con Content-Range */T y no-store', async () => {
    const { app, data } = await make();
    const res = await app.inject({ method: 'GET', url: MEDIA('136'), headers: { range: `bytes=${data.length}-` } });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${data.length}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(errCode(res)).toBe('INVALID_INPUT');
  });

  it('el m4a del grupo de audio también se sirve por /media (audio/mp4)', async () => {
    const { app, data } = await make({ handler: (c) => serve(pattern(3 * MiB), c) });
    const port = await listen(app);
    const r = await get(port, MEDIA('140'), { range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.headers['content-type']).toBe('audio/mp4');
    expect(r.headers.etag).toBe(`"140-${data.length}"`);
  });

  it('If-Range distinto del ETag → 200 completo; igual → 206', async () => {
    const { app, data } = await make({ data: pattern(5000) });
    const port = await listen(app);
    const r = await get(port, MEDIA('136'), { range: 'bytes=100-', 'if-range': '"134-5000"' });
    expect(r.status).toBe(200);
    expect(r.body.equals(data)).toBe(true);
    expect((await get(port, MEDIA('136'), { range: 'bytes=100-', 'if-range': '"136-5000"' })).status).toBe(206);
  });

  it('la duración se mide con MAX_DURATION_AUDIO_SEC (la de la escucha), no con la de las conversiones mp4', async () => {
    const ok = await make({ data: pattern(100), meta: { duration: 1500 } });
    const port = await listen(ok.app);
    expect((await get(port, MEDIA('136'), { range: 'bytes=0-9' })).status).toBe(206);
    const long = await make({ meta: { duration: 3601 } });
    const r = await long.app.inject({ method: 'GET', url: MEDIA('136') });
    expect(r.statusCode).toBe(422);
    expect(errCode(r)).toBe('LIMIT_DURATION');
    const live = await make({ meta: { live: true } });
    const l = await live.app.inject({ method: 'GET', url: MEDIA('136') });
    expect(l.statusCode).toBe(422);
    expect(errCode(l)).toBe('LIVE_NOT_SUPPORTED');
    expect(long.f.calls).toHaveLength(0);
    expect(live.f.calls).toHaveLength(0);
  });
});

describe('GET /api/videos/:videoId/media/:formatId: validación y límites', () => {
  it('formatos fuera de la lista permitida → 404 FORMAT_UNAVAILABLE sin tocar googlevideo', async () => {
    const { app, f, log } = await make({ env: { PREVIEW_VIDEO_MAX_HEIGHT: '720' } });
    // 137 es 1080p (por encima del tope), 251 es opus (no vale en HLS fMP4) y 999 no existe
    for (const id of ['137', '251', '999', '140-drc']) {
      const res = await app.inject({ method: 'GET', url: MEDIA(id) });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe('FORMAT_UNAVAILABLE');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(f.calls).toHaveLength(0);
    expect(log.finished()).toHaveLength(4);
    expect(log.finished().every((l) => l.kind === 'media' && l.code === 'FORMAT_UNAVAILABLE' && l.status === 404)).toBe(true);
    const port = await listen(app);
    expect((await get(port, MEDIA('136'), { range: 'bytes=0-0' })).status).toBe(206);
  });

  it('formatId con forma inválida, parámetros extra, sin sid o sid inválido → 400; HEAD → 404', async () => {
    const { app, f } = await make();
    for (const id of ['13_6', '13.6', 'a'.repeat(25), '%20', '136%2F..']) {
      const res = await app.inject({ method: 'GET', url: MEDIA(id) });
      expect(res.statusCode, id).toBe(400);
      expect(errCode(res)).toBe('INVALID_INPUT');
    }
    for (const q of ['&codec=aac', '&foo=1']) {
      expect((await app.inject({ method: 'GET', url: MEDIA('136') + q })).statusCode, q).toBe(400);
    }
    for (const q of ['', '?sid=xyz', `?sid=${'A'.repeat(32)}`]) {
      const res = await app.inject({ method: 'GET', url: MEDIA_PATH('136') + q, headers: { range: 'bytes=0-9' } });
      expect(res.statusCode, q).toBe(400);
      expect(errCode(res)).toBe('INVALID_INPUT');
    }
    expect((await app.inject({ method: 'GET', url: '/api/videos/corto/media/136' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'HEAD', url: MEDIA('136') })).statusCode).toBe(404);
    expect(f.calls).toHaveLength(0);
  });

  it('PREVIEW_VIDEO_ENABLED=false → 503 y previewVideo false; la escucha sigue funcionando', async () => {
    const { app, metadata, f } = await make({ data: pattern(100), env: { PREVIEW_VIDEO_ENABLED: 'false' } });
    const res = await app.inject({ method: 'GET', url: MEDIA('136') });
    expect(res.statusCode).toBe(503);
    expect(errCode(res)).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(metadata.get).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg).toMatchObject({ preview: true, previewVideo: false });
    const port = await listen(app);
    expect((await get(port, AUDIO, { range: 'bytes=0-9' })).status).toBe(206);
  });

  it('PREVIEW_ENABLED=false también apaga /media', async () => {
    const { app } = await make({ env: { PREVIEW_ENABLED: 'false' } });
    const res = await app.inject({ method: 'GET', url: MEDIA('136') });
    expect(res.statusCode).toBe(503);
    expect(errCode(res)).toBe('SERVICE_UNAVAILABLE');
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ preview: false, previewVideo: false });
  });

  it('Origin o Referer ajeno → 403', async () => {
    const { app } = await make();
    for (const headers of [{ origin: 'https://evil.example' }, { referer: 'https://evil.example/x' }, { origin: 'null' }]) {
      const res = await app.inject({ method: 'GET', url: MEDIA('136'), headers });
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('INVALID_INPUT');
    }
  });

  it('tope por IP: leaseAcquire en 0 → 429 TOO_MANY_PREVIEWS con el sid como miembro', async () => {
    const redis = { ...leaseHandlers(), setubeLeaseAcquire: vi.fn((..._a: unknown[]): unknown => 0) };
    const { app } = await make({ redis });
    const res = await app.inject({ method: 'GET', url: MEDIA('136') });
    expect(res.statusCode).toBe(429);
    expect(errCode(res)).toBe('TOO_MANY_PREVIEWS');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(redis.setubeLeaseAcquire.mock.calls[0]?.[1]).toBe(`s:${SID}`);
  });
});

describe('GET /api/videos/:videoId/media/:formatId: conexiones por reproductor', () => {
  it('seis conexiones del mismo sid conviven; la séptima corta la más antigua (superseded)', async () => {
    const { app, log } = await make({ data: pattern(40 * MiB) });
    const port = await listen(app);
    const opened = [];
    for (let i = 0; i < 6; i++) opened.push(await openPaused(port, MEDIA(i % 2 ? '140' : '136')));
    await new Promise((r) => setTimeout(r, 100));
    expect(log.finished()).toHaveLength(0);
    opened.push(await openPaused(port, MEDIA('134')));
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ kind: 'media', outcome: 'superseded', conns: 1, formatId: '136' });
    for (const o of opened) o.req.destroy();
    await waitFor(() => log.finished().length === 7);
  });

  it('segmentos seguidos del mismo sid: un leaseAcquire y el hueco se suelta al vencer la gracia', async () => {
    const redis = leaseHandlers();
    const { app, log } = await make({ redis, tuning: { mediaLeaseGraceMs: 300 } });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: MEDIA('136'), headers: { range: `bytes=${i * 1000}-${i * 1000 + 999}` } });
      expect(res.statusCode).toBe(206);
    }
    expect(log.finished()).toHaveLength(5);
    expect(redis.setubeLeaseAcquire).toHaveBeenCalledTimes(1);
    expect(redis.setubeLeaseRelease).not.toHaveBeenCalled();
    await waitFor(() => redis.setubeLeaseRelease.mock.calls.length === 1);
    expect(redis.setubeLeaseRelease.mock.calls[0]?.[1]).toBe(`s:${SID}`);
  });

  it('cerrar la app suelta en el acto el hueco en gracia', async () => {
    const redis = leaseHandlers();
    const { app } = await make({ redis });
    expect((await app.inject({ method: 'GET', url: MEDIA('136'), headers: { range: 'bytes=0-999' } })).statusCode).toBe(206);
    expect(redis.setubeLeaseRelease).not.toHaveBeenCalled();
    apps.splice(apps.indexOf(app), 1);
    await app.close();
    expect(redis.setubeLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('/audio y /media del mismo sid comparten el hueco del reproductor (un solo leaseAcquire)', async () => {
    const redis = leaseHandlers();
    const { app, log } = await make({ redis, data: pattern(40 * MiB), tuning: { mediaLeaseGraceMs: 100 } });
    const port = await listen(app);
    const a = await openPaused(port, MEDIA('136'));
    const b = await openPaused(port, `${AUDIO}?sid=${SID}`);
    expect(redis.setubeLeaseAcquire).toHaveBeenCalledTimes(1);
    a.req.destroy();
    b.req.destroy();
    await waitFor(() => log.finished().length === 2);
    expect(log.finished().map((l) => l.kind).sort()).toEqual(['audio', 'media']);
    await waitFor(() => redis.setubeLeaseRelease.mock.calls.length === 1);
  });
});

// El proxy invalida el índice en memoria del formato cuando ve otro archivo (L2 de la revisión de T2)
describe('proxy de medios e índice de segmentos', () => {
  async function mini() {
    const v1 = fakeMp4({ fragments: 6, fragmentSize: 3000 });
    const v2 = fakeMp4({ fragments: 7, fragmentSize: 3000 });
    const soon = nowSec() + 60;
    const state = {
      data: v1.data,
      forbid: false,
      info: infoWith([videoFormat('136', 720, v1.data.length, { url: gvUrl('136').replace(/expire=\d+/, `expire=${soon}`) })]) as Record<string, unknown>,
      refreshed: null as Record<string, unknown> | null,
    };
    const f = fakeFetch((c) => (state.forbid ? status(403) : serve(state.data, c, { contentType: 'video/mp4' })));
    const metadata = {
      get: vi.fn(async () => fakeMeta()),
      readInfoJson: vi.fn(async () => state.info),
      refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: state.refreshed ?? state.info })),
    };
    const redis = leaseHandlers();
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6390', CORS_ORIGINS: ORIGIN });
    const app = await buildApp({
      config,
      deps: { redis: fakeRedis(redis), subscriber: fakeRedis(), logger: false, youtube: { metadata: metadata as unknown as MetadataService } },
    });
    apps.push(app);
    const warn = vi.fn();
    // Sin caché del info JSON: el test cambia la info entre peticiones
    const session: SessionDeps = { fetch: f.fetch, chunkBytes: MiB, metadata, redis: app.redis, warn, retryDelayMs: 0, retryJitterMs: 0 };
    const index = createSegmentIndex({ session, ttlSec: 3600, maxHeight: 1080 });
    await app.register(async (inst) => {
      const leases = createPreviewLeases(inst.redis, { maxPerIp: 4, warn });
      const proxy = createPreviewProxy(inst, { tuning: { retryDelayMs: 0, retryJitterMs: 0 }, leases, session, index });
      inst.get('/t/:videoId/:formatId', async (req, reply) => {
        const p = req.params as { videoId: string; formatId: string };
        await proxy.serve(req, reply, { kind: 'media', videoId: p.videoId, sid: undefined, selector: { formatId: p.formatId, maxHeight: 1080 }, maxConns: 6 });
      });
    });
    await app.ready();
    return { app, state, index, v1, v2, metadata, warn };
  }

  it('mismo tamaño: el índice en memoria se conserva', async () => {
    const m = await mini();
    await m.index.get(ID, '136');
    const res = await m.app.inject({ method: 'GET', url: `/t/${ID}/136`, headers: { range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(206);
    expect(m.index.peek(ID, '136')?.size).toBe(m.v1.data.length);
  });

  it('googlevideo sirve otro tamaño: el proxy olvida el índice en memoria', async () => {
    const m = await mini();
    await m.index.get(ID, '136');
    m.state.data = m.v2.data;
    m.state.info = infoWith([videoFormat('136', 720, m.v2.data.length)]);
    const res = await m.app.inject({ method: 'GET', url: `/t/${ID}/136`, headers: { range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-99/${m.v2.data.length}`);
    expect(m.index.peek(ID, '136')).toBeNull();
    const again = await m.index.get(ID, '136');
    expect(again.size).toBe(m.v2.data.length);
    expect(again.segments).toHaveLength(7);
  });

  it('el formato deja de estar en la lista: 404 FORMAT_UNAVAILABLE y el índice se olvida', async () => {
    const m = await mini();
    await m.index.get(ID, '136');
    m.state.info = infoWith([videoFormat('134', 360, m.v1.data.length)]);
    const res = await m.app.inject({ method: 'GET', url: `/t/${ID}/136` });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe('FORMAT_UNAVAILABLE');
    expect(m.index.peek(ID, '136')).toBeNull();
  });

  it('403 y el formato desaparece al refrescar: UPSTREAM_FORBIDDEN y el índice se olvida', async () => {
    const m = await mini();
    await m.index.get(ID, '136');
    m.state.forbid = true;
    m.state.refreshed = infoWith([videoFormat('134', 360, m.v1.data.length)]);
    const res = await m.app.inject({ method: 'GET', url: `/t/${ID}/136`, headers: { range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(502);
    expect(errCode(res)).toBe('UPSTREAM_FORBIDDEN');
    expect(m.metadata.refresh).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith('preview_format_gone', expect.objectContaining({ formatId: '136' }));
    expect(m.index.peek(ID, '136')).toBeNull();
  });
});
