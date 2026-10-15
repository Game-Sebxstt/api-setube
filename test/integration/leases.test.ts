import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { acquireStreamLeases, subsLeases } from '../../src/lib/jobs/leases.js';
import { ipsKey, lockKey, scripts } from '../../src/lib/jobs/lua.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

let t: TestRedis;
beforeAll(async () => {
  t = await createTestRedis();
});
afterAll(async () => {
  await t.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = { lockTtlMs: 300, slotLeaseMs: 300, heartbeatMs: 100 };

const lease = (jobId: string, ipHash: string, extra: { onLockLost?: () => void; maxPerIp?: number } = {}) =>
  acquireStreamLeases({
    redis: t.redis, jobId, streamId: randomUUID(), ipHash, maxPerIp: extra.maxPerIp ?? 1,
    onLockLost: extra.onLockLost ?? (() => undefined), ...FAST,
  });

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

describe('leases de stream', () => {
  it('el heartbeat mantiene lock e ips vivos 1,5 s (lease 300 ms); otro stream recibe JOB_BUSY y la IP sigue contando', async () => {
    const job = randomUUID();
    const other = randomUUID();
    const ip = 'ip-hb';
    const a = await lease(job, ip);
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      expect(code(await lease(job, 'otra-ip').catch((e) => e))).toBe('JOB_BUSY');
      expect(code(await lease(other, ip).catch((e) => e))).toBe('TOO_MANY_STREAMS');
      expect(await t.redis.exists(lockKey(job))).toBe(1);
      expect(await t.redis.zcard(ipsKey(ip))).toBe(1);
      await sleep(150);
    }
    await a.release();
    expect(await t.redis.exists(lockKey(job))).toBe(0);
    expect(await t.redis.zcard(ipsKey(ip))).toBe(0);
    const b = await lease(other, ip);
    await b.release();
  });

  it('sin heartbeat el lock expira solo (crash)', async () => {
    const job = randomUUID();
    expect(await scripts(t.redis).lockAcquire(job, 'x', 200)).toBe(true);
    await sleep(300);
    expect(await t.redis.exists(lockKey(job))).toBe(0);
  });

  it('LOCK_RENEW con otro streamId devuelve 0 y dispara abort(lock_lost)', async () => {
    const job = randomUUID();
    const onLockLost = vi.fn();
    const a = await lease(job, 'ip-lost', { onLockLost });
    expect(await scripts(t.redis).lockRenew(job, 'otro-stream', 300)).toBe(false);
    await t.redis.set(lockKey(job), 'otro-stream', 'PX', 5000);
    await sleep(250);
    expect(onLockLost).toHaveBeenCalledTimes(1);
    await a.release();
    expect(await t.redis.get(lockKey(job))).toBe('otro-stream');
  });

  it('job:{id}:subs con SSE_MAX_PER_JOB=2 y 5 LEASE_ACQUIRE concurrentes: exactamente 2 éxitos', async () => {
    const job = randomUUID();
    const subs = subsLeases(t.redis);
    const r = await Promise.all(Array.from({ length: 5 }, (_, i) => subs.acquire(job, `c${i}`, 2)));
    expect(r.filter(Boolean)).toHaveLength(2);
    const winner = `c${r.indexOf(true)}`;
    expect(await subs.renew(job, winner)).toBe(true);
    expect(await subs.renew(job, 'c-perdido')).toBe(false);
    await subs.release(job, winner);
    expect(await subs.acquire(job, 'nuevo', 2)).toBe(true);
  });
});
