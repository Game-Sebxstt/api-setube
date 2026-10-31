import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { createInfoCache } from '../../src/lib/preview/info-cache.js';
import { createSegmentIndex, indexKey, type SegmentIndexDeps } from '../../src/lib/preview/segment-index.js';
import type { SessionDeps } from '../../src/lib/preview/session.js';
import { fakeRedis } from './helpers/fake-app.js';
import { fakeMp4 } from './helpers/mp4.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, serve, videoFormat, type Call } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const KiB = 1024;
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

function setup(o: {
  data: Buffer;
  handler?: (c: Call, n: number) => Response | Promise<Response>;
  info?: Record<string, unknown>;
  store?: Map<string, string>;
  redisDown?: boolean;
}) {
  const f = fakeFetch(o.handler ?? ((c) => serve(o.data, c, { contentType: 'video/mp4' })));
  const info = o.info ?? infoWith([videoFormat('134', 360, o.data.length), videoFormat('136', 720, o.data.length), audioFormat('140', o.data.length)]);
  const metadata = {
    readInfoJson: vi.fn(async () => info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: info })),
  };
  const store = o.store ?? new Map<string, string>();
  const set = vi.fn(async (k: unknown, v: unknown) => {
    store.set(String(k), String(v));
    return 'OK';
  });
  const get = vi.fn(async (k: unknown) => store.get(String(k)) ?? null);
  const warn = vi.fn();
  const session: SessionDeps = {
    fetch: f.fetch,
    chunkBytes: 10 * 1024 * KiB,
    metadata: createInfoCache(metadata),
    redis: o.redisDown ? fakeRedis() : fakeRedis({ get, set }),
    warn,
    retryDelayMs: 0,
    retryJitterMs: 0,
  };
  const deps: SegmentIndexDeps = { session, ttlSec: 3600, maxHeight: 1080 };
  return { f, deps, metadata, store, get, set, warn, index: createSegmentIndex(deps) };
}

