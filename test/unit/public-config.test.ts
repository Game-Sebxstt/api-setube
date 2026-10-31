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

  it('/api/config expone previewVideo = PREVIEW_ENABLED && PREVIEW_VIDEO_ENABLED', async () => {
    const cases: [Record<string, string>, boolean, boolean][] = [
      [{}, true, true],
      [{ PREVIEW_VIDEO_ENABLED: 'false' }, true, false],
      [{ PREVIEW_ENABLED: 'false' }, false, false],
      [{ PREVIEW_ENABLED: 'false', PREVIEW_VIDEO_ENABLED: 'true' }, false, false],
    ];
    for (const [env, preview, previewVideo] of cases) {
      app = await buildFakeApp({}, {}, env);
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ preview, previewVideo });
      await app.close();
      app = null;
    }
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
