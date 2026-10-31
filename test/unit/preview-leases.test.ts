import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { createDeadline, withDeadline } from '../../src/lib/preview/deadline.js';
import { createPreviewLeases, MAX_CONNS_PER_PLAYER, MAX_MEDIA_CONNS_PER_PLAYER } from '../../src/lib/preview/leases.js';
import type { PreviewConn } from '../../src/lib/preview/types.js';
import { fakeRedis } from './helpers/fake-app.js';

const conn = (id: string): PreviewConn => ({
  id,
  abort: new AbortController(),
  res: { destroyed: false, destroy: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true; }) },
  outcome: null,
});

// Lua de leases simulado: ZSET por clave con límite
function luaFake(opts: { renew?: () => boolean } = {}) {
  const sets = new Map<string, Set<string>>();
  const acquire = vi.fn((key: unknown, member: unknown, _ms: unknown, limit: unknown) => {
    const s = sets.get(String(key)) ?? new Set<string>();
    sets.set(String(key), s);
    if (s.has(String(member))) return 1;
    if (s.size >= Number(limit)) return 0;
    s.add(String(member));
    return 1;
  });
  const renew = vi.fn((key: unknown, member: unknown) => (opts.renew ? (opts.renew() ? 1 : 0) : sets.get(String(key))?.has(String(member)) ? 1 : 0));
  const release = vi.fn((key: unknown, member: unknown) => {
    sets.get(String(key))?.delete(String(member));
    return 1;
  });
  return { sets, acquire, renew, release, handlers: { setubeLeaseAcquire: acquire, setubeLeaseRenew: renew, setubeLeaseRelease: release } };
}

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

afterEach(() => {
  vi.useRealTimers();
});

