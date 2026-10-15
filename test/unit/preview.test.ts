import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { buildFakeApp, ORIGIN } from './helpers/fake-app.js';
import { audioFormat, fakeFetch, fakeMeta, gvUrl, infoWith, pattern, serve, status, type Call } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const URL_ = `/api/videos/${ID}/audio`;
const MiB = 1024 * 1024;
const SID = 'a'.repeat(32);

type Line = Record<string, unknown> & { msg: string };

function memLog() {
  const lines: Line[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) {
        raw.push(l);
        lines.push(JSON.parse(l) as Line);
      }
      cb();
    },
  });
  return { lines, raw, stream, finished: () => lines.filter((l) => l.msg === 'preview_finished') };
}

interface Opts {
  data?: Buffer;
  handler?: (c: Call, n: number) => Response | Promise<Response>;
  info?: Record<string, unknown> | null;
  refreshed?: Record<string, unknown>;
  meta?: Partial<ReturnType<typeof fakeMeta>>;
  metaGet?: () => Promise<unknown>;
  redis?: Record<string, (...a: unknown[]) => unknown>;
  env?: Record<string, string>;
  tuning?: AppDeps['preview'];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function leaseHandlers() {
  return {
    setubeLeaseAcquire: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRenew: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRelease: vi.fn((..._a: unknown[]): unknown => 1),
    get: vi.fn(() => null),
    set: vi.fn(() => 'OK'),
  };
}

async function make(o: Opts = {}) {
  const data = o.data ?? pattern(3 * MiB);
  const f = fakeFetch(o.handler ?? ((c) => serve(data, c)));
  const info = o.info === undefined ? infoWith([audioFormat('140', data.length), audioFormat('251', data.length)]) : o.info;
  const metadata = {
    get: vi.fn(o.metaGet ?? (async () => fakeMeta(o.meta))),
    readInfoJson: vi.fn(async () => info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: o.refreshed ?? info })),
  };
  const log = memLog();
  const redis = o.redis ?? leaseHandlers();
  const app = await buildFakeApp(
    redis,
    {
      fetch: f.fetch,
      youtube: { metadata: metadata as unknown as MetadataService },
      logger: { stream: log.stream },
      preview: { watchdogMs: 50, idleTimeoutMs: 300, upstreamIdleMs: 200, renewMs: 50, retryDelayMs: 0, retryJitterMs: 0, ...o.tuning },
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

// Abre la respuesta y la deja pausada (cliente que no lee)
function openPaused(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
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

describe('GET /api/videos/:videoId/audio: respuestas', () => {
  it('206 con Range, cabeceras completas y CORS para el origen permitido', async () => {
    const { app, data } = await make();
    const port = await listen(app);
    const r = await get(port, URL_, { range: 'bytes=0-1023', origin: ORIGIN });
    expect(r.status).toBe(206);
    expect(r.headers).toMatchObject({
      'content-type': 'audio/mp4',
      'content-length': '1024',
      'content-range': `bytes 0-1023/${data.length}`,
      'accept-ranges': 'bytes',
      etag: `"140-${data.length}"`,
      'cache-control': 'private, max-age=600',
      'content-disposition': 'inline',
      'access-control-allow-origin': ORIGIN,
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    });
    expect(r.body.equals(data.subarray(0, 1024))).toBe(true);
  });

  it('200 sin Range: 3 MiB en 3 tramos de 1 MiB y bytes idénticos', async () => {
    const { app, f, data, log } = await make();
    const port = await listen(app);
    const r = await get(port, URL_);
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(data.length));
    expect(r.headers['content-range']).toBeUndefined();
    expect(r.body.equals(data)).toBe(true);
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-3145727']);
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'ok', status: 200, bytes: data.length, formatId: '140' });
  });

  it('bytes=0-0 → 206 audio/mp4; ?codec=opus → audio/webm', async () => {
    const { app } = await make();
    const port = await listen(app);
    const r = await get(port, URL_, { range: 'bytes=0-0' });
    expect(r.status).toBe(206);
    expect(r.headers['content-type']).toBe('audio/mp4');
    expect(r.body).toHaveLength(1);
    const o = await get(port, `${URL_}?codec=opus`, { range: 'bytes=0-0' });
    expect(o.headers['content-type']).toBe('audio/webm');
    expect(o.headers.etag).toMatch(/^"251-/);
  });

  it('416 con Content-Range */T y no-store', async () => {
    const { app, data } = await make();
    const res = await app.inject({ method: 'GET', url: URL_, headers: { range: `bytes=${data.length}-` } });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${data.length}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' }, requestId: expect.any(String) });
  });

  it('If-Range distinto del ETag → 200 completo', async () => {
    const { app, data } = await make({ data: pattern(5000) });
    const port = await listen(app);
    const r = await get(port, URL_, { range: 'bytes=100-', 'if-range': '"otro-1"' });
    expect(r.status).toBe(200);
    expect(r.body.equals(data)).toBe(true);
    const ok = await get(port, URL_, { range: 'bytes=100-', 'if-range': `"140-${data.length}"` });
    expect(ok.status).toBe(206);
  });

  it('403 de upstream → refresh y reintento transparente', async () => {
    const data = pattern(5000);
    const soon = infoWith([audioFormat('140', 5000, { url: gvUrl('140').replace(/expire=\d+/, `expire=${Math.floor(Date.now() / 1000) + 60}`) })]);
    const fresh = infoWith([audioFormat('140', 5000, { url: gvUrl('140', '&fresh=1') })]);
    const { app, metadata, log } = await make({
      data,
      info: soon,
      refreshed: fresh,
      handler: (c) => (c.url.includes('fresh=1') ? serve(data, c) : status(403)),
    });
    const port = await listen(app);
    const r = await get(port, URL_, { range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.body.equals(data.subarray(0, 100))).toBe(true);
    expect(metadata.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ retry403: 'refresh', refreshed: true, outcome: 'ok' });
  });

  it('upstream colgado → el vigilante corta el tramo y se reanuda', async () => {
    const data = pattern(5000);
    const handler = (c: Call, n: number) => {
      if (n > 1) return serve(data, c);
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (sent) return new Promise<void>(() => undefined);
          sent = true;
          ctrl.enqueue(new Uint8Array(data.subarray(0, 100)));
        },
      });
      return new Response(body, { status: 206, headers: { 'content-range': `bytes 0-4999/5000` } });
    };
    const { app, f, log } = await make({ data, handler });
    const port = await listen(app);
    const r = await get(port, URL_);
    expect(r.body.equals(data)).toBe(true);
    expect(f.calls[1]?.range).toBe('bytes=100-4999');
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'ok', resumes: 1 });
  });
});

