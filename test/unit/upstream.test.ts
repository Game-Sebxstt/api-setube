import { describe, expect, it } from 'vitest';
import { openChunk, UpstreamError } from '../../src/lib/preview/upstream.js';
import { fakeFetch, gvUrl, pattern, serve, status } from './helpers/upstream.js';

const data = pattern(5000);
const H = { 'User-Agent': 'UA', 'Accept-Encoding': 'identity' };
const never = new AbortController().signal;

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    return (e as UpstreamError).kind;
  }
}

describe('openChunk', () => {
  it('recorta el rango pedido a chunkBytes, con redirect manual y cabeceras del formato', async () => {
    const f = fakeFetch((c) => serve(data, c));
    const o = await openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 100, 4999, 5000, never);
    expect(f.calls[0]).toMatchObject({ range: 'bytes=100-1099', redirect: 'manual' });
    expect(f.calls[0]?.headers['User-Agent']).toBe('UA');
    expect(o).toMatchObject({ start: 100, end: 1099, total: 5000, redirects: 0 });
    await o.body.cancel();
  });

  it('sigue 2 redirecciones a *.googlevideo.com y reenvía Range', async () => {
    const f = fakeFetch((c, n) =>
      n < 3 ? status(302, { location: `https://rr${n + 1}---sn-b.googlevideo.com/videoplayback?x=${n}` }) : serve(data, c),
    );
    const o = await openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, never);
    expect(o.redirects).toBe(2);
    expect(o.finalUrl).toContain('rr3---sn-b.googlevideo.com');
    expect(f.calls.map((c) => c.range)).toEqual(['bytes=0-9', 'bytes=0-9', 'bytes=0-9']);
    await o.body.cancel();
  });

  it('6.º salto o host ajeno → invalid', async () => {
    const loop = fakeFetch(() => status(302, { location: 'https://rr9---sn-c.googlevideo.com/v' }));
    expect(await kindOf(openChunk({ fetch: loop.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, never))).toBe('invalid');
    expect(loop.calls).toHaveLength(6);
    const evil = fakeFetch(() => status(302, { location: 'https://evil.example/x' }));
    expect(await kindOf(openChunk({ fetch: evil.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, never))).toBe('invalid');
  });

  it('Content-Range incorrecto → invalid; T distinto → size', async () => {
    const bad = fakeFetch(() => new Response('x', { status: 206, headers: { 'content-range': 'bytes 5-9/5000' } }));
    expect(await kindOf(openChunk({ fetch: bad.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, 5000, never))).toBe('invalid');
    const ok200 = fakeFetch(() => new Response('x', { status: 200 }));
    expect(await kindOf(openChunk({ fetch: ok200.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, 5000, never))).toBe('invalid');
    const size = fakeFetch((c) => serve(data, c));
    const p = openChunk({ fetch: size.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, 4000, never);
    await expect(p).rejects.toMatchObject({ kind: 'size', total: 5000 });
  });

  it.each([
    [403, 'forbidden'],
    [410, 'gone'],
    [429, 'blocked'],
    [500, 'invalid'],
  ])('status %i → %s', async (code, kind) => {
    const f = fakeFetch(() => status(code));
    expect(await kindOf(openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, never))).toBe(kind);
  });

  it('416 → range con el total de upstream', async () => {
    const f = fakeFetch((c) => serve(data, c));
    await expect(openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 6000, 7000, null, never)).rejects.toMatchObject({
      kind: 'range',
      total: 5000,
    });
  });

  it('timeout de cabeceras → timeout; aborto externo → aborted', async () => {
    const hang = (_c: unknown) =>
      new Promise<Response>((_r, rej) => {
        const c = _c as { signal?: AbortSignal };
        c.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
    const f = fakeFetch(hang);
    expect(await kindOf(openChunk({ fetch: f.fetch, chunkBytes: 1000, headersTimeoutMs: 50 }, gvUrl('140'), H, 0, 9, null, never))).toBe('timeout');
    const ac = new AbortController();
    const p = openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, ac.signal);
    setTimeout(() => ac.abort(), 20);
    expect(await kindOf(p)).toBe('aborted');
  });

  it('error de red → network sin rastro del host firmado', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect rr1---sn-x.googlevideo.com:443') });
    });
    try {
      await openChunk({ fetch: f.fetch, chunkBytes: 1000 }, gvUrl('140'), H, 0, 9, null, never);
      throw new Error('no falló');
    } catch (e) {
      expect((e as UpstreamError).kind).toBe('network');
      expect(String(e)).not.toContain('googlevideo');
      expect(JSON.stringify(e)).not.toContain('googlevideo');
      expect((e as Error).cause).toBeUndefined();
    }
  });
});
