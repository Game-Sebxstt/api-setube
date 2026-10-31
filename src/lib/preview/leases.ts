import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import { scripts } from '../jobs/lua.js';
import type { PreviewConn } from './types.js';

export const pvIpsKey = (ipHash: string) => `pv:ips:${ipHash}`;
// Conexiones simultáneas de un mismo reproductor antes de cortar la más antigua (superseded).
// Escucha: un <audio> y algún salto. Video: segmento de video + de audio + cambio de calidad o salto en curso.
export const MAX_CONNS_PER_PLAYER = 3;
export const MAX_MEDIA_CONNS_PER_PLAYER = 6;
// Video: cada segmento es una petición corta y el reproductor deja de pedir con el buffer lleno (~30 s) o en pausa.
// El hueco del reproductor se conserva este tiempo tras su última conexión para que otro no lo ocupe a mitad del video.
export const MEDIA_LEASE_GRACE_MS = 45_000;

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
  key: string;
  member: string;
  conns: PreviewConn[];
  /** Renovación del miembro en Redis (sigue activa durante la gracia). */
  timer?: NodeJS.Timeout;
  /** Gracia en curso: al vencer se suelta el hueco. */
  grace?: NodeJS.Timeout;
  /** La mayor gracia pedida por las conexiones del reproductor (0: se suelta al cerrar la última). */
  graceMs: number;
  ready: Promise<boolean>;
}

// Un hueco por reproductor (sid) e IP en Redis; las conexiones del mismo reproductor se cuentan en memoria
export function createPreviewLeases(redis: Redis, o: PreviewLeaseOpts) {
  const s = scripts(redis);
  const leaseMs = o.leaseMs ?? 30_000;
  const renewMs = o.renewMs ?? 10_000;
  const entries = new Map<string, Entry>();
  let closing = false;

  const forgetEntry = (mapKey: string, e: Entry) => {
    if (entries.get(mapKey) === e) entries.delete(mapKey);
    clearInterval(e.timer);
    clearTimeout(e.grace);
    e.grace = undefined;
  };

  const releaseEntry = async (mapKey: string, e: Entry) => {
    forgetEntry(mapKey, e);
    try {
      await s.leaseRelease(e.key, e.member);
    } catch {
      o.warn('preview_lease_release_failed');
    }
  };

  // maxConns: tope de conexiones del reproductor que aplica quien llega (las del mismo sid comparten la cuenta).
  // graceMs: tiempo que se conserva el hueco tras la última conexión (solo con sid; una conexión nueva lo reutiliza).
  async function acquire(
    ipHash: string,
    sid: string | null,
    conn: PreviewConn,
    maxConns = MAX_CONNS_PER_PLAYER,
    graceMs = 0,
  ): Promise<PreviewLease> {
    const member = sid ? `s:${sid}` : `r:${conn.id}`;
    const key = pvIpsKey(ipHash);
    const mapKey = `${ipHash}|${member}`;
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = {
        key,
        member,
        conns: [],
        graceMs: 0,
        ready: s.leaseAcquire(key, member, leaseMs, o.maxPerIp).catch(() => {
          o.warn('preview_lease_unavailable');
          return true;
        }),
      };
      entries.set(mapKey, entry);
    }
    const e = entry;
    if (e.grace) {
      // El reproductor vuelve dentro de la gracia: conserva su hueco sin pasar por Redis
      clearTimeout(e.grace);
      e.grace = undefined;
    }
    if (sid) e.graceMs = Math.max(e.graceMs, graceMs);
    e.conns.push(conn);

    // 'release': hay que soltar el hueco en Redis; 'keep': sigue en uso, en gracia o ya no es de esta entrada
    const drop = (granted: boolean): 'release' | 'keep' => {
      const i = e.conns.indexOf(conn);
      if (i >= 0) e.conns.splice(i, 1);
      if (e.conns.length > 0 || entries.get(mapKey) !== e) return 'keep';
      if (!granted) {
        forgetEntry(mapKey, e);
        return 'keep';
      }
      if (e.graceMs > 0 && !closing) {
        e.grace = setTimeout(() => {
          e.grace = undefined;
          if (e.conns.length === 0 && entries.get(mapKey) === e) void releaseEntry(mapKey, e);
        }, e.graceMs);
        e.grace.unref?.();
        return 'keep';
      }
      return 'release';
    };

    if (!(await e.ready)) {
      drop(false);
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

    while (e.conns.length > Math.max(1, maxConns)) {
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
        if (drop(true) === 'release') await releaseEntry(mapKey, e);
      },
    };
  }

  // Apagado: suelta ya los huecos en gracia; los que siguen en uso se sueltan sin gracia al cerrar su última conexión
  async function close(): Promise<void> {
    closing = true;
    const idle = [...entries].filter(([, e]) => e.conns.length === 0 && e.grace);
    await Promise.all(idle.map(([mapKey, e]) => releaseEntry(mapKey, e)));
  }

  return { acquire, close, size: () => entries.size };
}

export type PreviewLeases = ReturnType<typeof createPreviewLeases>;
