import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipsKey, jobKey, lockKey, SEM_KEYS } from '../../src/lib/jobs/lua.js';
import { computeOverall, createJob, readJob, rejectJob, updateItem, type ItemState } from '../../src/lib/jobs/store.js';
import { SETUBE_TMP } from '../../src/lib/media/proc.js';
import { ipHash } from '../../src/lib/ip.js';
import { buildTestApp } from './helpers/app.js';
import { countKeys, createTestRedis, type TestRedis } from './helpers/redis.js';

const FAKE_YTDLP = fileURLToPath(new URL('../fixtures/fake-ytdlp.mjs', import.meta.url));
const FAKE_FFMPEG = fileURLToPath(new URL('../fixtures/fake-ffmpeg.mjs', import.meta.url));

let t: TestRedis;
let dir: string;
let app: FastifyInstance;
let base: string;

const env = () => ({
  YTDLP_PATH: process.execPath,
  YTDLP_ARGS_PREFIX: JSON.stringify([FAKE_YTDLP, '--scenario', dir]),
  FFMPEG_PATH: process.execPath,
  FFMPEG_ARGS_PREFIX: JSON.stringify([FAKE_FFMPEG, '--scenario', dir]),
  SSE_HEARTBEAT_MS: '200',
  SSE_MAX_PER_JOB: '2',
});

beforeAll(async () => {
  t = await createTestRedis();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setube-fake-'));
  await fs.mkdir(SETUBE_TMP, { recursive: true, mode: 0o700 });
  ({ app } = await buildTestApp(t, { env: env() }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
  await t?.cleanup();
  await fs.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vid = () => randomUUID().replace(/-/g, '').slice(0, 11);
const scenario = (videoId: string, sc: unknown) => fs.writeFile(path.join(dir, `${videoId}.json`), JSON.stringify(sc));
const ytdlpLog = async () => {
  try {
    return (await fs.readFile(path.join(dir, 'ytdlp.log'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; videoId: string });
  } catch {
    return [];
  }
};

async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 8000): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('waitFor: tiempo agotado');
    await sleep(20);
  }
}

interface Ev {
  id?: string;
  event?: string;
  data?: unknown;
}

interface SseClient {
  status: number;
  body: string;
  events: Ev[];
  raw: string;
  closed: Promise<void>;
  isClosed: () => boolean;
  close: () => void;
}

function sse(urlPath: string, headers: Record<string, string> = {}, baseUrl = base): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${urlPath}`, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      const c: SseClient = {
        status: res.statusCode ?? 0, body: '', events: [], raw: '',
        closed: new Promise((r) => res.on('close', () => r())),
        isClosed: () => res.destroyed || res.complete,
        close: () => req.destroy(),
      };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        c.raw += chunk;
        if (c.status !== 200) {
          c.body += chunk;
          return;
        }
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: Ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.event) c.events.push(ev);
        }
      });
      res.on('error', () => undefined);
      if (c.status !== 200) res.on('end', () => resolve(c));
      else resolve(c);
    });
    req.on('error', reject);
  });
}

const events = (c: SseClient, name: string) => c.events.filter((e) => e.event === name);
const itemData = (e: Ev) => (e.data as { item: Record<string, unknown>; overall: Record<string, unknown> }).item;

async function postJob(videoIds: string[], format = 'mp3') {
  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { items: videoIds.map((videoId) => ({ videoId })), format } });
  return res;
}

async function rawJob(items: { videoId: string; validationError?: 'LIMIT_DURATION' }[], format: 'mp3' | 'mp4' = 'mp3') {
  const jobId = randomUUID();
  const r = await createJob(t.redis, {
    jobId, format, quality: format === 'mp3' ? 192 : 720, ipHash: 'h', ttlSec: 600,
    items: items.map((i) => ({ videoId: i.videoId, title: null, duration: null, durationVerified: false, validationError: i.validationError })),
  });
  return { jobId, items: r.items };
}

const snapshot = async (jobId: string) => (await readJob(t.redis, jobId, { slotLeaseMs: 30_000 }))!.snapshot;

describe('POST/GET/DELETE /api/jobs', () => {
  it('201 con itemIds en orden, pending verificados y validación previa (LIMIT_DURATION validation)', async () => {
    const ok = vid();
    const long = vid();
    await scenario(long, { duration: 7200 });
    const res = await postJob([ok, long, ok]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { jobId: string; quality: number; items: Record<string, unknown>[] };
    expect(body.quality).toBe(192);
    expect(body.items.map((i) => i.itemId)).toEqual(['i0', 'i1', 'i2']);
    expect(body.items[0]).toMatchObject({ status: 'pending', duration: 20, title: `Título ${ok}` });
    expect(body.items[1]).toMatchObject({ status: 'error', errorKind: 'validation', error: { code: 'LIMIT_DURATION' } });
    const g = await app.inject({ method: 'GET', url: `/api/jobs/${body.jobId}` });
    expect(g.statusCode).toBe(200);
    expect(g.headers['cache-control']).toBe('no-store');
    expect(g.json()).toMatchObject({ jobId: body.jobId, status: 'active', seq: 0, lastReject: null, items: [{ durationVerified: true }, {}, {}] });
  });

  it('todos en error → 422 NO_VALID_ITEMS y el job no se crea', async () => {
    const long = vid();
    await scenario(long, { duration: 7200 });
    const res = await postJob([long]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'NO_VALID_ITEMS', details: [{ itemId: 'i0', error: { code: 'LIMIT_DURATION' } }] } });
  });

  it('GET de un job inexistente → 404 JOB_NOT_FOUND; DELETE idempotente 202 / 404', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${randomUUID()}` })).json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
    const { jobId } = await rawJob([{ videoId: vid() }]);
    for (let i = 0; i < 2; i++) {
      const d = await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}` });
      expect(d.statusCode).toBe(202);
      expect(d.json()).toEqual({ jobId, status: 'canceled' });
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${randomUUID()}` })).statusCode).toBe(404);
  });
});

