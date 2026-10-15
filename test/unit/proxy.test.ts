import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { proxyStartupWarnings } from '../../src/app.js';
import { buildFakeApp, ORIGIN } from './helpers/fake-app.js';

function memLog() {
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      raw.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  return { raw, stream, msgs: (m: string) => raw.filter((l) => (JSON.parse(l) as { msg: string }).msg === m) };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('IP del cliente detrás de proxies', () => {
  it('proxy_hops_seen una sola vez, sin IPs; client_ip_header_missing si falta la cabecera', async () => {
    const log = memLog();
    app = await buildFakeApp({}, { logger: { stream: log.stream } }, { LOG_LEVEL: 'info', CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    await app.inject({ method: 'GET', url: '/api/config', headers: { 'cf-connecting-ip': '198.51.100.23', 'x-forwarded-for': '198.51.100.23, 10.0.0.2' } });
    await app.inject({ method: 'GET', url: '/api/config' });
    const hops = log.msgs('proxy_hops_seen');
    expect(hops).toHaveLength(1);
    expect(JSON.parse(hops[0] as string)).toMatchObject({ xffEntries: 2, cfConnectingIp: true, clientIpHeader: 'cf-connecting-ip' });
    expect(hops[0]).not.toContain('198.51.100.23');
    expect(hops[0]).not.toContain('127.0.0.1');
    expect(log.msgs('client_ip_header_missing')).toHaveLength(1);
  });

  it('el sid de la query no aparece en los logs de petición', async () => {
    const log = memLog();
    app = await buildFakeApp({}, { logger: { stream: log.stream } }, { LOG_LEVEL: 'info' });
    const sid = 'b'.repeat(32);
    await app.inject({ method: 'GET', url: `/api/config?sid=${sid}` });
    expect(log.raw.length).toBeGreaterThan(0);
    for (const l of log.raw) expect(l).not.toContain(sid);
    expect(log.raw.join('\n')).toContain('sid=[redacted]');
  });

  it('el preflight CORS acepta range', async () => {
    app = await buildFakeApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/videos/jNQXAC9IVRw/audio',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('range');
  });

  it('proxyStartupWarnings', () => {
    expect(proxyStartupWarnings({ isProd: true, trustProxy: false, clientIpHeader: null })).toEqual(['trust_proxy_disabled']);
    expect(proxyStartupWarnings({ isProd: true, trustProxy: 1, clientIpHeader: null })).toEqual([]);
    expect(proxyStartupWarnings({ isProd: true, trustProxy: false, clientIpHeader: 'cf-connecting-ip' })).toEqual([]);
    expect(proxyStartupWarnings({ isProd: false, trustProxy: false, clientIpHeader: null })).toEqual([]);
  });
});
