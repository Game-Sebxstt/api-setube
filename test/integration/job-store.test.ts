import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctlChannel, evChannel, jobKey, lockKey } from '../../src/lib/jobs/lua.js';
import {
  archiveQueue, cancelJob, computeOverall, createJob, readJob, rejectJob, updateItem, type ItemState,
} from '../../src/lib/jobs/store.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

let t: TestRedis;
beforeAll(async () => {
  t = await createTestRedis();
});
afterAll(async () => {
  await t.cleanup();
});

const V = 'jNQXAC9IVRw';
const LEASE = { slotLeaseMs: 30_000 };

async function newJob(n = 2, validation: number[] = []) {
  const jobId = randomUUID();
  const { items } = await createJob(t.redis, {
    jobId, format: 'mp3', quality: 192, ipHash: 'abc', ttlSec: 600,
    items: Array.from({ length: n }, (_, i) => ({
      videoId: V, title: `t${i}`, duration: 19, durationVerified: true,
      ...(validation.includes(i) ? { validationError: 'LIMIT_DURATION' as const } : {}),
    })),
  });
  return { jobId, items };
}

async function listen(channel: string) {
  const sub = t.subscriber.duplicate();
  const msgs: string[] = [];
  sub.on('message', (_c: string, m: string) => msgs.push(m));
  await sub.subscribe(channel);
  return { msgs, close: () => sub.quit() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('job store', () => {
  it('UPDATE_ITEM incrementa seq, escribe y publica {id, event, data, overall}', async () => {
    const { jobId, items } = await newJob(2);
    const l = await listen(evChannel(jobId));
    const it0 = items[0] as ItemState;
    const overall = computeOverall(items, true);
    const seq = await updateItem(t.redis, jobId, { ...it0, status: 'downloading', pct: 12.5, phase: 'download' }, 'downloading', overall, 600);
    expect(seq).toBe(1);
    await sleep(50);
    const msg = JSON.parse(l.msgs[0] as string);
    expect(msg).toMatchObject({ id: 1, event: 'downloading', data: { itemId: 'i0', status: 'downloading', pct: 12.5 }, overall: { total: 2 } });
    const view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.seq).toBe(1);
    expect(view?.snapshot.items[0]).toMatchObject({ status: 'downloading', pct: 12.5 });
    await l.close();
  });

  it('snapshot y seq atómicos (SNAPSHOT devuelve hash + PTTL + lock en una llamada)', async () => {
    const { jobId, items } = await newJob(1);
    const o = computeOverall(items, true);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => updateItem(t.redis, jobId, { ...(items[0] as ItemState), status: 'downloading', pct: i }, 'downloading', o, 600)),
    );
    const view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.seq).toBe(10);
    expect(new Date(view!.snapshot.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(view?.snapshot.overall.active).toBe(false);
  });

  it('CANCEL_JOB: pending → canceled, publica canceled + cancel, e idempotente', async () => {
    const { jobId, items } = await newJob(3);
    await updateItem(t.redis, jobId, { ...(items[1] as ItemState), status: 'done', pct: 100 }, 'done', computeOverall(items, true), 600);
    const ev = await listen(evChannel(jobId));
    const ctl = await listen(ctlChannel(jobId));
    expect(await cancelJob(t.redis, jobId, 600)).toBe(1);
    expect(await cancelJob(t.redis, jobId, 600)).toBe(2);
    await sleep(50);
    expect(ctl.msgs).toEqual(['cancel']);
    expect(ev.msgs).toHaveLength(1);
    const m = JSON.parse(ev.msgs[0] as string);
    expect(m).toMatchObject({ event: 'canceled', data: { jobId, overall: { total: 3, done: 1, pct: 100 } } });
    const view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.status).toBe('canceled');
    expect(view?.snapshot.items.map((i) => i.status)).toEqual(['canceled', 'done', 'canceled']);
    await ev.close();
    await ctl.close();
  });

  it('un job expirado devuelve 0 (UPDATE_ITEM, REJECT_JOB, CANCEL_JOB) y null en SNAPSHOT', async () => {
    const jobId = randomUUID();
    const fake = { itemId: 'i0', videoId: V, title: null, duration: null, durationVerified: false, status: 'queued', pct: 0, speedBps: null, etaSec: null, position: 1, bytesSent: 0, attempt: 1, updatedAt: Date.now() } as const;
    expect(await updateItem(t.redis, jobId, fake, 'queued', computeOverall([], true), 600)).toBe(0);
    expect(await rejectJob(t.redis, jobId, { code: 'JOB_BUSY' }, 600)).toBe(0);
    expect(await cancelJob(t.redis, jobId, 600)).toBe(0);
    expect(await readJob(t.redis, jobId, LEASE)).toBeNull();
    expect(await t.redis.exists(jobKey(jobId))).toBe(0);
  });

  it('errorKind: createJob guarda validation; updateItem error → runtime; error → fetching lo borra', async () => {
    const { jobId, items } = await newJob(2, [1]);
    let view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.items[1]).toMatchObject({ status: 'error', errorKind: 'validation', error: { code: 'LIMIT_DURATION' } });
    expect(view?.snapshot.items[0]).not.toHaveProperty('errorKind');
    const o = computeOverall(items, true);
    await updateItem(t.redis, jobId, { ...(items[0] as ItemState), status: 'error', error: { code: 'UPSTREAM_TIMEOUT', message: 'x' }, errorKind: 'runtime' }, 'error', o, 600);
    view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.items[0]).toMatchObject({ status: 'error', errorKind: 'runtime' });
    await updateItem(t.redis, jobId, { ...(view!.raw.i0 as ItemState), status: 'fetching', attempt: 2 } as never, 'fetching', o, 600);
    view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.items[0]).toMatchObject({ status: 'fetching', attempt: 2 });
    expect(view?.snapshot.items[0]).not.toHaveProperty('errorKind');
    expect(view?.snapshot.items[0]).not.toHaveProperty('error');
  });

  it('cola de /archive sobre un snapshot real: done, runtime y pending en orden; todo validation → vacía', async () => {
    const { jobId, items } = await newJob(5, [1]);
    const o = computeOverall(items, true);
    const [i0, , i2, i3] = items as ItemState[];
    await updateItem(t.redis, jobId, { ...i0!, status: 'done', pct: 100 }, 'done', o, 600);
    await updateItem(t.redis, jobId, { ...i2!, status: 'error', error: { code: 'STALLED', message: 'x' }, errorKind: 'runtime' }, 'error', o, 600);
    await updateItem(t.redis, jobId, { ...i3!, status: 'canceled' }, 'canceled', o, 600);
    const view = await readJob(t.redis, jobId, LEASE);
    expect(archiveQueue(view!.snapshot.items).map((i) => i.itemId)).toEqual(['i0', 'i2', 'i4']);
    const all = await newJob(2, [0, 1]);
    const v2 = await readJob(t.redis, all.jobId, LEASE);
    expect(archiveQueue(v2!.snapshot.items)).toEqual([]);
  });

  it('REJECT_JOB guarda lastReject, incrementa seq, publica rejected y no toca it:*', async () => {
    const { jobId } = await newJob(1);
    const before = await t.redis.hget(jobKey(jobId), 'it:i0');
    const l = await listen(evChannel(jobId));
    expect(await rejectJob(t.redis, jobId, { code: 'JOB_BUSY', itemId: 'i0' }, 600)).toBe(1);
    await sleep(50);
    expect(JSON.parse(l.msgs[0] as string)).toMatchObject({ id: 1, event: 'rejected', data: { code: 'JOB_BUSY', itemId: 'i0' } });
    const view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.lastReject).toMatchObject({ code: 'JOB_BUSY', itemId: 'i0', message: expect.any(String), at: expect.any(String) });
    expect(view?.snapshot.seq).toBe(1);
    expect(await t.redis.hget(jobKey(jobId), 'it:i0')).toBe(before);
    await l.close();
  });

  it('chequeo perezoso: downloading viejo sin lock → stale sin modificar el hash; pending viejo no; con lock tampoco', async () => {
    const { jobId, items } = await newJob(2);
    const old = Date.now() - 120_000;
    const o = computeOverall(items, false);
    await updateItem(t.redis, jobId, { ...(items[0] as ItemState), status: 'downloading', pct: 30, phase: 'download', updatedAt: old }, 'downloading', o, 600);
    await updateItem(t.redis, jobId, { ...(items[1] as ItemState), status: 'pending', updatedAt: old }, 'pending', o, 600);
    const raw = await t.redis.hget(jobKey(jobId), 'it:i0');
    let view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.items[0]).toMatchObject({ status: 'error', error: { code: 'SERVER_SHUTDOWN' }, errorKind: 'runtime', stale: true });
    expect(view?.snapshot.items[1]).toMatchObject({ status: 'pending' });
    expect(view?.snapshot.items[1]).not.toHaveProperty('stale');
    expect(await t.redis.hget(jobKey(jobId), 'it:i0')).toBe(raw);
    await t.redis.set(lockKey(jobId), 'otro', 'PX', 5000);
    view = await readJob(t.redis, jobId, LEASE);
    expect(view?.snapshot.items[0]).toMatchObject({ status: 'downloading' });
    expect(view?.snapshot.overall.active).toBe(true);
  });
});
