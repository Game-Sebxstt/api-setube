import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createInfoCache, slimInfo } from '../../src/lib/preview/info-cache.js';
import { audioFormat, fakeMeta, infoWith, videoFormat } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const OTHER = 'dQw4w9WgXcQ';

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(info: Record<string, unknown> | null = infoWith([audioFormat('140', 1000), videoFormat('136', 720, 5000)])) {
  const metadata = {
    readInfoJson: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => info),
    refresh: vi.fn(async (_id: string) => ({ meta: fakeMeta(), infoJson: infoWith([audioFormat('140', 1000, { abr: 129 })]) })),
  };
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { metadata, clock };
}

describe('createInfoCache', () => {
  it('dos lecturas seguidas del mismo video leen y parsean Redis una sola vez', async () => {
    const { metadata, clock } = setup();
    const c = createInfoCache(metadata, { now: clock.now });
    const a = await c.readInfoJson(ID);
    const b = await c.readInfoJson(ID);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('las lecturas simultáneas comparten la misma lectura de Redis', async () => {
    const { metadata } = setup();
    const gate = deferred<Record<string, unknown> | null>();
    metadata.readInfoJson.mockImplementationOnce(() => gate.promise);
    const c = createInfoCache(metadata);
    const p = Promise.all([c.readInfoJson(ID), c.readInfoJson(ID), c.readInfoJson(ID)]);
    gate.resolve(infoWith([audioFormat('140', 1000)]));
    const [a, b, d] = await p;
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(d);
  });

  it('caduca a los ~60 s', async () => {
    const { metadata, clock } = setup();
    const c = createInfoCache(metadata, { now: clock.now });
    await c.readInfoJson(ID);
    clock.advance(59_000);
    await c.readInfoJson(ID);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    await c.readInfoJson(ID);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(2);
  });

  it('no guarda más de `max` entradas y descarta la usada hace más tiempo', async () => {
    const { metadata } = setup();
    const c = createInfoCache(metadata, { max: 2 });
    await c.readInfoJson('a'.repeat(11));
    await c.readInfoJson('b'.repeat(11));
    await c.readInfoJson('a'.repeat(11)); // la 'a' pasa a ser la más reciente
    await c.readInfoJson('c'.repeat(11));
    expect(c.size).toBe(2);
    metadata.readInfoJson.mockClear();
    await c.readInfoJson('a'.repeat(11));
    expect(metadata.readInfoJson).not.toHaveBeenCalled();
    await c.readInfoJson('b'.repeat(11));
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
  });

  it('refresh deja en la caché el info nuevo; forget obliga a releer', async () => {
    const { metadata } = setup();
    const c = createInfoCache(metadata);
    await c.readInfoJson(ID);
    const r = await c.refresh(ID);
    expect(metadata.refresh).toHaveBeenCalledWith(ID);
    expect(await c.readInfoJson(ID)).toBe(r.infoJson);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
    c.forget(ID);
    await c.readInfoJson(ID);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(2);
  });

  it('una lectura de Redis empezada antes de refresh no pisa el info refrescado', async () => {
    const { metadata } = setup();
    const gate = deferred<Record<string, unknown> | null>();
    metadata.readInfoJson.mockImplementationOnce(() => gate.promise);
    const c = createInfoCache(metadata);
    const old = c.readInfoJson(ID);
    const r = await c.refresh(ID);
    gate.resolve(infoWith([audioFormat('140', 1000, { abr: 1 })]));
    await old;
    expect(await c.readInfoJson(ID)).toBe(r.infoJson);
  });

  it('sin info en Redis devuelve null y no lo guarda', async () => {
    const { metadata } = setup(null);
    const c = createInfoCache(metadata);
    expect(await c.readInfoJson(ID)).toBeNull();
    expect(await c.readInfoJson(OTHER)).toBeNull();
    expect(await c.readInfoJson(ID)).toBeNull();
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(3);
    expect(c.size).toBe(0);
  });
});

describe('slimInfo', () => {
  it('se queda con los formatos https sin `fragments` y conserva el resto', () => {
    const sample = JSON.parse(readFileSync(new URL('../fixtures/info-sample.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const slim = slimInfo({ ...sample, epoch: 123 });
    const formats = slim.formats as Record<string, unknown>[];
    expect(formats.length).toBeGreaterThan(0);
    expect(formats.every((f) => f.protocol === 'https' && !('fragments' in f))).toBe(true);
    expect(formats.map((f) => f.format_id)).toContain('160');
    expect(formats.map((f) => f.format_id)).not.toContain('233');
    expect(slim.epoch).toBe(123);
    expect(slim.id).toBe(sample.id);
  });
});