describe('SSE /api/jobs/:id/events', () => {
  it('snapshot primero, sin duplicados ni pérdidas (id ≤ S descartados) aun con eventos concurrentes a la conexión', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    for (let i = 0; i < 3; i++) await rejectJob(t.redis, jobId, { code: 'JOB_BUSY' }, 600);
    const storm = Promise.all(Array.from({ length: 30 }, () => rejectJob(t.redis, jobId, { code: 'JOB_BUSY' }, 600)));
    const c = await sse(`/api/jobs/${jobId}/events`);
    await storm;
    for (let i = 0; i < 3; i++) await rejectJob(t.redis, jobId, { code: 'JOB_BUSY' }, 600);
    expect(c.status).toBe(200);
    await waitFor(() => c.events.length > 0 && Number(c.events.at(-1)!.id) === 36);
    expect(c.events[0]!.event).toBe('snapshot');
    const S = Number(c.events[0]!.id);
    expect((c.events[0]!.data as { seq: number }).seq).toBe(S);
    const after = c.events.slice(1).map((e) => Number(e.id));
    expect(after.every((id) => id > S)).toBe(true);
    expect(new Set(after).size).toBe(after.length);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    expect(after).toEqual(Array.from({ length: 36 - S }, (_, i) => S + 1 + i));
    expect(c.raw.startsWith('retry: 3000\n\n')).toBe(true);
    c.close();
  });

  it('reconexión con Last-Event-ID → snapshot completo primero; heartbeat ": ping"', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    await rejectJob(t.redis, jobId, { code: 'JOB_BUSY' }, 600);
    const c = await sse(`/api/jobs/${jobId}/events`, { 'last-event-id': '1' });
    await waitFor(() => c.events.length >= 1 && c.raw.includes(': ping\n\n'));
    expect(c.events[0]).toMatchObject({ event: 'snapshot', id: '1' });
    expect(c.events[0]!.data).toMatchObject({ jobId, lastReject: { code: 'JOB_BUSY' } });
    c.close();
  });

  it('TOO_MANY_SUBSCRIBERS con SSE_MAX_PER_JOB=2; al cerrar se libera el lease', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    const a = await sse(`/api/jobs/${jobId}/events`);
    const b = await sse(`/api/jobs/${jobId}/events`);
    const c = await sse(`/api/jobs/${jobId}/events`);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(c.status).toBe(429);
    expect(JSON.parse(c.body)).toMatchObject({ error: { code: 'TOO_MANY_SUBSCRIBERS' } });
    a.close();
    await waitFor(async () => (await t.redis.zcard(`job:${jobId}:subs`)) === 1);
    const d = await sse(`/api/jobs/${jobId}/events`);
    expect(d.status).toBe(200);
    b.close();
    d.close();
  });

  it('aislamiento: el cliente del job A no recibe eventos del job B', async () => {
    const A = await rawJob([{ videoId: vid() }]);
    const B = await rawJob([{ videoId: vid() }]);
    const c = await sse(`/api/jobs/${A.jobId}/events`);
    await waitFor(() => c.events.length === 1);
    await rejectJob(t.redis, B.jobId, { code: 'JOB_BUSY' }, 600);
    await rejectJob(t.redis, A.jobId, { code: 'QUEUE_FULL' }, 600);
    await waitFor(() => c.events.length === 2);
    await sleep(100);
    expect(c.events.map((e) => e.event)).toEqual(['snapshot', 'rejected']);
    expect(c.events[1]!.data).toMatchObject({ code: 'QUEUE_FULL' });
    c.close();
  });

  it('job borrado (TTL) → el heartbeat escribe expired (sin id:) y cierra; reconectar → 404', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    const c = await sse(`/api/jobs/${jobId}/events`);
    await waitFor(() => c.events.length === 1);
    await t.redis.del(jobKey(jobId));
    await c.closed;
    expect(c.events.at(-1)).toEqual({ event: 'expired', data: {} });
    expect(c.raw).toMatch(/\n\nevent: expired\ndata: \{\}\n\n$/);
    const again = await sse(`/api/jobs/${jobId}/events`);
    expect(again.status).toBe(404);
    expect(JSON.parse(again.body)).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
  });
});

