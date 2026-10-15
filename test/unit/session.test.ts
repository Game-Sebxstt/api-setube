import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { createDeadline } from '../../src/lib/preview/deadline.js';
import { createSession, forbiddenKey, type SessionDeps } from '../../src/lib/preview/session.js';
import { fakeRedis } from './helpers/fake-app.js';
import { audioFormat, fakeFetch, fakeMeta, gvUrl, infoWith, nowSec, pattern, serve, status, type Call } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const MiB = 1024 * 1024;

function setup(o: {
  handler: (c: Call, n: number) => Response | Promise<Response>;
  info?: Record<string, unknown> | null;
  refreshed?: Record<string, unknown>;
  forbidden?: string[];
  chunkBytes?: number;
}) {
  const f = fakeFetch(o.handler);
  const info = o.info === undefined ? infoWith([audioFormat('140', 3000), audioFormat('251', 3000)]) : o.info;
  const refreshedInfo = o.refreshed ?? infoWith([audioFormat('140', 3000, { url: gvUrl('140', '&fresh=1') }), audioFormat('251', 3000)]);
  const metadata = {
    readInfoJson: vi.fn(async () => info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: refreshedInfo })),
  };
  const get = vi.fn(async (k: unknown) => (o.forbidden?.some((id) => k === forbiddenKey(ID, id)) ? '1' : null));
  const set = vi.fn(async () => 'OK');
  const warn = vi.fn();
  const deps: SessionDeps = {
    fetch: f.fetch,
    chunkBytes: o.chunkBytes ?? 1000,
    metadata: metadata as unknown as SessionDeps['metadata'],
    redis: fakeRedis({ get, set }),
    warn,
    retryDelayMs: 0,
    retryJitterMs: 0,
  };
  return { f, deps, metadata, get, set, warn };
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(b);
  return Buffer.concat(parts);
}

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
const never = () => new AbortController().signal;

async function run(deps: SessionDeps, range: { start: number; end: number; suffix: boolean } | null = null, codec?: 'aac' | 'opus') {
  const s = createSession(deps, ID, codec, never());
  const dl = createDeadline(10_000);
  await s.prepare(dl);
  const first = await s.openFirst(range, dl);
  dl.clear();
  const body = await collect(s.stream(first.opened, first.end));
  return { s, first, body };
}

describe('createSession: escalera de 403', () => {
  const data = pattern(3000);

  it('403 → misma URL → 206 sin refresh (same)', async () => {
    const t = setup({ handler: (c, n) => (n === 1 ? status(403) : serve(data, c)) });
    const { s, body } = await run(t.deps);
    expect(body.equals(data)).toBe(true);
    expect(s.stats.retry403).toBe('same');
    expect(t.metadata.refresh).not.toHaveBeenCalled();
    expect(t.f.calls[0]?.url).toBe(t.f.calls[1]?.url);
  });

  it('403 persistente con la URL vieja → same ×2 → refresh → 206', async () => {
    const t = setup({ handler: (c) => (c.url.includes('fresh=1') ? serve(data, c) : status(403)) });
    const { s, body } = await run(t.deps);
    expect(body.equals(data)).toBe(true);
    expect(s.stats).toMatchObject({ retry403: 'refresh', refreshed: true });
    expect(t.metadata.refresh).toHaveBeenCalledTimes(1);
    expect(t.f.calls).toHaveLength(6);
  });

  it('expire − now ≤ 300 salta directo a refresh', async () => {
    const soon = infoWith([audioFormat('140', 3000, { url: gvUrl('140').replace(/expire=\d+/, `expire=${nowSec() + 200}`) })]);
    const t = setup({ info: soon, handler: (c) => (c.url.includes('fresh=1') ? serve(data, c) : status(403)) });
    const { s } = await run(t.deps);
    expect(s.stats.retry403).toBe('refresh');
    expect(t.f.calls.filter((c) => !c.url.includes('fresh=1'))).toHaveLength(1);
  });

  it('si prepare ya refrescó, un 403 persistente no vuelve a refrescar y marca pv:forbidden 120 s', async () => {
    const t = setup({ info: null, handler: () => status(403) });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(10_000);
    await s.prepare(dl);
    expect(code(await s.openFirst(null, dl).catch((e) => e))).toBe('UPSTREAM_FORBIDDEN');
    dl.clear();
    expect(t.metadata.refresh).toHaveBeenCalledTimes(1);
    expect(t.set).toHaveBeenCalledWith(forbiddenKey(ID, '140'), '1', 'EX', 120);
    expect(s.stats.retry403).toBe('failed');
    expect(t.warn).toHaveBeenCalledWith('preview_forbidden', expect.objectContaining({ videoId: ID, formatId: '140', phase: 'pre' }));
  });

  it('formato marcado en pv:forbidden → UPSTREAM_FORBIDDEN sin tocar upstream y nunca sirve 139', async () => {
    const info = infoWith([audioFormat('140', 3000), audioFormat('139', 3000, { acodec: 'mp4a.40.5' }), audioFormat('251', 3000)]);
    const t = setup({ info, forbidden: ['140'], handler: (c) => serve(data, c) });
    for (const range of [null, { start: 1000, end: 2999, suffix: false }]) {
      const s = createSession(t.deps, ID, 'aac', never());
      const dl = createDeadline(10_000);
      const err = await s.prepare(dl).then(() => s.openFirst(range, dl)).catch((e) => e);
      dl.clear();
      expect(code(err)).toBe('UPSTREAM_FORBIDDEN');
    }
    expect(t.f.calls).toHaveLength(0);
  });

  it('refresh que cambia el formato: con start > 0 → UPSTREAM_FORBIDDEN; desde 0 acepta el nuevo ETag', async () => {
    const soon = infoWith([audioFormat('140', 3000, { url: gvUrl('140').replace(/expire=\d+/, `expire=${nowSec() + 100}`) })]);
    const swapped = infoWith([audioFormat('141', 2000, { url: gvUrl('141', '&fresh=1') })]);
    const small = pattern(2000);
    const handler = (c: Call) => (c.url.includes('fresh=1') ? serve(small, c) : status(403));

    const a = setup({ info: soon, refreshed: swapped, handler });
    const sa = createSession(a.deps, ID, undefined, never());
    const dl = createDeadline(10_000);
    await sa.prepare(dl);
    expect(code(await sa.openFirst({ start: 1000, end: 2999, suffix: false }, dl).catch((e) => e))).toBe('UPSTREAM_FORBIDDEN');

    const b = setup({ info: soon, refreshed: swapped, handler });
    const sb = createSession(b.deps, ID, undefined, never());
    await sb.prepare(dl);
    expect(sb.etag).toBe('"140-3000"');
    const first = await sb.openFirst(null, dl);
    dl.clear();
    expect(sb.etag).toBe('"141-2000"');
    expect(first.end).toBe(1999);
    expect((await collect(sb.stream(first.opened, first.end))).equals(small)).toBe(true);
  });
});

