import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import { HLS_CONTENT_TYPE, masterPlaylist, mediaPlaylist } from '../../src/lib/preview/hls.js';
import { parseMp4Index } from '../../src/lib/preview/mp4-index.js';
import type { MetadataService } from '../../src/lib/youtube/metadata.js';
import { hlsPlan } from '../../src/routes/preview.js';
import { buildFakeApp, ORIGIN } from './helpers/fake-app.js';
import { fakeMp4, type FakeMp4 } from './helpers/mp4.js';
import { audioFormat, fakeFetch, fakeMeta, infoWith, pattern, serve, videoFormat } from './helpers/upstream.js';

const ID = 'jNQXAC9IVRw';
const SID = 'd'.repeat(32);
const BASE = `/api/videos/${ID}/hls`;
const MASTER = `${BASE}/master.m3u8?sid=${SID}`;
const PLAYLIST = (formatId: string) => `${BASE}/${formatId}.m3u8?sid=${SID}`;

type Files = Record<string, FakeMp4>;

function filesDefault(): Files {
  return {
    '134': fakeMp4({ fragments: 9, fragmentSize: 1500 }),
    '136': fakeMp4({ fragments: 9, fragmentSize: 4000 }),
    '140': fakeMp4({ fragments: 2, fragmentSize: 2500, duration: 15360 * 9 }),
  };
}

const infoFor = (files: Files) =>
  infoWith([
    videoFormat('134', 360, files['134']?.data.length ?? null),
    videoFormat('136', 720, files['136']?.data.length ?? null),
    audioFormat('140', files['140']?.data.length ?? null),
    audioFormat('251', 1000),
  ]);

