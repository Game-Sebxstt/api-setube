import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import { ipsKey, LOCK_TTL_MS, scripts, subsKey } from './lua.js';

export interface StreamLeaseOpts {
  redis: Redis;
  jobId: string;
  streamId: string;
  ipHash: string;
  maxPerIp: number;
  slotLeaseMs: number;
  onLockLost: () => void;
  log?: { warn(obj: object, msg: string): void };
  lockTtlMs?: number;
  heartbeatMs?: number;
}

export interface StreamLeases {
  release(): Promise<void>;
}

export async function acquireStreamLeases(o: StreamLeaseOpts): Promise<StreamLeases> {
  const s = scripts(o.redis);
  const lockTtl = o.lockTtlMs ?? LOCK_TTL_MS;
  if (!(await s.lockAcquire(o.jobId, o.streamId, lockTtl))) throw new AppError('JOB_BUSY');
  const ipKey = ipsKey(o.ipHash);
  let ipOk: boolean;
  try {
    ipOk = await s.leaseAcquire(ipKey, o.streamId, o.slotLeaseMs, o.maxPerIp);
  } catch (e) {
    await s.lockRelease(o.jobId, o.streamId).catch(() => undefined);
    throw e;
  }
  if (!ipOk) {
    await s.lockRelease(o.jobId, o.streamId).catch(() => undefined);
    throw new AppError('TOO_MANY_STREAMS');
  }

  let lost = false;
  const beat = setInterval(async () => {
    try {
      if (!(await s.lockRenew(o.jobId, o.streamId, lockTtl))) {
        if (!lost) {
          lost = true;
          clearInterval(beat);
          o.onLockLost();
        }
        return;
      }
      if (!(await s.leaseRenew(ipKey, o.streamId, o.slotLeaseMs))) {
        // Se perdió (reinicio de Redis): reintento; si otro ocupó el hueco se acepta el sobrecompromiso
        if (!(await s.leaseAcquire(ipKey, o.streamId, o.slotLeaseMs, o.maxPerIp))) o.log?.warn({ jobId: o.jobId }, 'lease_lost');
      }
    } catch (err) {
      o.log?.warn({ err: { message: (err as Error).message } }, 'stream_lease_renew_failed');
    }
  }, o.heartbeatMs ?? 10_000);
  beat.unref?.();

  let released: Promise<void> | null = null;
  return {
    release: () => {
      released ??= (async () => {
        clearInterval(beat);
        await Promise.allSettled([s.lockRelease(o.jobId, o.streamId), s.leaseRelease(ipKey, o.streamId)]);
      })();
      return released;
    },
  };
}

export const SUBS_LEASE_MS = 60_000;

export const subsLeases = (redis: Redis) => {
  const s = scripts(redis);
  return {
    acquire: (jobId: string, connId: string, limit: number) => s.leaseAcquire(subsKey(jobId), connId, SUBS_LEASE_MS, limit),
    renew: (jobId: string, connId: string) => s.leaseRenew(subsKey(jobId), connId, SUBS_LEASE_MS),
    release: (jobId: string, connId: string) => s.leaseRelease(subsKey(jobId), connId),
  };
};