describe('createSession: tramos', () => {
  it('size nulo: sonda 0-0 y después el tramo', async () => {
    const data = pattern(2500);
    const t = setup({ info: infoWith([audioFormat('140', null)]), handler: (c) => serve(data, c) });
    const { s, body } = await run(t.deps);
    expect(t.f.calls[0]?.range).toBe('bytes=0-0');
    expect(t.f.calls[1]?.range).toBe('bytes=0-999');
    expect(s.total).toBe(2500);
    expect(body.equals(data)).toBe(true);
  });

  it('cada tramo pedido es ≤ chunkBytes y los bytes coinciden', async () => {
    const data = pattern(3000);
    const t = setup({ handler: (c) => serve(data, c, { block: 333 }) });
    const { body } = await run(t.deps, { start: 500, end: 2999, suffix: false });
    expect(t.f.calls.map((c) => c.range)).toEqual(['bytes=500-1499', 'bytes=1500-2499', 'bytes=2500-2999']);
    expect(body.equals(data.subarray(500))).toBe(true);
  });

  it('T distinto en el 2.º tramo destruye con failCode', async () => {
    const data = pattern(3000);
    const other = pattern(4000);
    const t = setup({ handler: (c, n) => serve(n === 1 ? data : other, c) });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(10_000);
    await s.prepare(dl);
    const first = await s.openFirst(null, dl);
    dl.clear();
    expect(code(await collect(s.stream(first.opened, first.end)).catch((e) => e))).toBe('UPSTREAM_ERROR');
    expect(s.stats.failCode).toBe('UPSTREAM_ERROR');
  });

  it('un tramo corto se reanuda en pos y las reanudaciones se reponen tras un tramo completo', async () => {
    const data = pattern(3000);
    const t = setup({ handler: (c, n) => serve(data, c, n === 1 || n === 3 ? { truncateAt: Number(/=(\d+)/.exec(c.range)?.[1]) + 400 } : {}) });
    const { s, body } = await run(t.deps);
    expect(body.equals(data)).toBe(true);
    expect(t.f.calls.map((c) => c.range)).toEqual(['bytes=0-999', 'bytes=400-1399', 'bytes=1400-2399', 'bytes=1800-2799', 'bytes=2800-2999']);
    expect(s.stats.resumes).toBe(2);
  });

  it('reanudaciones agotadas → UPSTREAM_ERROR', async () => {
    const data = pattern(3000);
    const t = setup({ handler: (c) => serve(data, c, { truncateAt: Number(/=(\d+)/.exec(c.range)?.[1]) + 10 }) });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(10_000);
    await s.prepare(dl);
    const first = await s.openFirst(null, dl);
    dl.clear();
    expect(code(await collect(s.stream(first.opened, first.end)).catch((e) => e))).toBe('UPSTREAM_ERROR');
    expect(s.stats.resumes).toBe(3);
  });

  it('abortar la sesión en streaming no fija failCode', async () => {
    const data = pattern(3000);
    const t = setup({ handler: (c) => serve(data, c, { block: 100 }) });
    const ac = new AbortController();
    const s = createSession(t.deps, ID, undefined, ac.signal);
    const dl = createDeadline(10_000);
    await s.prepare(dl);
    const first = await s.openFirst(null, dl);
    dl.clear();
    const gen = s.stream(first.opened, first.end);
    await gen.next();
    ac.abort();
    const err = await (async () => {
      for await (const _ of gen) void _;
    })().catch((e) => e);
    expect(code(err)).toBe('DOWNLOAD_INTERRUPTED');
    expect(s.stats.failCode).toBeUndefined();
  });

  it('opus: Content-Type audio/webm y formato 251', async () => {
    const data = pattern(3000);
    const t = setup({ handler: (c) => serve(data, c) });
    const { s } = await run(t.deps, null, 'opus');
    expect(s.src).toMatchObject({ formatId: '251', contentType: 'audio/webm' });
  });
});

