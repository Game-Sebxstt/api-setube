import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFakeApp } from './helpers/fake-app.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildFakeApp({
    mget: () => {
      throw new Error('ECONNREFUSED');
    },
  });
});
afterAll(async () => {
  await app.close();
});

const OK = 'jNQXAC9IVRw';
const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/jobs', payload: payload as object });

function expectError(res: Awaited<ReturnType<typeof post>>, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const body = res.json() as { error: { code: string; message: string; details?: unknown }; requestId: string };
  expect(Object.keys(body).sort()).toEqual(['error', 'requestId']);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.requestId).toBe(res.headers['x-request-id']);
  return body;
}

describe('POST /api/jobs (esquema)', () => {
  it('format fuera del enum → 400', async () => {
    expectError(await post({ items: [{ videoId: OK }], format: 'flac' }), 400, 'INVALID_INPUT');
  });

  it('quality incoherente con el formato → 400 con details /quality', async () => {
    const b1 = expectError(await post({ items: [{ videoId: OK }], format: 'm4a', quality: 192 }), 400, 'INVALID_INPUT');
    expect(b1.error.details).toEqual([expect.objectContaining({ path: '/quality' })]);
    expectError(await post({ items: [{ videoId: OK }], format: 'wav', quality: 'best' }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK }], format: 'mp3', quality: 720 }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK }], format: 'mp4', quality: 320 }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK }], format: 'mp3', quality: 999 }), 400, 'INVALID_INPUT');
  });

  it('51 items → 413 LIMIT_ITEMS (antes del esquema)', async () => {
    const items = Array.from({ length: 51 }, () => ({ videoId: OK }));
    expectError(await post({ items, format: 'mp3' }), 413, 'LIMIT_ITEMS');
  });

  it('videoId inválido → 400', async () => {
    expectError(await post({ items: [{ videoId: 'corto' }], format: 'mp3' }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: 'aaaaaaaaaaaa' }], format: 'mp3' }), 400, 'INVALID_INPUT');
  });

  it('propiedades extra → 400', async () => {
    expectError(await post({ items: [{ videoId: OK }], format: 'mp3', extra: true }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK, url: 'x' }], format: 'mp3' }), 400, 'INVALID_INPUT');
  });

  it('items vacío o sin format → 400; turnstileToken > 2048 → 400', async () => {
    expectError(await post({ items: [], format: 'mp3' }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK }] }), 400, 'INVALID_INPUT');
    expectError(await post({ items: [{ videoId: OK }], format: 'mp3', turnstileToken: 'x'.repeat(2049) }), 400, 'INVALID_INPUT');
  });

  it('Redis no disponible → 503 SERVICE_UNAVAILABLE', async () => {
    expectError(await post({ items: [{ videoId: OK }], format: 'mp3' }), 503, 'SERVICE_UNAVAILABLE');
  });
});
