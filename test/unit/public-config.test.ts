import { Value } from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { toPublicVideo } from '../../src/routes/videos.js';
import { VideoResponse } from '../../src/schemas/videos.js';
import { buildFakeApp } from './helpers/fake-app.js';
import { fakeMeta } from './helpers/upstream.js';

const limits = { maxDurationAudioSec: 3600, maxDurationVideoSec: 1200 };
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('preview en /api/config y en VideoResponse', () => {
  it('/api/config expone preview según PREVIEW_ENABLED', async () => {
    app = await buildFakeApp();
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json().preview).toBe(true);
    await app.close();
    app = await buildFakeApp({}, {}, { PREVIEW_ENABLED: 'false' });
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json().preview).toBe(false);
  });

  it('audio.preview refleja los formatos https disponibles', () => {
    const onlyM4a = toPublicVideo(fakeMeta({ audio: { m4a: { formatId: '140', abr: 128, bytes: 1 } } }), limits);
    expect(onlyM4a.audio.preview).toEqual({ aac: true, opus: false });
    const hls = toPublicVideo(fakeMeta({ audio: { hls: { formatId: '234', abr: 128, bytes: null, acodec: 'mp4a.40.2' } } }), limits);
    expect(hls.audio.preview).toEqual({ aac: false, opus: false });
    expect(Value.Check(VideoResponse, onlyM4a)).toBe(true);
    expect(Value.Check(VideoResponse, hls)).toBe(true);
  });

  it('GET /api/videos/:id incluye audio.preview', async () => {
    const metadata = { get: async () => fakeMeta() } as unknown as MetadataService;
    app = await buildFakeApp({}, { youtube: { metadata } });
    const res = await app.inject({ method: 'GET', url: '/api/videos/jNQXAC9IVRw' });
    expect(res.statusCode).toBe(200);
    expect(res.json().audio.preview).toEqual({ aac: true, opus: true });
  });
});