describe('GET /file y /archive', () => {
  it('errorKind runtime (UPSTREAM_TIMEOUT) → 200 binario, attempt 2, eventos con id: y data.overall', async () => {
    const v = vid();
    const { jobId, items } = await rawJob([{ videoId: v }]);
    const it0 = items[0] as ItemState;
    await updateItem(t.redis, jobId, { ...it0, status: 'error', attempt: 1, error: { code: 'UPSTREAM_TIMEOUT', message: 'x' }, errorKind: 'runtime' }, 'error', computeOverall(items, false), 600);
    const c = await sse(`/api/jobs/${jobId}/events`);
    await waitFor(() => c.events.length === 1);
    const res = await fetch(`${base}/api/jobs/${jobId}/items/i0/file`, { headers: { origin: 'http://localhost:3000' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Titulo ${v}.mp3"; filename*=UTF-8''T%C3%ADtulo%20${v}.mp3`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('accept-ranges')).toBe('none');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors http://localhost:3000');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect((await res.arrayBuffer()).byteLength).toBe(200000);
    await waitFor(() => events(c, 'done').length === 1);
    const itemEvents = c.events.filter((e) => e.event !== 'snapshot');
    expect(itemData(itemEvents[0]!)).toMatchObject({ itemId: 'i0', status: 'fetching', attempt: 2, pct: 0 });
    for (const e of itemEvents) {
      expect(Number(e.id)).toBeGreaterThan(0);
      expect((e.data as { overall: unknown }).overall).toMatchObject({ total: 1 });
    }
    expect(itemData(events(c, 'done')[0]!)).toMatchObject({ pct: 100, attempt: 2 });
    expect(c.raw).toMatch(/id: \d+\nevent: done\n/);
    c.close();
    expect(await t.redis.exists(lockKey(jobId))).toBe(0);
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
  });

  it('JOB_BUSY en /file llega como rejected al SSE del job', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    await t.redis.set(lockKey(jobId), 'otro-stream', 'PX', 10_000);
    const c = await sse(`/api/jobs/${jobId}/events`);
    await waitFor(() => c.events.length === 1);
    const res = await fetch(`${base}/api/jobs/${jobId}/items/i0/file`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'JOB_BUSY' } });
    await waitFor(() => events(c, 'rejected').length === 1);
    expect(events(c, 'rejected')[0]!.data).toMatchObject({ code: 'JOB_BUSY', itemId: 'i0', message: expect.any(String), at: expect.any(String) });
    expect((await snapshot(jobId)).lastReject).toMatchObject({ code: 'JOB_BUSY' });
    c.close();
  });

  it('/file con duración > límite (durationVerified:false, meta de 2 h) → 422 JSON, SSE error + rejected con itemId, sin procesos', async () => {
    const v = vid();
    await scenario(v, { duration: 7200 });
    const { jobId } = await rawJob([{ videoId: v }]);
    const c = await sse(`/api/jobs/${jobId}/events`);
    await waitFor(() => c.events.length === 1);
    const res = await fetch(`${base}/api/jobs/${jobId}/items/i0/file`);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.json()).toMatchObject({ error: { code: 'LIMIT_DURATION' } });
    await waitFor(() => events(c, 'rejected').length === 1 && events(c, 'error').length === 1);
    expect(itemData(events(c, 'error')[0]!)).toMatchObject({ itemId: 'i0', error: { code: 'LIMIT_DURATION' }, errorKind: 'runtime' });
    expect(events(c, 'rejected')[0]!.data).toMatchObject({ code: 'LIMIT_DURATION', itemId: 'i0' });
    expect((await ytdlpLog()).filter((l) => l.videoId === v && l.kind === 'download')).toHaveLength(0);
    c.close();

    const again = await fetch(`${base}/api/jobs/${jobId}/items/i0/file`);
    expect(again.status).toBe(422);
    expect((await snapshot(jobId)).items[0]).toMatchObject({ attempt: 2, errorKind: 'runtime', error: { code: 'LIMIT_DURATION' } });
  });

  it('errorKind validation (creado por POST /api/jobs) → 409 ITEM_INVALID sin lanzar procesos', async () => {
    const ok = vid();
    const long = vid();
    await scenario(long, { duration: 7200 });
    const { jobId } = (await postJob([long, ok])).json() as { jobId: string };
    const res = await fetch(`${base}/api/jobs/${jobId}/items/i0/file`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'ITEM_INVALID' } });
    expect((await ytdlpLog()).filter((l) => l.videoId === long && l.kind === 'download')).toHaveLength(0);
    expect((await snapshot(jobId)).lastReject).toMatchObject({ code: 'ITEM_INVALID', itemId: 'i0' });
  });

  it('ITEM_NOT_FOUND con itemId; job inexistente → 404 sin rejected', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }]);
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/items/i7/file` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ITEM_NOT_FOUND' } });
    expect((await snapshot(jobId)).lastReject).toMatchObject({ code: 'ITEM_NOT_FOUND', itemId: 'i7' });
    const none = await app.inject({ method: 'GET', url: `/api/jobs/${randomUUID()}/items/i0/file` });
    expect(none.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
  });

  it('/archive con todos los items validation → 422 NO_VALID_ITEMS', async () => {
    const { jobId } = await rawJob([
      { videoId: vid(), validationError: 'LIMIT_DURATION' },
      { videoId: vid(), validationError: 'LIMIT_DURATION' },
    ]);
    const res = await fetch(`${base}/api/jobs/${jobId}/archive`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'NO_VALID_ITEMS' } });
    expect((await snapshot(jobId)).lastReject).toMatchObject({ code: 'NO_VALID_ITEMS' });
  });

  it('/archive válido → 200 application/zip setube-mp3-*.zip con ERRORES.txt por el item validation', async () => {
    const { jobId } = await rawJob([{ videoId: vid() }, { videoId: vid(), validationError: 'LIMIT_DURATION' }]);
    const res = await fetch(`${base}/api/jobs/${jobId}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="setube-mp3-\d{8}-\d{4}\.zip"/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(buf.includes(Buffer.from('ERRORES.txt'))).toBe(true);
    expect((await snapshot(jobId)).items[0]).toMatchObject({ status: 'done' });
  });

  it('RATE_LIMITED en /file llega como rejected con details.retryAfterSec numérico', async () => {
    const { jobId } = await rawJob([{ videoId: vid(), validationError: 'LIMIT_DURATION' }, { videoId: vid() }]);
    const c = await sse(`/api/jobs/${jobId}/events`);
    await waitFor(() => c.events.length === 1);
    const remoteAddress = '10.9.8.7';
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/items/i0/file`, remoteAddress })).statusCode;
    }
    expect(last).toBe(429);
    await waitFor(() => events(c, 'rejected').some((e) => (e.data as { code: string }).code === 'RATE_LIMITED'));
    const rl = events(c, 'rejected').find((e) => (e.data as { code: string }).code === 'RATE_LIMITED')!;
    expect(typeof (rl.data as { details: { retryAfterSec: unknown } }).details.retryAfterSec).toBe('number');
    c.close();
  });

});

describe('apagado ordenado', () => {
  it('cierra el SSE con server-restart, aborta el stream con SERVER_SHUTDOWN, libera slot/lock/lease y close() < SHUTDOWN_GRACE_MS', async () => {
    const t2 = await createTestRedis();
    const { app: app2 } = await buildTestApp(t2, { env: { ...env(), SHUTDOWN_GRACE_MS: '6000' } });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const base2 = `http://127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    try {
      const v = vid();
      await scenario(v, { downloads: { '*': [{ mode: 'hang' }] } });
      const jobId = randomUUID();
      await createJob(t2.redis, {
        jobId, format: 'mp3', quality: 192, ipHash: 'h', ttlSec: 600,
        items: [{ videoId: v, title: null, duration: null, durationVerified: false }],
      });
      const c = await sse(`/api/jobs/${jobId}/events`, {}, base2);
      await waitFor(() => c.events.length === 1);
      let fileClosed = false;
      const req = http.get(`${base2}/api/jobs/${jobId}/items/i0/file`, (res) => {
        res.on('data', () => undefined);
        res.on('close', () => (fileClosed = true));
        res.on('error', () => undefined);
      });
      req.on('error', () => (fileClosed = true));
      await waitFor(() => events(c, 'downloading').length > 0);

      const t0 = Date.now();
      await app2.lifecycle.shutdown(app2, 6000);
      expect(Date.now() - t0).toBeLessThan(6000);
      await c.closed;
      expect(c.raw).toMatch(/event: server-restart\ndata: \{\}\n\n$/);
      expect(c.raw).not.toMatch(/id: \d+\nevent: server-restart/);
      await waitFor(() => fileClosed);
      const view = await readJob(t2.redis, jobId, { slotLeaseMs: 30_000 });
      expect(view!.snapshot.items[0]).toMatchObject({ status: 'error', error: { code: 'SERVER_SHUTDOWN' }, errorKind: 'runtime' });
      expect(await t2.redis.zcard(SEM_KEYS.holders)).toBe(0);
      expect(await t2.redis.exists(lockKey(jobId))).toBe(0);
      expect(await t2.redis.zcard(ipsKey(ipHash('127.0.0.1', app2.config.ipHashSalt)))).toBe(0);
      expect(await countKeys(t2, `job:${jobId}:lock`)).toBe(0);
    } finally {
      await t2.cleanup();
    }
  }, 20_000);
});
