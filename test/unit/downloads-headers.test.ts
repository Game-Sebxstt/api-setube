import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFakeApp, ORIGIN } from './helpers/fake-app.js';

const JOB = '3f1c2a9e-8b7d-4c6e-9f00-112233445566';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildFakeApp({ setubeSnapshot: () => [[], -2, 0, Date.now()] });
});
afterAll(async () => {
  await app.close();
});

describe.each([
  ['/file', `/api/jobs/${JOB}/items/i0/file`],
  ['/archive', `/api/jobs/${JOB}/archive`],
])('%s', (_name, url) => {
  it('sin x-frame-options y con CSP default-src none + frame-ancestors = CORS_ORIGINS (sin self)', async () => {
    const res = await app.inject({ method: 'GET', url, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
    expect(res.headers['x-frame-options']).toBeUndefined();
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain(`frame-ancestors ${ORIGIN}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'self'");
  });

  it('HEAD no existe (exposeHeadRoute: false)', async () => {
    const res = await app.inject({ method: 'HEAD', url });
    expect(res.statusCode).toBe(404);
  });

  it('expone x-request-id y retry-after a CORS', async () => {
    const res = await app.inject({ method: 'GET', url, headers: { origin: ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const exposed = String(res.headers['access-control-expose-headers']).toLowerCase();
    expect(exposed).toContain('x-request-id');
    expect(exposed).toContain('retry-after');
  });
});

describe('resto de rutas', () => {
  it('conservan helmet global (x-frame-options y frame-ancestors self)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'self'");
  });

  it('preflight CORS acepta last-event-id', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: `/api/jobs/${JOB}/events`,
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'last-event-id' },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('last-event-id');
  });

  it('un origen no listado no recibe cabeceras CORS', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