interface Opts {
  files?: Files;
  info?: Record<string, unknown>;
  meta?: Partial<ReturnType<typeof fakeMeta>>;
  env?: Record<string, string>;
  tuning?: AppDeps['preview'];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function make(o: Opts = {}) {
  const state = { files: o.files ?? filesDefault(), info: null as Record<string, unknown> | null };
  state.info = o.info ?? infoFor(state.files);
  const f = fakeFetch((c) => {
    const itag = new URL(c.url).searchParams.get('itag') ?? '';
    const file = state.files[itag];
    return file ? serve(file.data, c, { contentType: 'video/mp4' }) : new Response(null, { status: 404 });
  });
  const metadata = {
    get: vi.fn(async () => fakeMeta({ duration: 18, ...o.meta })),
    readInfoJson: vi.fn(async () => state.info),
    refresh: vi.fn(async () => ({ meta: fakeMeta(), infoJson: state.info as Record<string, unknown> })),
  };
  const store = new Map<string, string>();
  const redis = {
    setubeLeaseAcquire: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRenew: vi.fn((..._a: unknown[]): unknown => 1),
    setubeLeaseRelease: vi.fn((..._a: unknown[]): unknown => 1),
    get: vi.fn(async (k: unknown) => store.get(String(k)) ?? null),
    set: vi.fn(async (k: unknown, v: unknown) => {
      store.set(String(k), String(v));
      return 'OK';
    }),
  };
  const app = await buildFakeApp(
    redis,
    {
      fetch: f.fetch,
      youtube: { metadata: metadata as unknown as MetadataService },
      preview: { retryDelayMs: 0, retryJitterMs: 0, mediaLeaseGraceMs: 50, ...o.tuning },
    },
    { PREVIEW_CHUNK_BYTES: '1048576', ...o.env },
  );
  apps.push(app);
  return { app, f, metadata, state, store };
}

const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;
const indexOf = (m: FakeMp4, formatId: string) => {
  const r = parseMp4Index(m.data, { totalSize: m.data.length });
  if (r.kind !== 'ok') throw new Error('fixture sin índice');
  return { formatId, ...r.index };
};

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /api/videos/:videoId/hls/master.m3u8', () => {
  it('200 con el master exacto, tipo HLS, caché privada y CORS', async () => {
    const { app, state } = await make();
    const res = await app.inject({ method: 'GET', url: MASTER, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(HLS_CONTENT_TYPE);
    expect(res.headers['cache-control']).toBe('private, max-age=600');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const plan = hlsPlan(state.info as Record<string, unknown>, 18, 1080);
    expect(plan).not.toBeNull();
    expect(res.body).toBe(masterPlaylist({ variants: plan!.variants, audio: plan!.audio, sid: SID }));
    expect(res.body.split('\n').filter((l) => l.endsWith(`.m3u8?sid=${SID}`) && !l.startsWith('#'))).toEqual([`136.m3u8?sid=${SID}`, `134.m3u8?sid=${SID}`]);
  });

  it('precalienta en segundo plano el índice del audio y de la variante de arranque', async () => {
    const { app, f } = await make();
    const res = await app.inject({ method: 'GET', url: MASTER });
    expect(res.statusCode).toBe(200);
    await waitFor(() => f.calls.length === 2);
    const itags = f.calls.map((c) => new URL(c.url).searchParams.get('itag')).sort();
    expect(itags).toEqual(['136', '140']);
    expect(f.calls.every((c) => c.range.startsWith('bytes=0-'))).toBe(true);
    // Los playlists que pide el reproductor después salen de memoria, sin volver a googlevideo
    expect((await app.inject({ method: 'GET', url: PLAYLIST('136') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: PLAYLIST('140') })).statusCode).toBe(200);
    expect(f.calls).toHaveLength(2);
  });

  it('el precalentado que falla no rompe nada ni deja promesas sin capturar', async () => {
    const files = filesDefault();
    files['136'] = { ...files['136']!, data: pattern(5000) };
    const { app, f } = await make({ files, info: infoFor(filesDefault()) });
    const res = await app.inject({ method: 'GET', url: MASTER });
    expect(res.statusCode).toBe(200);
    await waitFor(() => f.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('sin variantes de video o sin m4a → 422 FORMAT_UNAVAILABLE no-store', async () => {
    for (const info of [infoWith([audioFormat('140', 1000)]), infoWith([videoFormat('136', 720, 1000), audioFormat('251', 1000)])]) {
      const { app, f } = await make({ info });
      const res = await app.inject({ method: 'GET', url: MASTER });
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('FORMAT_UNAVAILABLE');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(f.calls).toHaveLength(0);
    }
  });

  it('directos, duración por encima de MAX_DURATION_AUDIO_SEC y video apagado', async () => {
    const live = await make({ meta: { live: true } });
    expect(errCode(await live.app.inject({ method: 'GET', url: MASTER }))).toBe('LIVE_NOT_SUPPORTED');
    const long = await make({ meta: { duration: 3601 } });
    const r = await long.app.inject({ method: 'GET', url: MASTER });
    expect(r.statusCode).toBe(422);
    expect(errCode(r)).toBe('LIMIT_DURATION');
    const envs: Record<string, string>[] = [{ PREVIEW_VIDEO_ENABLED: 'false' }, { PREVIEW_ENABLED: 'false' }];
    for (const env of envs) {
      const off = await make({ env });
      for (const url of [MASTER, PLAYLIST('136')]) {
        const res = await off.app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(503);
        expect(errCode(res)).toBe('SERVICE_UNAVAILABLE');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect(off.metadata.get).not.toHaveBeenCalled();
    }
  });

  it('metadata colgada → 504 UPSTREAM_TIMEOUT no-store al vencer el plazo, en el master y en los playlists', async () => {
    const { app, metadata } = await make({ tuning: { deadlineMs: 100 } });
    metadata.get.mockImplementation(() => new Promise(() => undefined));
    for (const url of [MASTER, PLAYLIST('136')]) {
      const t0 = Date.now();
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(504);
      expect(errCode(res)).toBe('UPSTREAM_TIMEOUT');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it('master y playlists seguidos del mismo video leen la meta una sola vez', async () => {
    const { app, metadata } = await make();
    for (const url of [MASTER, PLAYLIST('136'), PLAYLIST('140'), PLAYLIST('134')]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
    expect(metadata.get).toHaveBeenCalledTimes(1);
    expect(metadata.readInfoJson).toHaveBeenCalledTimes(1);
  });

  it('sin sid, con sid inválido o con parámetros extra → 400; origen ajeno → 403; HEAD → 404', async () => {
    const { app, metadata } = await make();
    for (const q of ['', '?sid=xyz', `?sid=${SID}&codec=aac`]) {
      for (const path of [`${BASE}/master.m3u8`, `${BASE}/136.m3u8`]) {
        const res = await app.inject({ method: 'GET', url: path + q });
        expect(res.statusCode, path + q).toBe(400);
        expect(errCode(res)).toBe('INVALID_INPUT');
      }
    }
    expect(metadata.get).not.toHaveBeenCalled();
    for (const headers of [{ origin: 'https://evil.example' }, { referer: 'https://evil.example/x' }]) {
      const res = await app.inject({ method: 'GET', url: MASTER, headers });
      expect(res.statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'HEAD', url: MASTER })).statusCode).toBe(404);
  });
});

describe('GET /api/videos/:videoId/hls/:formatId.m3u8', () => {
  it('200 con el media playlist exacto del sidx, para video y audio', async () => {
    const { app, state } = await make();
    for (const id of ['136', '134', '140']) {
      const res = await app.inject({ method: 'GET', url: PLAYLIST(id) });
      expect(res.statusCode, id).toBe(200);
      expect(res.headers['content-type']).toBe(HLS_CONTENT_TYPE);
      expect(res.headers['cache-control']).toBe('private, max-age=600');
      expect(res.body).toBe(mediaPlaylist(indexOf(state.files[id]!, id), SID));
    }
    // 9 fragmentos de 2 s → 4 segmentos de 4 s y uno de 2 s; el audio, 2 de 9 s
    expect((await app.inject({ method: 'GET', url: PLAYLIST('136') })).body.match(/#EXTINF:4\.00000,/g)).toHaveLength(4);
    expect((await app.inject({ method: 'GET', url: PLAYLIST('140') })).body).toContain('#EXT-X-TARGETDURATION:9');
  });

  it('init + segmentos del playlist pedidos a /media reconstruyen el archivo (sin el sidx)', async () => {
    const { app, state } = await make();
    for (const id of ['136', '140']) {
      const playlistUrl = new URL(`http://api.test${PLAYLIST(id)}`);
      const text = (await app.inject({ method: 'GET', url: playlistUrl.pathname + playlistUrl.search })).body;
      const lines = text.split('\n');
      const map = /#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@(\d+)"/.exec(text);
      const ranges: { uri: string; len: number; off: number }[] = [{ uri: map![1]!, len: Number(map![2]), off: Number(map![3]) }];
      lines.forEach((l, i) => {
        const m = /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/.exec(l);
        if (m) ranges.push({ uri: lines[i + 1]!, len: Number(m[1]), off: Number(m[2]) });
      });
      const parts: Buffer[] = [];
      for (const r of ranges) {
        const u = new URL(r.uri, playlistUrl);
        expect(u.pathname).toBe(`/api/videos/${ID}/media/${id}`);
        const res = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { range: `bytes=${r.off}-${r.off + r.len - 1}` } });
        expect(res.statusCode).toBe(206);
        parts.push(res.rawPayload);
      }
      const file = state.files[id]!;
      const expected = Buffer.concat([file.data.subarray(0, file.initEnd), file.data.subarray(file.sidxEnd)]);
      expect(Buffer.concat(parts).equals(expected)).toBe(true);
    }
  });

  it('formato fuera de la lista permitida o índice ilegible → 404 FORMAT_UNAVAILABLE no-store', async () => {
    const files = filesDefault();
    files['134'] = { ...files['134']!, data: pattern(files['134']!.data.length) };
    const { app, f } = await make({ files, info: infoFor(filesDefault()), env: { PREVIEW_VIDEO_MAX_HEIGHT: '720' } });
    for (const id of ['251', '137', '999']) {
      const res = await app.inject({ method: 'GET', url: PLAYLIST(id) });
      expect(res.statusCode, id).toBe(404);
      expect(errCode(res)).toBe('FORMAT_UNAVAILABLE');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(f.calls).toHaveLength(0);
    const bad = await app.inject({ method: 'GET', url: PLAYLIST('134') });
    expect(bad.statusCode).toBe(404);
    expect(errCode(bad)).toBe('FORMAT_UNAVAILABLE');
  });

  it('formatId con forma inválida → 400; sin .m3u8 → 404', async () => {
    const { app } = await make();
    for (const id of ['13_6', 'a'.repeat(25)]) {
      const res = await app.inject({ method: 'GET', url: PLAYLIST(id) });
      expect(res.statusCode, id).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: `${BASE}/136?sid=${SID}` })).statusCode).toBe(404);
  });

  it('la info actual dice otro tamaño: no sirve el índice viejo de memoria, lo recalcula', async () => {
    const { app, state, f } = await make();
    const first = await app.inject({ method: 'GET', url: PLAYLIST('136') });
    expect(first.statusCode).toBe(200);
    const v2 = fakeMp4({ fragments: 12, fragmentSize: 4000 });
    state.files = { ...state.files, '136': v2 };
    state.info = infoFor(state.files);
    const calls = f.calls.length;
    // Mientras dura la caché del info JSON (60 s) el playlist es el mismo y no toca googlevideo
    const cached = await app.inject({ method: 'GET', url: PLAYLIST('136') });
    expect(cached.body).toBe(first.body);
    expect(f.calls.length).toBe(calls);
    // Vencida la caché del info (el índice en memoria dura 10 min), la info nueva trae otro tamaño
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const again = await app.inject({ method: 'GET', url: PLAYLIST('136') });
      expect(again.statusCode).toBe(200);
      expect(again.body).toBe(mediaPlaylist(indexOf(v2, '136'), SID));
      expect(again.body).not.toBe(first.body);
      expect(f.calls.length).toBe(calls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
