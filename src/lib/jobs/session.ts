import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import type { Lifecycle } from '../lifecycle.js';
import type { PubSub } from '../pubsub.js';
import { acquireStreamLeases, type StreamLeases } from './leases.js';
import { ctlChannel, jobKey } from './lua.js';
import { Reporter } from './reporter.js';
import type { JobView } from './store.js';

export interface SessionOpts {
  redis: Redis;
  pubsub: PubSub;
  lifecycle: Lifecycle;
  log: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  view: JobView;
  jobId: string;
  ipHash: string;
  maxPerIp: number;
  slotLeaseMs: number;
  jobTtlSec: number;
  lockTtlMs?: number;
  heartbeatMs?: number;
  throttleMs?: number;
}

export interface Session {
  readonly streamId: string;
  readonly signal: AbortSignal;
  readonly reporter: Reporter;
  abort(reason: string): void;
  onAbort(fn: (reason: string) => void): void;
  isCanceled(): Promise<boolean>;
  close(): Promise<void>;
}

export async function openSession(o: SessionOpts): Promise<Session> {
  const streamId = randomUUID();
  const controller = new AbortController();
  const hooks: ((reason: string) => void)[] = [];
  const abort = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    for (const h of hooks) {
      try {
        h(reason);
      } catch {
        /* hook defensivo */
      }
    }
  };

  const items = o.view.meta.itemIds.flatMap((id) => (o.view.raw[id] ? [o.view.raw[id]] : []));
  const reporter = new Reporter({
    redis: o.redis,
    jobId: o.jobId,
    ttlSec: o.jobTtlSec,
    items,
    log: o.log,
    onExpired: () => abort('JOB_NOT_FOUND'),
    throttleMs: o.throttleMs,
  });

  const leases: StreamLeases = await acquireStreamLeases({
    redis: o.redis,
    jobId: o.jobId,
    streamId,
    ipHash: o.ipHash,
    maxPerIp: o.maxPerIp,
    slotLeaseMs: o.slotLeaseMs,
    lockTtlMs: o.lockTtlMs,
    heartbeatMs: o.heartbeatMs,
    log: o.log,
    onLockLost: () => {
      reporter.disable();
      o.log.error({ jobId: o.jobId, streamId }, 'lock_lost');
      abort('lock_lost');
    },
  });

  let unsubscribe: () => Promise<void>;
  try {
    unsubscribe = await o.pubsub.subscribe(ctlChannel(o.jobId), (msg) => {
      if (msg === 'cancel') abort('canceled');
    });
  } catch (e) {
    await leases.release();
    throw new AppError('SERVICE_UNAVAILABLE', { cause: e });
  }

  const isCanceled = async () => {
    if (controller.signal.aborted && controller.signal.reason === 'canceled') return true;
    try {
      const canceled = (await o.redis.hget(jobKey(o.jobId), 'status')) === 'canceled';
      if (canceled) abort('canceled');
      return canceled;
    } catch {
      return false;
    }
  };

  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  o.lifecycle.trackStream({ abort, finished });

  // Carrera: un cancel publicado antes de suscribirse se ve al releer el status
  await isCanceled();

  let closing: Promise<void> | null = null;
  return {
    streamId,
    signal: controller.signal,
    reporter,
    abort,
    onAbort: (fn) => {
      hooks.push(fn);
      if (controller.signal.aborted) fn(String(controller.signal.reason));
    },
    isCanceled,
    close: () => {
      closing ??= (async () => {
        await reporter.flush();
        await Promise.allSettled([leases.release(), unsubscribe()]);
        resolveFinished();
      })();
      return closing;
    },
  };
}
