import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import type { Config } from '../config/env.js';

export function headerIp(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && isIP(v) !== 0 ? v : null;
}

export function clientIp(req: { ip: string; headers: IncomingHttpHeaders }, config: Pick<Config, 'clientIpHeader'>): string {
  if (!config.clientIpHeader) return req.ip;
  return headerIp(req.headers, config.clientIpHeader) ?? req.ip;
}

function expandV6(ip: string): number[] | null {
  const [head = '', tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const part = (s: string) => (s === '' ? [] : s.split(':'));
  const toNums = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of groups) {
      if (g.includes('.')) {
        const o = g.split('.').map(Number);
        if (o.length !== 4) return null;
        out.push(((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0));
      } else out.push(parseInt(g, 16));
    }
    return out;
  };
  const h = toNums(part(head));
  const t = tail === undefined ? [] : toNums(part(tail));
  if (!h || !t) return null;
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...new Array<number>(fill).fill(0), ...t];
}

// IPv6 se agrupa por /64 (una conexión doméstica suele tener un /64 entero); IPv4 mapeada pasa a IPv4
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped?.[1]) return mapped[1];
  if (isIP(v) !== 6) return v;
  const g = expandV6(v.split('%')[0] as string);
  if (!g || g.length !== 8) return v;
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

export function ipHash(ip: string, salt: string): string {
  return createHash('sha256').update(salt + normalizeIp(ip)).digest('hex').slice(0, 16);
}