describe('createPreviewLeases', () => {
  it('3 conexiones del mismo sid: 1 leaseAcquire y 1 leaseRelease al soltar la última', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const got = await Promise.all(['a', 'b', 'c'].map((id) => leases.acquire('h', 'sid1', conn(id))));
    expect(l.acquire).toHaveBeenCalledTimes(1);
    await got[0]?.release();
    await got[1]?.release();
    expect(l.release).not.toHaveBeenCalled();
    await got[2]?.release();
    expect(l.release).toHaveBeenCalledTimes(1);
    expect(leases.size()).toBe(0);
  });

  it('5 sid distintos con maxPerIp 4 → el 5.º TOO_MANY_PREVIEWS', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    for (let i = 0; i < 4; i++) await leases.acquire('h', `sid${i}`, conn(`c${i}`));
    expect(code(await leases.acquire('h', 'sid4', conn('c4')).catch((e) => e))).toBe('TOO_MANY_PREVIEWS');
    expect(leases.size()).toBe(4);
  });

  it('la 4.ª conexión del mismo sid destruye la más antigua con outcome superseded', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const cs = ['a', 'b', 'c', 'd'].map(conn);
    for (const c of cs) await leases.acquire('h', 'sid', c);
    expect(cs[0]?.outcome).toBe('superseded');
    expect(cs[0]?.abort.signal.aborted).toBe(true);
    expect(cs[0]?.res.destroy).toHaveBeenCalled();
    expect(cs[1]?.outcome).toBeNull();
  });

  it('medios (maxConns 6): seis conexiones del mismo sid conviven y la séptima corta la más antigua', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const cs = ['a', 'b', 'c', 'd', 'e', 'f'].map(conn);
    const got = [];
    for (const c of cs) got.push(await leases.acquire('h', 'sid', c, MAX_MEDIA_CONNS_PER_PLAYER));
    expect(cs.every((c) => c.outcome === null)).toBe(true);
    expect(got.map((g) => g.conns)).toEqual([1, 2, 3, 4, 5, 6]);
    const g = conn('g');
    await leases.acquire('h', 'sid', g, MAX_MEDIA_CONNS_PER_PLAYER);
    expect(cs[0]?.outcome).toBe('superseded');
    expect(cs[0]?.res.destroy).toHaveBeenCalled();
    expect(cs.slice(1).every((c) => c.outcome === null)).toBe(true);
    expect(g.outcome).toBeNull();
    expect(l.acquire).toHaveBeenCalledTimes(1);
  });

  it('el tope lo pone quien llega: una conexión de escucha (3) recorta un reproductor de video a 3', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const media = ['a', 'b', 'c', 'd', 'e'].map(conn);
    for (const c of media) await leases.acquire('h', 'sid', c, MAX_MEDIA_CONNS_PER_PLAYER);
    const audio = conn('audio');
    const lease = await leases.acquire('h', 'sid', audio);
    expect(lease.conns).toBe(MAX_CONNS_PER_PLAYER);
    expect(media.map((c) => c.outcome)).toEqual(['superseded', 'superseded', 'superseded', null, null]);
    expect(audio.outcome).toBeNull();
  });

  it('leaseRenew en false → un único leaseAcquire adicional', async () => {
    vi.useFakeTimers();
    const l = luaFake({ renew: () => false });
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, renewMs: 100, warn: vi.fn() });
    const lease = await leases.acquire('h', 'sid', conn('a'));
    await vi.advanceTimersByTimeAsync(100);
    expect(l.renew).toHaveBeenCalledTimes(1);
    expect(l.acquire).toHaveBeenCalledTimes(2);
    await lease.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Redis caído al adquirir deja pasar y avisa', async () => {
    const warn = vi.fn();
    const leases = createPreviewLeases(fakeRedis({}), { maxPerIp: 1, warn });
    const lease = await leases.acquire('h', null, conn('a'));
    expect(warn).toHaveBeenCalledWith('preview_lease_unavailable');
    await lease.release();
    expect(warn).toHaveBeenCalledWith('preview_lease_release_failed');
  });

  it('release dos veces → un solo leaseRelease; mismo sid desde dos IP son dos entradas', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const a = await leases.acquire('h1', 'sid', conn('a'));
    await leases.acquire('h2', 'sid', conn('b'));
    expect(leases.size()).toBe(2);
    await a.release();
    await a.release();
    expect(l.release).toHaveBeenCalledTimes(1);
  });

  it('gracia de video: 10 segmentos seguidos del mismo sid → 1 leaseAcquire y 1 leaseRelease solo al vencer la gracia', async () => {
    vi.useFakeTimers();
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    for (let i = 0; i < 10; i++) {
      const lease = await leases.acquire('h', 'sid', conn(`seg${i}`), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
      await lease.release();
      // Hueco con el buffer lleno: el miembro sigue en el ZSET
      await vi.advanceTimersByTimeAsync(20_000);
      expect(l.sets.get('pv:ips:h')?.has('s:sid')).toBe(true);
    }
    expect(l.acquire).toHaveBeenCalledTimes(1);
    expect(l.release).not.toHaveBeenCalled();
    expect(l.renew).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(l.release).toHaveBeenCalledTimes(1);
    expect(l.sets.get('pv:ips:h')?.size).toBe(0);
    expect(leases.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gracia con maxPerIp 1: otro sid recibe TOO_MANY_PREVIEWS durante la gracia y entra al vencer', async () => {
    vi.useFakeTimers();
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 1, warn: vi.fn() });
    const a = await leases.acquire('h', 'A', conn('a1'), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
    await a.release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(code(await leases.acquire('h', 'B', conn('b1')).catch((e) => e))).toBe('TOO_MANY_PREVIEWS');
    // El primer reproductor sigue: su siguiente segmento reutiliza el hueco
    const a2 = await leases.acquire('h', 'A', conn('a2'), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
    expect(l.acquire.mock.calls.filter((c) => c[1] === 's:A')).toHaveLength(1);
    await a2.release();
    await vi.advanceTimersByTimeAsync(45_000);
    const b = await leases.acquire('h', 'B', conn('b2'));
    expect(b.conns).toBe(1);
    await b.release();
    expect(leases.size()).toBe(0);
  });

  it('sin sid no hay gracia; sin gracia (escucha) se suelta en el acto', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const anon = await leases.acquire('h', null, conn('r1'), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
    await anon.release();
    const audio = await leases.acquire('h', 'sid', conn('a'));
    await audio.release();
    expect(l.release).toHaveBeenCalledTimes(2);
    expect(leases.size()).toBe(0);
  });

  it('close suelta los huecos en gracia y las conexiones vivas se sueltan sin gracia al cerrar', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    const idle = await leases.acquire('h', 'idle', conn('i'), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
    await idle.release();
    const live = await leases.acquire('h', 'live', conn('l'), MAX_MEDIA_CONNS_PER_PLAYER, 45_000);
    expect(l.release).not.toHaveBeenCalled();
    await leases.close();
    expect(l.release.mock.calls.map((c) => c[1])).toEqual(['s:idle']);
    await live.release();
    expect(l.release.mock.calls.map((c) => c[1])).toEqual(['s:idle', 's:live']);
    expect(leases.size()).toBe(0);
  });

  it('sin sid el miembro es r:{id}', async () => {
    const l = luaFake();
    const leases = createPreviewLeases(fakeRedis(l.handlers), { maxPerIp: 4, warn: vi.fn() });
    await leases.acquire('h', null, conn('req-1'));
    expect(l.acquire.mock.calls[0]?.[1]).toBe('r:req-1');
    expect(l.acquire.mock.calls[0]?.[0]).toBe('pv:ips:h');
  });
});

describe('withDeadline', () => {
  it('el plazo da UPSTREAM_TIMEOUT y la sesión DOWNLOAD_INTERRUPTED', async () => {
    const pending = new Promise<never>(() => undefined);
    const d1 = createDeadline(30);
    expect(code(await withDeadline(pending, d1, new AbortController().signal).catch((e) => e))).toBe('UPSTREAM_TIMEOUT');
    const d2 = createDeadline(10_000);
    const ac = new AbortController();
    const p = withDeadline(pending, d2, ac.signal);
    ac.abort();
    expect(code(await p.catch((e) => e))).toBe('DOWNLOAD_INTERRUPTED');
    d2.clear();
  });

  it('resuelve con el valor y propaga el error de la operación', async () => {
    const d = createDeadline(10_000);
    const s = new AbortController().signal;
    expect(await withDeadline(Promise.resolve(7), d, s)).toBe(7);
    expect(code(await withDeadline(Promise.reject(new AppError('LIMIT_DURATION')), d, s).catch((e) => e))).toBe('LIMIT_DURATION');
    d.clear();
  });
});