describe('createSession: plazos y backpressure', () => {
  it('openFirst sin respuesta con plazo de 100 ms → UPSTREAM_TIMEOUT', async () => {
    const t = setup({
      handler: (c) =>
        new Promise<Response>((_r, rej) => c.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(100);
    await s.prepare(dl);
    expect(code(await s.openFirst(null, dl).catch((e) => e))).toBe('UPSTREAM_TIMEOUT');
  });

  it('un stream de 400 ms termina completo aunque el plazo de 100 ms ya venció', async () => {
    const data = pattern(3000);
    const slow = (c: Call) => {
      const r = serve(data, c, { block: 250 });
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          await new Promise((res) => setTimeout(res, 35));
          const x = await reader.read();
          if (x.done) ctrl.close();
          else ctrl.enqueue(x.value);
        },
      });
      return new Response(body, { status: 206, headers: r.headers });
    };
    const t = setup({ handler: slow });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(100);
    await s.prepare(dl);
    const first = await s.openFirst(null, dl);
    const t0 = Date.now();
    const body = await collect(s.stream(first.opened, first.end));
    expect(Date.now() - t0).toBeGreaterThan(300);
    expect(dl.timedOut()).toBe(true);
    expect(body.equals(data)).toBe(true);
  });

  it('backpressure: con el destino parado no se lee de más ni se abre otro tramo', async () => {
    let pulled = 0;
    const handler = (c: Call) => {
      const m = /=(\d+)-(\d+)/.exec(c.range);
      const start = Number(m?.[1]);
      const end = Number(m?.[2]);
      let pos = start;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(ctrl) {
            if (pos > end) return ctrl.close();
            const n = Math.min(16 * 1024, end - pos + 1);
            ctrl.enqueue(new Uint8Array(n));
            pos += n;
            pulled += n;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${30 * MiB}` } });
    };
    const t = setup({ info: infoWith([audioFormat('140', 30 * MiB)]), handler, chunkBytes: 10 * MiB });
    const ac = new AbortController();
    const s = createSession(t.deps, ID, undefined, ac.signal);
    const dl = createDeadline(10_000);
    await s.prepare(dl);
    const first = await s.openFirst(null, dl);
    dl.clear();
    const w = new Writable({ highWaterMark: 16 * 1024, write: () => undefined });
    const p = pipeline(Readable.from(s.stream(first.opened, first.end), { objectMode: false, highWaterMark: 65536 }), w).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(pulled).toBeLessThanOrEqual(256 * 1024);
    expect(t.f.calls).toHaveLength(1);
    ac.abort();
    w.destroy();
    await p;
  });

  it('available_at a 1 s espera y abre', async () => {
    const data = pattern(3000);
    const info = infoWith([audioFormat('140', 3000, { available_at: Date.now() / 1000 + 1 })]);
    const t = setup({ info, handler: (c) => serve(data, c) });
    const t0 = Date.now();
    const { body } = await run(t.deps);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(body.equals(data)).toBe(true);
  });

  it('available_at lejano → UPSTREAM_ERROR', async () => {
    const info = infoWith([audioFormat('140', 3000, { available_at: nowSec() + 60 })]);
    const t = setup({ info, handler: (c) => serve(pattern(3000), c) });
    const s = createSession(t.deps, ID, undefined, never());
    const dl = createDeadline(10_000);
    expect(code(await s.prepare(dl).catch((e) => e))).toBe('UPSTREAM_ERROR');
    dl.clear();
  });
});
