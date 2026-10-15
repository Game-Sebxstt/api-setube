import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { createPreviewLeases, pvIpsKey } from '../../src/lib/preview/leases.js';
import type { PreviewConn } from '../../src/lib/preview/types.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

let t: TestRedis;
beforeAll(async () => {
  t = await createTestRedis();
});
afterAll(async () => {
  await t.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = (): PreviewConn => ({ id: randomUUID(), abort: new AbortController(), res: { destroyed: false, destroy() {} }, outcome: null });
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
const sid = () => randomUUID().replaceAll('-', '');

describe('leases de escucha con los Lua reales', () => {
  it('maxPerIp 4: 5 reproductores distintos → 4 éxitos y TOO_MANY_PREVIEWS; liberar deja el ZSET vacío', async () => {
    const h = `ip-${randomUUID()}`;
    const leases = createPreviewLeases(t.redis, { maxPerIp: 4, warn: () => undefined });
    const ok = [];
    for (let i = 0; i < 4; i++) ok.push(await leases.acquire(h, sid(), conn()));
    expect(code(await leases.acquire(h, sid(), conn()).catch((e) => e))).toBe('TOO_MANY_PREVIEWS');
    expect(await t.redis.zcard(pvIpsKey(h))).toBe(4);
    for (const l of ok) await l.release();
    expect(await t.redis.zcard(pvIpsKey(h))).toBe(0);
  });

  it('el mismo sid repetido ocupa un solo hueco', async () => {
    const h = `ip-${randomUUID()}`;
    const s = sid();
    const a = createPreviewLeases(t.redis, { maxPerIp: 4, warn: () => undefined });
    const b = createPreviewLeases(t.redis, { maxPerIp: 4, warn: () => undefined });
    const l1 = await a.acquire(h, s, conn());
    const l2 = await a.acquire(h, s, conn());
    const l3 = await b.acquire(h, s, conn());
    expect(await t.redis.zcard(pvIpsKey(h))).toBe(1);
    await Promise.all([l1.release(), l2.release(), l3.release()]);
    expect(await t.redis.zcard(pvIpsKey(h))).toBe(0);
  });

  it('la renovación mantiene vivo el miembro más allá del lease', async () => {
    const h = `ip-${randomUUID()}`;
    const leases = createPreviewLeases(t.redis, { maxPerIp: 1, leaseMs: 300, renewMs: 100, warn: () => undefined });
    const l = await leases.acquire(h, sid(), conn());
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      expect(await t.redis.zcard(pvIpsKey(h))).toBe(1);
      await sleep(150);
    }
    await l.release();
    expect(await t.redis.zcard(pvIpsKey(h))).toBe(0);
  });
});
