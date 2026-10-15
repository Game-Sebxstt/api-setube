import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { SEM_KEYS, scripts } from '../../src/lib/jobs/lua.js';
import { Semaphore, type SemaphoreOpts } from '../../src/lib/jobs/semaphore.js';
import { PubSub } from '../../src/lib/pubsub.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

let t: TestRedis;
let pubsub: PubSub;
beforeEach(async () => {
  t = await createTestRedis();
  pubsub = new PubSub(t.subscriber);
});
afterEach(async () => {
  await t.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sem = (o: Partial<SemaphoreOpts> = {}) =>
  new Semaphore({
    redis: t.redis, pubsub, slots: 3, holdLeaseMs: 30_000, waitLeaseMs: 20_000, queueMax: 200, waitTimeoutMs: 10_000,
    pollMs: 40, pollJitterMs: 10, ...o,
  });

describe('Semaphore', () => {
  it('3 slots y 10 acquirers concurrentes: nunca más de 3 holders (muestreo con ZCARD)', async () => {
    const s = sem();
    let max = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        max = Math.max(max, await t.redis.zcard(SEM_KEYS.holders));
        await sleep(5);
      }
    })();
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const h = await s.acquire(`tk-${i}`);
        await sleep(40 + Math.random() * 60);
        await h.release();
      }),
    );
    sampling = false;
    await sampler;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(3);
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
    expect(await t.redis.zcard(SEM_KEYS.queue)).toBe(0);
  });

  it('orden FIFO por ticket', async () => {
    const s = sem({ slots: 1 });
    const a = await s.acquire('A');
    const order: string[] = [];
    const waiters = ['B', 'C', 'D'].map((tk, i) =>
      sleep(i * 30).then(async () => {
        const h = await s.acquire(tk);
        order.push(tk);
        await sleep(20);
        await h.release();
      }),
    );
    await sleep(150);
    await a.release();
    await Promise.all(waiters);
    expect(order).toEqual(['B', 'C', 'D']);
  });

  it('un holder que deja de renovar (lease 300 ms) libera el slot sin intervención', async () => {
    const dead = sem({ slots: 1, holdLeaseMs: 300, renewMs: 60_000 });
    await dead.acquire('muerto');
    const t0 = Date.now();
    const h = await sem({ slots: 1, holdLeaseMs: 300 }).acquire('vivo');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    await h.release();
  });

  it('un waiter que deja de renovar sale de la cola', async () => {
    const s = scripts(t.redis);
    const holder = await sem({ slots: 1 }).acquire('H');
    expect(await s.semAcquire('W', 1, 30_000, 300, 200)).toEqual([0, 1]);
    expect(await t.redis.zscore(SEM_KEYS.queue, 'W')).not.toBeNull();
    await sleep(400);
    expect(await s.semAcquire('X', 1, 30_000, 20_000, 200)).toEqual([0, 1]);
    expect(await t.redis.zscore(SEM_KEYS.queue, 'W')).toBeNull();
    await s.semRelease('X');
    await holder.release();
  });

  it('release idempotente', async () => {
    const h = await sem().acquire('R');
    await h.release();
    await h.release();
    await scripts(t.redis).semRelease('nunca-existio');
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
  });

  it('posiciones 1..N correctas', async () => {
    const s = scripts(t.redis);
    const holder = await sem({ slots: 1 }).acquire('H');
    const pos = [];
    for (const tk of ['W1', 'W2', 'W3']) pos.push((await s.semAcquire(tk, 1, 30_000, 20_000, 200))[1]);
    expect(pos).toEqual([1, 2, 3]);
    expect(await s.semAcquire('W2', 1, 30_000, 20_000, 200)).toEqual([0, 2]);
    const seen: number[] = [];
    const p = sem({ slots: 1, waitTimeoutMs: 150 }).acquire('W4', { onPosition: (n) => seen.push(n) }).catch((e) => e);
    expect(await p).toBeInstanceOf(AppError);
    expect(seen[0]).toBe(4);
    await holder.release();
  });

  it('QUEUE_FULL', async () => {
    const s = scripts(t.redis);
    const holder = await sem({ slots: 1 }).acquire('H');
    await s.semAcquire('Q1', 1, 30_000, 20_000, 2);
    await s.semAcquire('Q2', 1, 30_000, 20_000, 2);
    const err = await sem({ slots: 1, queueMax: 2 }).acquire('Q3').catch((e: AppError) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('QUEUE_FULL');
    await holder.release();
  });

  it('timeout de espera → QUEUE_TIMEOUT y el ticket sale de la cola', async () => {
    const holder = await sem({ slots: 1 }).acquire('H');
    const t0 = Date.now();
    const err = await sem({ slots: 1, waitTimeoutMs: 300 }).acquire('T').catch((e: AppError) => e);
    expect((err as AppError).code).toBe('QUEUE_TIMEOUT');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(await t.redis.zscore(SEM_KEYS.queue, 'T')).toBeNull();
    await holder.release();
  });

  it('abort durante la espera: rechaza con el motivo y libera el ticket', async () => {
    const holder = await sem({ slots: 1 }).acquire('H');
    const ac = new AbortController();
    const p = sem({ slots: 1 }).acquire('Z', { signal: ac.signal }).catch((e) => e);
    await sleep(80);
    ac.abort('canceled');
    expect(await p).toBe('canceled');
    expect(await t.redis.zscore(SEM_KEYS.queue, 'Z')).toBeNull();
    await holder.release();
  });
});
