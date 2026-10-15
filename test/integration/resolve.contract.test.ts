import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { countKeys, createTestRedis, type TestRedis } from './helpers/redis.js';

const OK = 'jNQXAC9IVRw';
const GONE = 'aaaaaaaaaa1';
const EMBED_OFF = 'bbbbbbbbbb2';
const SLOW = 'cccccccccc3';
const PLAYLIST = 'PLtestPlaylist01';

let calls = 0;

const fakeFetch: typeof fetch = async (input, init) => {
  calls++;
  const target = new URL(String(input)).searchParams.get('url') ?? '';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (target.includes(`list=${PLAYLIST}`)) return json(200, { title: 'Mi playlist', author_name: 'Autor PL' });
  const v = new URL(target).searchParams.get('v');
  if (v === GONE) return json(404, {});
  if (v === EMBED_OFF) return json(401, {});
  if (v === SLOW) {
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  return json(200, { title: `Título ${v}`, author_name: 'Canal' });
};

let t: TestRedis;
let app: FastifyInstance;

beforeAll(async () => {
  t = await createTestRedis();
  ({ app } = await buildTestApp(t, { deps: { fetch: fakeFetch } }));
});

afterAll(async () => {
  await app?.close();
  await t?.cleanup();
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/resolve', payload: payload as string, headers: { 'content-type': 'application/json', ...headers } });

function expectErrorShape(res: Awaited<ReturnType<typeof post>>, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const body = res.json() as { error: { code: string; message: string }; requestId: string };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.requestId).toBe(res.headers['x-request-id']);
  expect(Object.keys(body).sort()).toEqual(['error', 'requestId']);
}

describe('POST /api/resolve', () => {
  it('6 entradas mezcladas → mismo orden, ids de eco y estados correctos', { timeout: 15_000 }, async () => {
    const items = [
      { id: 'a', url: `https://youtu.be/${OK}` },
      { id: 'b', url: 'https://evil.com/watch?v=jNQXAC9IVRw' },
      { id: 'c', url: `https://www.youtube.com/watch?v=${GONE}` },
      { id: 'd', url: `https://www.youtube.com/watch?v=${EMBED_OFF}` },
      { id: 'e', url: `https://www.youtube.com/watch?v=${SLOW}` },
      { id: 'f', url: `https://www.youtube.com/playlist?list=${PLAYLIST}` },
    ];
    const res = await post({ items });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: Record<string, unknown>[] };
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(results.map((r) => r.url)).toEqual(items.map((i) => i.url));

    expect(results[0]).toMatchObject({
      kind: 'video', videoId: OK, status: 'ok', title: `Título ${OK}`, author: 'Canal',
      thumbnail: `https://i.ytimg.com/vi/${OK}/mqdefault.jpg`,
    });
    expect(results[1]).toMatchObject({ kind: null, status: 'error', title: null, thumbnail: null, error: { code: 'INVALID_URL' } });
    expect(results[2]).toMatchObject({ kind: 'video', videoId: GONE, status: 'error', error: { code: 'VIDEO_UNAVAILABLE' } });
    expect(results[3]).toMatchObject({ kind: 'video', videoId: EMBED_OFF, status: 'ok', title: null, author: null });
    expect(results[4]).toMatchObject({ kind: 'video', videoId: SLOW, status: 'ok', title: null });
    expect(results[5]).toMatchObject({ kind: 'playlist', playlistId: PLAYLIST, status: 'ok', title: 'Mi playlist', thumbnail: null });
  });

  it('la segunda llamada con entradas cacheables NO invoca fakeFetch (caché positiva y negativa)', async () => {
    const before = calls;
    const res = await post({
      items: [
        { id: 'x1', url: `https://www.youtube.com/watch?v=${OK}` },
        { id: 'x2', url: `https://youtu.be/${GONE}` },
        { id: 'x3', url: `https://www.youtube.com/playlist?list=${PLAYLIST}` },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(before);
    const { results } = res.json() as { results: Record<string, unknown>[] };
    expect(results[0]).toMatchObject({ title: `Título ${OK}`, status: 'ok' });
    expect(results[1]).toMatchObject({ status: 'error', error: { code: 'VIDEO_UNAVAILABLE' } });
    expect(results[2]).toMatchObject({ title: 'Mi playlist' });
  });

  it('watch?v=X&list=Y → kind video con ambos ids', async () => {
    const res = await post({ items: [{ id: 'w', url: `https://www.youtube.com/watch?v=${OK}&list=${PLAYLIST}` }] });
    expect(res.json()).toMatchObject({ results: [{ kind: 'video', videoId: OK, playlistId: PLAYLIST }] });
  });

  it('51 entradas → 400 INVALID_INPUT', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `i${i}`, url: `https://youtu.be/${OK}` }));
    expectErrorShape(await post({ items }), 400, 'INVALID_INPUT');
  });

  it('propiedades extra o id inválido → 400 INVALID_INPUT', async () => {
    expectErrorShape(await post({ items: [{ id: 'a', url: 'x' }], extra: 1 }), 400, 'INVALID_INPUT');
    expectErrorShape(await post({ items: [{ id: 'a b', url: 'x' }] }), 400, 'INVALID_INPUT');
    expectErrorShape(await post({ items: [] }), 400, 'INVALID_INPUT');
  });

  it('JSON inválido o vacío → 400 INVALID_INPUT', async () => {
    expectErrorShape(await post('{no json'), 400, 'INVALID_INPUT');
    expectErrorShape(await post(''), 400, 'INVALID_INPUT');
  });

  it('50 URLs válidas de 2048 caracteres → 200 con 50 resultados (≈105 KB < 131072)', async () => {
    const items = Array.from({ length: 50 }, (_, i) => {
      const id = `pad${String(i).padStart(8, '0')}`;
      const head = `https://www.youtube.com/watch?v=${id}&pad=`;
      return { id: `id${i}`, url: head + 'x'.repeat(2048 - head.length) };
    });
    expect(items.every((it) => it.url.length === 2048)).toBe(true);
    const payload = JSON.stringify({ items });
    expect(payload.length).toBeGreaterThan(100_000);
    expect(payload.length).toBeLessThan(131072);
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: { id: string; status: string; videoId: string }[] };
    expect(results).toHaveLength(50);
    expect(results.map((r) => r.id)).toEqual(items.map((i) => i.id));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('cuerpo > 131072 bytes → 413 INVALID_INPUT', async () => {
    const payload = JSON.stringify({ items: [{ id: 'a', url: 'x'.repeat(140_000) }] });
    expectErrorShape(await post(payload), 413, 'INVALID_INPUT');
  });

  it('Content-Type text/plain → 415 INVALID_INPUT', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/resolve', payload: 'hola', headers: { 'content-type': 'text/plain' } });
    expectErrorShape(res, 415, 'INVALID_INPUT');
  });

  it('Content-Type application/x-www-form-urlencoded → 415 INVALID_INPUT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: 'items=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expectErrorShape(res, 415, 'INVALID_INPUT');
  });

  it('en otra ruta JSON (POST /api/jobs), un cuerpo de 70 KB → 413 (el global de 64 KB sigue vigente)', async () => {
    const payload = JSON.stringify({ items: [{ videoId: 'x'.repeat(70_000) }], format: 'mp3' });
    expect(payload.length).toBeGreaterThan(65536);
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload, headers: { 'content-type': 'application/json' } });
    expectErrorShape(res, 413, 'INVALID_INPUT');
  });
});

describe('rutas base', () => {
  it('GET /health → 200 con Redis', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', redis: 'ok' });
  });

  it('GET /api/config → límites y Cache-Control', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json()).toMatchObject({
      maxItemsPerJob: 50,
      formats: { mp3: [128, 192, 320], m4a: [], wav: [], mp4: [360, 480, 720, 1080, 'best'] },
      defaults: { mp3: 192, mp4: 720 },
      turnstile: false,
      preview: true,
    });
  });

  it('ruta inexistente → 404 con la forma única de error', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('GET /api/videos/:videoId inválido → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/videos/corto' });
    expectErrorShape(res as Awaited<ReturnType<typeof post>>, 400, 'INVALID_INPUT');
  });

  it('POST /api/playlists/resolve con URL que no es playlist → 400 INVALID_URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playlists/resolve',
      payload: { url: `https://youtu.be/${OK}` },
    });
    expectErrorShape(res as Awaited<ReturnType<typeof post>>, 400, 'INVALID_URL');
  });

  it('el rate limit guarda sus claves bajo el prefijo de test (rl:)', async () => {
    expect(await countKeys(t, 'rl:*')).toBeGreaterThan(0);
  });
});
