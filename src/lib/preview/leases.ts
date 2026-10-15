import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import { scripts } from '../jobs/lua.js';
import type { PreviewConn } from './types.js';

export const pvIpsKey = (ipHash: string) => `pv:ips:${ipHash}`;
export const MAX_CONNS_PER_PLAYER = 3;

export interface PreviewLease {
  release(): Promise<void>;
  conns: number;
}

export interface PreviewLeaseOpts {
  maxPerIp: number;
  leaseMs?: number;
  renewMs?: number;
  warn: (msg: string, obj?: object) => void;
}

interface Entry {
  conns: PreviewConn[];
  timer?: NodeJS.Timeout;
  ready: Promise<boolean>;
}

// Un hueco por reproductor (sid) e IP en Redis; las conexiones del mismo reproductor se cuentan en memoria
export function createPreviewLeases(redis: Redis, o: PreviewLeaseOpts) {
  const s = scripts(redis);
  const leaseMs = o.leaseMs ?? 30_000;
  const renewMs = o.renewMs ?? 10_000;
  const entries = new Map<string, Entry>();

  async function acquire(ipHash: string, sid: string | null, conn: PreviewConn): Promise<PreviewLease> {
    const member = sid ? `s:${sid}` : `r:${conn.id}`;
    const key = pvIpsKey(ipHash);
    const mapKey = `${ipHash}|${member}`;
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = {
        conns: [],
        ready: s.leaseAcquire(key, member, leaseMs, o.maxPerIp).catch(() => {
          o.warn('preview_lease_unavailable');
          return true;
        }),
      };
      entries.set(mapKey, entry);
    }
    const e = entry;
    e.conns.push(conn);

    const drop = () => {
      const i = e.conns.indexOf(conn);
      if (i >= 0) e.conns.splice(i, 1);
      if (e.conns.length > 0 || entries.get(mapKey) !== e) return false;
      entries.delete(mapKey);
      clearInterval(e.timer);
      return true;
    };

    if (!(await e.ready)) {
      drop();
      throw new AppError('TOO_MANY_PREVIEWS');
    }

    if (!e.timer && entries.get(mapKey) === e) {
      e.timer = setInterval(async () => {
        try {
          if (await s.leaseRenew(key, member, leaseMs)) return;
          // Se perdió (reinicio o expiración): un reintento; si otro ocupó el hueco se acepta el sobrecompromiso
          if (!(await s.leaseAcquire(key, member, leaseMs, o.maxPerIp))) o.warn('preview_lease_lost');
        } catch {
          o.warn('preview_lease_renew_failed');
        }
      }, renewMs);
      e.timer.unref?.();
    }

    while (e.conns.length > MAX_CONNS_PER_PLAYER) {
      const old = e.conns.shift() as PreviewConn;
      old.outcome ??= 'superseded';
      old.abort.abort();
      if (!old.res.destroyed) old.res.destroy();
    }

    let released = false;
    return {
      conns: e.conns.length,
      async release() {
        if (released) return;
        released = true;
        if (!drop()) return;
        try {
          await s.leaseRelease(key, member);
        } catch {
          o.warn('preview_lease_release_failed');
        }
      },
    };
  }

  return { acquire, size: () => entries.size };
}

export type PreviewLeases = ReturnType<typeof createPreviewLeases>;
