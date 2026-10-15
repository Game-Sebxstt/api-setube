import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { buildFakeApp, ORIGIN } from './helpers/fake-app.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, serve, pattern } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';

interface Connect {
  target: string;
  auth: string | undefined;
}

// Proxy HTTP mínimo: registra el CONNECT y lo rechaza
async function startProxy() {
  const seen: Connect[] = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on('connect', (req: http.IncomingMessage, socket) => {
    seen.push({ target: req.url ?? '', auth: req.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function make(env: Record<string, string>) {
  const data = pattern(64 * 1024);
  const f = fakeFetch((c) => serve(data, c));
  const info = infoWith([audioFormat('140', data.length)]);
  const metadata = {
    get: vi.fn(async () => fakeMeta()),
    readInfoJson: vi.fn(async () => info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: info })),
  };
  const app: FastifyInstance = await buildFakeApp(
    {
      setubeLeaseAcquire: () => 1,
      setubeLeaseRenew: () => 1,
      setubeLeaseRelease: () => 1,
      get: () => null,
      set: () => 'OK',
    },
    {
      fetch: f.fetch,
      youtube: { metadata: metadata as unknown as MetadataService },
      preview: { retryDelayMs: 0, retryJitterMs: 0, headersTimeoutMs: 3000 },
    },
    { PREVIEW_CHUNK_BYTES: '1048576', ...env },
  );
  cleanups.push(() => app.close());
  return { app, f };
}

describe('escucha en streaming con YTDLP_PROXY', () => {
  it('las peticiones a googlevideo salen por el proxy configurado', async () => {
    const proxy = await startProxy();
    cleanups.push(proxy.close);
    const { app, f } = await make({ YTDLP_PROXY: `http://usuario:clave@127.0.0.1:${proxy.port}` });
    const res = await app.inject({ method: 'GET', url: `/api/videos/${ID}/audio`, headers: { origin: ORIGIN, range: 'bytes=0-1023' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(proxy.seen.length).toBeGreaterThan(0);
    expect(proxy.seen[0]!.target).toBe('rr1---sn-test.googlevideo.com:443');
    expect(proxy.seen[0]!.auth).toBe(`Basic ${Buffer.from('usuario:clave').toString('base64')}`);
    expect(f.calls).toHaveLength(0);
    expect(app.deps.upstreamFetch).not.toBe(app.deps.fetch);
  });

  it('sin proxy usa el fetch directo', async () => {
    const { app, f } = await make({});
    const res = await app.inject({ method: 'GET', url: `/api/videos/${ID}/audio`, headers: { origin: ORIGIN, range: 'bytes=0-1023' } });
    expect(res.statusCode).toBe(206);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(app.deps.upstreamFetch).toBe(app.deps.fetch);
  });
});