describe('createSegmentIndex', () => {
  it('lee 64 KiB, devuelve el índice exacto y lo guarda en Redis con el tamaño del Content-Range', async () => {
    const mp4 = fakeMp4({ fragments: 40, fragmentSize: 6000 });
    const t = setup({ data: mp4.data });
    const ix = await t.index.get(ID, '136');
    expect(t.f.calls.map((c) => c.range)).toEqual(['bytes=0-65535']);
    expect(ix).toMatchObject({ videoId: ID, formatId: '136', size: mp4.data.length, contentType: 'video/mp4', initEnd: mp4.initEnd, sidxEnd: mp4.sidxEnd, timescale: 15360 });
    expect(ix.segments.map((s) => [s.offset, s.size])).toEqual(mp4.fragments);
    expect(ix.segments.every((s) => s.duration === 30720 && s.startsWithSap)).toBe(true);
    expect(t.set).toHaveBeenCalledWith(indexKey(ID, '136', mp4.data.length), expect.any(String), 'EX', 3600);
    expect(t.index.stats).toMatchObject({ builds: 1 });
  });

  it('archivo más pequeño que 64 KiB: pide solo hasta el final', async () => {
    const mp4 = fakeMp4({ fragments: 3, fragmentSize: 1000 });
    const t = setup({ data: mp4.data });
    await t.index.get(ID, '134');
    expect(t.f.calls.map((c) => c.range)).toEqual([`bytes=0-${mp4.data.length - 1}`]);
  });

  it('la segunda petición sale de memoria sin tocar Redis ni googlevideo', async () => {
    const mp4 = fakeMp4();
    const t = setup({ data: mp4.data });
    const a = await t.index.get(ID, '136');
    t.get.mockClear();
    const b = await t.index.get(ID, '136');
    expect(b).toBe(a);
    expect(t.f.calls).toHaveLength(1);
    expect(t.get).not.toHaveBeenCalled();
    expect(t.index.stats).toMatchObject({ builds: 1, memHits: 1 });
  });

  it('otra instancia (memoria vacía) lo saca de Redis sin tocar googlevideo', async () => {
    const mp4 = fakeMp4({ fragments: 7 });
    const store = new Map<string, string>();
    const first = setup({ data: mp4.data, store });
    const want = await first.index.get(ID, '136');
    const second = setup({ data: mp4.data, store });
    const got = await second.index.get(ID, '136');
    expect(second.f.calls).toHaveLength(0);
    expect(got).toEqual(want);
    expect(second.index.stats).toMatchObject({ builds: 0, redisHits: 1 });
  });

  it('starts_with_SAP y SAP_type sobreviven a Redis, también en un fragmento sin SAP', async () => {
    // Fragmento 2 sin SAP (SAP_type 3), fragmento 3 con SAP tipo 2; el resto, SAP tipo 1
    const mp4 = fakeMp4({ fragments: 5, sap: (i) => (i === 2 ? 0x30000000 : i === 3 ? 0xa0000000 : 0x90000000) });
    const store = new Map<string, string>();
    const built = await setup({ data: mp4.data, store }).index.get(ID, '136');
    expect(built.segments.map((s) => [s.startsWithSap, s.sapType])).toEqual([[true, 1], [true, 1], [false, 3], [true, 2], [true, 1]]);
    const second = setup({ data: mp4.data, store });
    const read = await second.index.get(ID, '136');
    expect(second.index.stats).toMatchObject({ builds: 0, redisHits: 1 });
    expect(read).toEqual(built);
  });

  it('un índice de la versión anterior (v1) en Redis se descarta y se recalcula', async () => {
    const mp4 = fakeMp4({ fragments: 2 });
    const [a, b] = mp4.fragments as [[number, number], [number, number]];
    const v1 = { v: 1, ct: 'video/mp4', size: mp4.data.length, initEnd: mp4.initEnd, sidxEnd: mp4.sidxEnd, timescale: 15360, ept: 0, seg: [[...a, 0, 30720, 1], [...b, 30720, 30720, -1]] };
    const store = new Map([[indexKey(ID, '136', mp4.data.length), JSON.stringify(v1)]]);
    const t = setup({ data: mp4.data, store });
    const ix = await t.index.get(ID, '136');
    expect(t.index.stats).toMatchObject({ builds: 1, redisHits: 0 });
    expect(ix.segments.every((s) => s.startsWithSap && s.sapType === 1)).toBe(true);
    expect(JSON.parse(store.get(indexKey(ID, '136', mp4.data.length)) as string)).toMatchObject({ v: 2 });
  });

  it('un valor corrupto en Redis se ignora y se recalcula', async () => {
    const mp4 = fakeMp4();
    const store = new Map([[indexKey(ID, '136', mp4.data.length), '{"v":1,"seg":"x"}']]);
    const t = setup({ data: mp4.data, store });
    const ix = await t.index.get(ID, '136');
    expect(ix.segments).toHaveLength(5);
    expect(t.f.calls).toHaveLength(1);
  });

  it('peticiones simultáneas del mismo índice comparten una sola lectura de la cabecera', async () => {
    const mp4 = fakeMp4();
    const t = setup({ data: mp4.data });
    const all = await Promise.all([t.index.get(ID, '136'), t.index.get(ID, '136'), t.index.get(ID, '136')]);
    expect(t.f.calls).toHaveLength(1);
    expect(all[1]).toBe(all[0]);
    expect(all[2]).toBe(all[0]);
    expect(t.metadata.readInfoJson).toHaveBeenCalledTimes(1);
    expect(t.index.stats.builds).toBe(1);
  });

  it('quien se cansa de esperar (signal) no corta el cálculo compartido', async () => {
    const mp4 = fakeMp4();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      data: mp4.data,
      handler: async (c) => {
        await gate;
        return serve(mp4.data, c);
      },
    });
    const ac = new AbortController();
    const impatient = t.index.get(ID, '136', ac.signal);
    const patient = t.index.get(ID, '136');
    ac.abort();
    expect(code(await impatient.catch((e) => e))).toBe('DOWNLOAD_INTERRUPTED');
    release();
    expect((await patient).segments).toHaveLength(5);
    expect(t.f.calls).toHaveLength(1);
  });

  it('cabecera de más de 64 KiB: crece hasta tener el sidx', async () => {
    const mp4 = fakeMp4({ moovBytes: 100 * KiB, fragments: 10, fragmentSize: 6000 });
    const t = setup({ data: mp4.data });
    const ix = await t.index.get(ID, '136');
    expect(t.f.calls.map((c) => c.range)).toEqual(['bytes=0-65535', 'bytes=65536-131071']);
    expect(ix.segments.map((s) => [s.offset, s.size])).toEqual(mp4.fragments);
  });

  it('índice que no cabe en 1 MiB → FORMAT_UNAVAILABLE sin pedir más', async () => {
    const mp4 = fakeMp4({ moovBytes: 1100 * KiB });
    const t = setup({ data: mp4.data });
    expect(code(await t.index.get(ID, '136').catch((e) => e))).toBe('FORMAT_UNAVAILABLE');
    expect(t.f.calls.every((c) => Number(/-(\d+)$/.exec(c.range)?.[1]) < 1024 * KiB)).toBe(true);
    expect(t.warn).toHaveBeenCalledWith('preview_index_too_large', expect.objectContaining({ formatId: '136' }));
    expect(t.set).not.toHaveBeenCalled();
  });

  it('archivo que no es un MP4 fragmentado → FORMAT_UNAVAILABLE con el motivo en el log', async () => {
    const data = Buffer.from('1a45dfa3a3428681010000000000000000'.repeat(100), 'hex');
    const t = setup({ data });
    expect(code(await t.index.get(ID, '136').catch((e) => e))).toBe('FORMAT_UNAVAILABLE');
    expect(t.warn).toHaveBeenCalledWith('preview_index_invalid', expect.objectContaining({ videoId: ID, formatId: '136', reason: 'bad-box' }));
  });

  it('los fragmentos no llegan al final del archivo → FORMAT_UNAVAILABLE (size-mismatch)', async () => {
    const mp4 = fakeMp4({ trailer: 70 * KiB });
    const t = setup({ data: mp4.data });
    expect(code(await t.index.get(ID, '136').catch((e) => e))).toBe('FORMAT_UNAVAILABLE');
    expect(t.warn).toHaveBeenCalledWith('preview_index_invalid', expect.objectContaining({ reason: 'size-mismatch' }));
  });

  it('el tamaño de la info no coincide con el real: manda el Content-Range', async () => {
    const mp4 = fakeMp4({ trailer: 333 });
    const info = infoWith([videoFormat('136', 720, mp4.data.length + 5000), audioFormat('140', 1000)]);
    const t = setup({ data: mp4.data, info });
    const ix = await t.index.get(ID, '136');
    expect(ix.size).toBe(mp4.data.length);
    expect(t.set).toHaveBeenCalledWith(indexKey(ID, '136', mp4.data.length), expect.any(String), 'EX', 3600);
  });

  it('formato fuera de la lista permitida → FORMAT_UNAVAILABLE sin tocar googlevideo', async () => {
    const mp4 = fakeMp4();
    const t = setup({ data: mp4.data, info: infoWith([videoFormat('137', 1080, mp4.data.length), audioFormat('251', 1000)]) });
    const capped = createSegmentIndex({ ...t.deps, maxHeight: 720 });
    expect(code(await capped.get(ID, '137').catch((e) => e))).toBe('FORMAT_UNAVAILABLE');
    expect(code(await capped.get(ID, '251').catch((e) => e))).toBe('FORMAT_UNAVAILABLE');
    expect(t.f.calls).toHaveLength(0);
  });

  it('el índice del audio m4a también se calcula', async () => {
    const mp4 = fakeMp4({ fragments: 3, duration: 441344 });
    const t = setup({ data: mp4.data });
    const ix = await t.index.get(ID, '140');
    expect(ix).toMatchObject({ formatId: '140', contentType: 'audio/mp4' });
    expect(ix.segments).toHaveLength(3);
  });

  it('con Redis caído calcula igual y avisa', async () => {
    const mp4 = fakeMp4();
    const t = setup({ data: mp4.data, redisDown: true });
    expect((await t.index.get(ID, '136')).segments).toHaveLength(5);
    expect(t.warn).toHaveBeenCalledWith('preview_index_cache_unavailable');
  });

  it('forget borra la copia en memoria', async () => {
    const mp4 = fakeMp4();
    const t = setup({ data: mp4.data });
    await t.index.get(ID, '136');
    t.index.forget(ID, '136');
    expect(t.index.peek(ID, '136')).toBeNull();
    await t.index.get(ID, '136');
    expect(t.index.stats).toMatchObject({ builds: 1, redisHits: 1 });
  });
});