describe('GET /api/videos/:videoId/audio: validación y límites', () => {
  it('directo → 422 LIVE_NOT_SUPPORTED; duración > MAX_DURATION_AUDIO_SEC → 422 LIMIT_DURATION', async () => {
    const live = await make({ meta: { live: true } });
    const r1 = await live.app.inject({ method: 'GET', url: URL_ });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.code).toBe('LIVE_NOT_SUPPORTED');
    const long = await make({ meta: { duration: 3601 } });
    const r2 = await long.app.inject({ method: 'GET', url: URL_ });
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error.code).toBe('LIMIT_DURATION');
    expect(r2.headers['cache-control']).toBe('no-store');
    expect(long.f.calls).toHaveLength(0);
  });

  it('PREVIEW_ENABLED=false → 503 SERVICE_UNAVAILABLE sin tocar metadata ni upstream', async () => {
    const { app, metadata, f } = await make({ env: { PREVIEW_ENABLED: 'false' } });
    const res = await app.inject({ method: 'GET', url: URL_ });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(metadata.get).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    const cfg = await app.inject({ method: 'GET', url: '/api/config' });
    expect(cfg.json().preview).toBe(false);
  });

  it('Origin o Referer ajeno/no parseable → 403; sin ninguno pasa', async () => {
    const { app } = await make({ data: pattern(100) });
    for (const headers of [{ origin: 'https://evil.example' }, { referer: 'no es una url' }, { referer: 'https://evil.example/x' }, { origin: 'null' }]) {
      const res = await app.inject({ method: 'GET', url: URL_, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVALID_INPUT');
    }
    const port = await listen(app);
    expect((await get(port, URL_, { range: 'bytes=0-9' })).status).toBe(206);
    expect((await get(port, URL_, { range: 'bytes=0-9', referer: `${ORIGIN}/` })).status).toBe(206);
  });

  it('sid inválido, parámetro extra o codec desconocido → 400; HEAD → 404', async () => {
    const { app } = await make();
    for (const q of ['?sid=xyz', '?foo=1', '?codec=mp3', `?sid=${'A'.repeat(32)}`]) {
      const res = await app.inject({ method: 'GET', url: URL_ + q });
      expect(res.statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/videos/corto/audio' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'HEAD', url: URL_ })).statusCode).toBe(404);
  });

  it('tope por IP: leaseAcquire en 0 → 429 TOO_MANY_PREVIEWS', async () => {
    const redis = { ...leaseHandlers(), setubeLeaseAcquire: vi.fn((..._a: unknown[]): unknown => 0) };
    const { app, log } = await make({ redis });
    const res = await app.inject({ method: 'GET', url: `${URL_}?sid=${SID}` });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('TOO_MANY_PREVIEWS');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(redis.setubeLeaseAcquire.mock.calls[0]?.[1]).toBe(`s:${SID}`);
    expect(log.finished()).toHaveLength(1);
  });

  it('Redis caído al adquirir el lease deja pasar', async () => {
    const { app } = await make({ redis: {}, data: pattern(100) });
    const port = await listen(app);
    expect((await get(port, URL_, { range: 'bytes=0-9' })).status).toBe(206);
  });

  it('plazo vencido con metadata colgada → 504 JSON; mientras tanto la instancia llena da 503 no-store', async () => {
    const { app } = await make({
      metaGet: () => new Promise(() => undefined),
      tuning: { deadlineMs: 300 },
      env: { PREVIEW_MAX_STREAMS_PER_INSTANCE: '1' },
    });
    const first = app.inject({ method: 'GET', url: URL_ });
    await new Promise((r) => setTimeout(r, 50));
    const busy = await app.inject({ method: 'GET', url: URL_ });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe('INSTANCE_BUSY');
    expect(busy.headers['cache-control']).toBe('no-store');
    const r = await first;
    expect(r.statusCode).toBe(504);
    expect(r.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('tras N errores LIMIT_DURATION: N liberaciones, N líneas preview_finished y la instancia queda libre', async () => {
    const redis = leaseHandlers();
    const { app, log } = await make({ redis, meta: { duration: 99999 }, env: { PREVIEW_MAX_STREAMS_PER_INSTANCE: '1' } });
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'GET', url: URL_ });
      expect(res.statusCode).toBe(422);
    }
    await waitFor(() => redis.setubeLeaseRelease.mock.calls.length === 4);
    expect(log.finished()).toHaveLength(4);
    expect(log.finished().every((l) => l.outcome === 'error' && l.code === 'LIMIT_DURATION')).toBe(true);
  });
});

describe('GET /api/videos/:videoId/audio: cancelación y outcome', () => {
  it('el cliente corta a mitad → upstream abortado y outcome client_closed', async () => {
    const { app, f, log } = await make({ data: pattern(8 * MiB) });
    const port = await listen(app);
    await new Promise<void>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: URL_, agent: false }, (res) => {
        let n = 0;
        res.on('data', (b: Buffer) => {
          n += b.length;
          if (n > 64 * 1024) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', () => undefined);
    });
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'client_closed' });
    expect(f.calls.every((c) => c.signal?.aborted)).toBe(true);
  });

  it('cierre durante la adquisición del lease: se libera, sin renovaciones y sin bloquear la instancia', async () => {
    let resolveAcquire: (v: number) => void = () => undefined;
    const redis = {
      ...leaseHandlers(),
      setubeLeaseAcquire: vi.fn(() => new Promise<number>((r) => (resolveAcquire = r))),
    };
    const { app, log } = await make({ redis, data: pattern(100), env: { PREVIEW_MAX_STREAMS_PER_INSTANCE: '1' } });
    const port = await listen(app);
    const req = http.get({ host: '127.0.0.1', port, path: `${URL_}?sid=${SID}`, agent: false });
    req.on('error', () => undefined);
    await waitFor(() => redis.setubeLeaseAcquire.mock.calls.length === 1);
    req.destroy();
    await waitFor(() => log.finished().length === 1);
    resolveAcquire(1);
    await waitFor(() => redis.setubeLeaseRelease.mock.calls.length === 1);
    expect(redis.setubeLeaseRelease.mock.calls[0]?.[1]).toBe(`s:${SID}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(redis.setubeLeaseRenew).not.toHaveBeenCalled();
    expect(log.finished()).toHaveLength(1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'client_closed' });
    redis.setubeLeaseAcquire.mockImplementation(() => Promise.resolve(1));
    const next = await get(port, URL_, { range: 'bytes=0-9' });
    expect(next.status).toBe(206);
  });

  it('el 3.er tramo da 403 sin escalones → outcome error con UPSTREAM_FORBIDDEN', async () => {
    const data = pattern(3 * MiB);
    const { app, log } = await make({
      data,
      handler: (c, n) => (n >= 3 ? status(403) : serve(data, c)),
      refreshed: infoWith([audioFormat('251', data.length)]),
    });
    const port = await listen(app);
    const r = await get(port, URL_).catch(() => null);
    expect(r === null || r.body.length < data.length).toBe(true);
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'error', code: 'UPSTREAM_FORBIDDEN' });
  });

  it('cliente que no lee → idle', async () => {
    const { app, log } = await make({ data: pattern(40 * MiB) });
    const port = await listen(app);
    const { req } = await openPaused(port, URL_);
    await waitFor(() => log.finished().length === 1, 8000);
    expect(log.finished()[0]).toMatchObject({ outcome: 'idle' });
    req.destroy();
  });

  it('cuatro conexiones del mismo sid → la más antigua termina como superseded', async () => {
    const { app, log } = await make({ data: pattern(40 * MiB), tuning: { idleTimeoutMs: 60_000 } });
    const port = await listen(app);
    const opened = [];
    for (let i = 0; i < 4; i++) opened.push(await openPaused(port, `${URL_}?sid=${SID}`));
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'superseded', conns: 1 });
    for (const o of opened) o.req.destroy();
    await waitFor(() => log.finished().length === 4);
  });

  it('app.close() en mitad de un stream → shutdown', async () => {
    const { app, log } = await make({ data: pattern(40 * MiB), tuning: { idleTimeoutMs: 60_000 } });
    const port = await listen(app);
    const { req } = await openPaused(port, URL_);
    await app.close();
    await waitFor(() => log.finished().length === 1);
    expect(log.finished()[0]).toMatchObject({ outcome: 'shutdown' });
    req.destroy();
  });

  it('errores de red con el host firmado no llegan a los logs, ni el sid en claro', async () => {
    const boom = () => {
      throw new TypeError('fetch failed', { cause: new Error('connect rr1---sn-x.googlevideo.com:443') });
    };
    const before = await make({ handler: boom });
    const r1 = await before.app.inject({ method: 'GET', url: `${URL_}?sid=${SID}` });
    expect(r1.statusCode).toBe(502);
    expect(r1.json().error.code).toBe('UPSTREAM_ERROR');
    expect(before.log.finished()).toHaveLength(1);

    const data = pattern(3 * MiB);
    const after = await make({ data, handler: (c, n) => (n === 1 ? serve(data, c) : boom()) });
    const port = await listen(after.app);
    await get(port, `${URL_}?sid=${SID}`).catch(() => null);
    await waitFor(() => after.log.finished().length === 1);
    expect(after.log.finished()[0]).toMatchObject({ outcome: 'error', code: 'UPSTREAM_ERROR' });

    for (const l of [...before.log.raw, ...after.log.raw]) {
      expect(l).not.toContain('googlevideo');
      expect(l).not.toContain(SID);
    }
  });
});
