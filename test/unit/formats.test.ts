import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveFormats,
  estimateBytes,
  forceZip64,
  previewAudioSource,
  previewSourceFor,
  rankPreviewFormats,
  selectFormats,
  videoPreviewRenditions,
  type Codec,
  type RawFormat,
} from '../../src/lib/youtube/formats.js';

const sample = JSON.parse(readFileSync(new URL('../fixtures/info-sample.json', import.meta.url), 'utf8')) as { formats: RawFormat[] };
const ON = { audioHlsFallback: true };
const OFF = { audioHlsFallback: false };

const a = (id: string, acodec: string, ext: string, abr: number, protocol = 'https'): RawFormat => ({
  format_id: id, acodec, vcodec: 'none', ext, abr, protocol, filesize: 1000,
});
const v = (id: string, height: number, tbr: number, protocol = 'https', vcodec = 'avc1.4d401f'): RawFormat => ({
  format_id: id, vcodec, acodec: 'none', ext: 'mp4', height, tbr, protocol, filesize: 5000,
});

describe('deriveFormats', () => {
  it('filtra por https, elige mejor abr y una entrada por altura avc1 ≤ 1080', () => {
    const m = deriveFormats(sample.formats);
    expect(m.audio.opus?.formatId).toBe('251');
    expect(m.audio.m4a?.formatId).toBe('140');
    expect(m.audio.hls).toBeUndefined();
    expect(m.video.map((x) => [x.height, x.formatId])).toEqual([[144, '160'], [240, '133'], [360, '134']]);
    expect(m.audioForVideo).toEqual({ formatId: '140', bytes: 300000 });
    expect(m.formatGaps).toEqual([]);
    expect(m.audio.opus?.bytes).toBe(310000);
  });

  it('descarta m3u8_native/http_dash_segments si hay alternativa https', () => {
    const m = deriveFormats([a('233', 'mp4a.40.5', 'mp4', 200, 'm3u8_native'), a('140', 'mp4a.40.2', 'm4a', 128), v('d', 720, 9000, 'http_dash_segments'), v('136', 720, 1000)]);
    expect(m.audio.m4a?.formatId).toBe('140');
    expect(m.audio.hls).toBeUndefined();
    expect(m.video.map((x) => x.formatId)).toEqual(['136']);
  });

  it('excluye > 1080 y video con audio muxeado', () => {
    const m = deriveFormats([v('137', 1080, 4000), v('299', 2160, 9000), { ...v('18', 360, 500), acodec: 'mp4a.40.2' }]);
    expect(m.video.map((x) => x.height)).toEqual([1080]);
  });
});

describe('selectFormats', () => {
  const meta = deriveFormats([a('251', 'opus', 'webm', 135), a('140', 'mp4a.40.2', 'm4a', 129), v('134', 360, 200), v('135', 480, 400), v('136', 720, 800), v('137', 1080, 2000)]);

  it('mp3/wav usan el audio de mayor abr', () => {
    for (const fmt of ['mp3', 'wav'] as const) {
      const r = selectFormats(meta, fmt, fmt === 'mp3' ? 192 : null, ON);
      expect(r.ok && r.selection.procs).toEqual([{ role: 'A', formatId: '251', bytes: 1000 }]);
    }
  });

  it('m4a usa el m4a nativo (copia)', () => {
    const r = selectFormats(meta, 'm4a', null, ON);
    expect(r.ok && r.selection).toMatchObject({ procs: [{ formatId: '140' }], transcode: false, contentType: 'audio/mp4' });
  });

  it('m4a sin m4a nativo → fallback recodificando el opus', () => {
    const m = deriveFormats([a('251', 'opus', 'webm', 135)]);
    const r = selectFormats(m, 'm4a', null, ON);
    expect(r.ok && r.selection).toMatchObject({ procs: [{ formatId: '251' }], transcode: true });
  });

  it.each([
    [360, '134'],
    [480, '135'],
    [720, '136'],
    [1080, '137'],
    ['best', '137'],
  ] as const)('mp4 %s → mayor altura ≤ pedida', (q, id) => {
    const r = selectFormats(meta, 'mp4', q, ON);
    expect(r.ok && r.selection.procs).toEqual([
      { role: 'V', formatId: id, bytes: 5000 },
      { role: 'A', formatId: '140', bytes: 1000 },
    ]);
  });

  it('mp4 sin ninguna ≤ H → la más baja disponible', () => {
    const m = deriveFormats([a('140', 'mp4a.40.2', 'm4a', 129), v('136', 720, 800)]);
    const r = selectFormats(m, 'mp4', 360, ON);
    expect(r.ok && r.selection.height).toBe(720);
  });

  it('sin avc1 → FORMAT_UNAVAILABLE no_avc1', () => {
    const m = deriveFormats([a('140', 'mp4a.40.2', 'm4a', 129), v('243', 360, 200, 'https', 'vp9')]);
    expect(selectFormats(m, 'mp4', 720, ON)).toEqual({ ok: false, code: 'FORMAT_UNAVAILABLE', reason: 'no_avc1' });
  });

  it('mp4 sin m4a → FORMAT_UNAVAILABLE no_m4a', () => {
    const m = deriveFormats([a('251', 'opus', 'webm', 135), v('136', 720, 800)]);
    expect(selectFormats(m, 'mp4', 720, ON)).toEqual({ ok: false, code: 'FORMAT_UNAVAILABLE', reason: 'no_m4a' });
  });

  it('video solo fragmentado → FORMAT_UNAVAILABLE only_fragmented', () => {
    const m = deriveFormats([a('140', 'mp4a.40.2', 'm4a', 129), v('136', 720, 800, 'http_dash_segments')]);
    expect(m.formatGaps).toContain('only_fragmented');
    expect(selectFormats(m, 'mp4', 720, ON)).toEqual({ ok: false, code: 'FORMAT_UNAVAILABLE', reason: 'only_fragmented' });
  });

  it('respaldo HLS: sin audio https y AUDIO_HLS_FALLBACK=true → m3u8_native audio-only', () => {
    const m = deriveFormats([a('233', 'mp4a.40.5', 'mp4', 48, 'm3u8_native'), a('234', 'mp4a.40.2', 'mp4', 128, 'm3u8_native')]);
    expect(m.audio.hls?.formatId).toBe('234');
    const r = selectFormats(m, 'mp3', 192, ON);
    expect(r.ok && r.selection).toMatchObject({ protocol: 'm3u8_native', procs: [{ formatId: '234', bytes: null }] });
    const r2 = selectFormats(m, 'm4a', null, ON);
    expect(r2.ok && r2.selection.transcode).toBe(false);
  });

  it('respaldo HLS desactivado → FORMAT_UNAVAILABLE only_fragmented', () => {
    const m = deriveFormats([a('234', 'mp4a.40.2', 'mp4', 128, 'm3u8_native')]);
    expect(selectFormats(m, 'mp3', 192, OFF)).toEqual({ ok: false, code: 'FORMAT_UNAVAILABLE', reason: 'only_fragmented' });
  });
});

describe('rankPreviewFormats', () => {
  const gv = (itag: string, q = '') => `https://rr1---sn-x.googlevideo.com/videoplayback?expire=1999999999&itag=${itag}${q}`;
  const p = (id: string, over: Record<string, unknown> = {}) => {
    const opus = id.startsWith('25');
    return {
      format_id: id, vcodec: 'none', protocol: 'https', url: gv(id),
      ext: opus ? 'webm' : 'm4a', acodec: opus ? 'opus' : 'mp4a.40.2', abr: 128, filesize: 1000, ...over,
    };
  };
  const ids = (info: Record<string, unknown>, codec?: Codec) => rankPreviewFormats(info, codec).map((s) => s.formatId);

  it('140 por delante de 139, 140-drc y 251-0-drc; AAC primero por defecto', () => {
    const info = { formats: [p('251-0-drc'), p('140-drc'), p('139', { acodec: 'mp4a.40.5', abr: 48 }), p('251'), p('140')] };
    expect(ids(info)).toEqual(['140', '139', '140-drc', '251', '251-0-drc']);
    expect(ids(info, 'aac')[0]).toBe('140');
  });

  it('language_preference manda dentro del grupo', () => {
    const info = { formats: [p('140-1', { language_preference: -1 }), p('140-0', { language_preference: 10 })] };
    expect(ids(info)).toEqual(['140-0', '140-1']);
  });

  it('codec=opus pone 251 primero y AAC detrás', () => {
    expect(ids({ formats: [p('140'), p('251'), p('250', { abr: 70 })] }, 'opus')).toEqual(['251', '250', '140']);
  });

  it('sin AAC y con codec=aac el primero es opus; solo HLS da []', () => {
    expect(ids({ formats: [p('251')] }, 'aac')).toEqual(['251']);
    expect(ids({ formats: [p('233', { protocol: 'm3u8_native' })] })).toEqual([]);
  });

  it('excluye has_drm, hosts ajenos, http y formatos con video', () => {
    const info = {
      formats: [
        p('140', { has_drm: true }),
        p('141', { url: 'https://example.com/a.m4a' }),
        p('142', { url: gv('142').replace('https:', 'http:') }),
        p('18', { vcodec: 'avc1' }),
        p('139'),
      ],
    };
    expect(ids(info)).toEqual(['139']);
  });

  it('expire, urlIpFamily, size y cabeceras sin Cookie', () => {
    const [s] = rankPreviewFormats({
      formats: [p('140', { url: gv('140', '&ip=2001:db8::1&clen=777'), filesize: undefined, http_headers: { 'User-Agent': 'UA', cookie: 'x=1' } })],
    });
    expect(s).toMatchObject({ expire: 1999999999, urlIpFamily: 6, size: 777, contentType: 'audio/mp4' });
    expect(s?.headers).toEqual({ 'User-Agent': 'UA', 'Accept-Encoding': 'identity' });
    const [v4] = rankPreviewFormats({ formats: [p('251', { url: gv('251', '&ip=203.0.113.1') })] });
    expect(v4).toMatchObject({ urlIpFamily: 4, size: 1000, contentType: 'audio/webm' });
  });

  it('available_at futuro no cambia el orden y el resultado es estable', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const info = { formats: [p('251'), p('140', { available_at: future }), p('139', { acodec: 'mp4a.40.5' })] };
    expect(ids(info)[0]).toBe('140');
    expect(rankPreviewFormats(info)[0]?.availableAt).toBe(future);
    expect(ids(info)).toEqual(ids(JSON.parse(JSON.stringify(info)) as Record<string, unknown>));
  });

  it('fixture real: 140 y después 139; opus 251', () => {
    expect(ids(sample as unknown as Record<string, unknown>)).toEqual(['140', '139', '251']);
    expect(ids(sample as unknown as Record<string, unknown>, 'opus')[0]).toBe('251');
  });
});

describe('videoPreviewRenditions y previewSourceFor', () => {
  const gv = (itag: string, q = '') => `https://rr1---sn-x.googlevideo.com/videoplayback?expire=1999999999&itag=${itag}&clen=4321${q}`;
  const vf = (id: string, height: number, over: Record<string, unknown> = {}) => ({
    format_id: id, vcodec: 'avc1.4d401f', acodec: 'none', ext: 'mp4', protocol: 'https', url: gv(id),
    width: Math.round((height * 16) / 9), height, fps: 30, tbr: height * 3, filesize: 5000,
    http_headers: { 'User-Agent': 'UA', Cookie: 'x=1' }, ...over,
  });
  const af = (id: string, over: Record<string, unknown> = {}) => {
    const opus = id.startsWith('25');
    return {
      format_id: id, vcodec: 'none', protocol: 'https', url: gv(id), ext: opus ? 'webm' : 'm4a',
      acodec: opus ? 'opus' : 'mp4a.40.2', abr: 128, filesize: 1000, ...over,
    };
  };
  const heights = (info: Record<string, unknown>, max = 1080) => videoPreviewRenditions(info, max).map((r) => [r.height, r.formatId]);

  it('una variante por altura ≤ maxHeight, ordenadas de menor a mayor, con sus datos', () => {
    const info = { formats: [vf('137', 1080), vf('134', 360), vf('136', 720), vf('299', 2160), vf('135', 480)] };
    expect(heights(info)).toEqual([[360, '134'], [480, '135'], [720, '136'], [1080, '137']]);
    expect(heights(info, 720)).toEqual([[360, '134'], [480, '135'], [720, '136']]);
    const [r] = videoPreviewRenditions(info, 360);
    expect(r).toMatchObject({
      formatId: '134', width: 640, height: 360, fps: 30, tbr: 1080, vcodec: 'avc1.4d401f',
      size: 5000, contentType: 'video/mp4', expire: 1999999999, urlIpFamily: null,
    });
    expect(r?.headers).toEqual({ 'User-Agent': 'UA', 'Accept-Encoding': 'identity' });
  });

  it('en la misma altura gana el de mayor tbr (720p60 sobre 720p30); a igualdad, más fps', () => {
    const info = { formats: [vf('136', 720, { tbr: 1500 }), vf('298', 720, { tbr: 3000, fps: 60 }), vf('a', 480, { tbr: 900 }), vf('b', 480, { tbr: 900, fps: 60 })] };
    expect(heights(info)).toEqual([[480, 'b'], [720, '298']]);
  });

  it('sin DRM, sin URLs ajenas a googlevideo, solo avc1 mp4 https sin audio', () => {
    const info = {
      formats: [
        vf('1', 360, { has_drm: true }),
        vf('2', 360, { url: 'https://example.com/v.mp4' }),
        vf('3', 360, { url: gv('3').replace('https:', 'http:') }),
        vf('4', 360, { protocol: 'm3u8_native' }),
        vf('5', 360, { protocol: 'http_dash_segments' }),
        vf('6', 360, { vcodec: 'vp09.00.21.08', ext: 'webm' }),
        vf('7', 360, { vcodec: 'av01.0.05M.08' }),
        vf('18', 360, { acodec: 'mp4a.40.2' }),
        vf('8', 360, { ext: 'webm' }),
        vf('9', 0),
        vf('', 360),
        af('140'),
        vf('134', 240),
      ],
    };
    expect(heights(info)).toEqual([[240, '134']]);
  });

  it('video vertical (Short): la calidad es el lado corto y se conservan width y height reales', () => {
    const vert = (id: string, w: number, h: number, over: Record<string, unknown> = {}) => vf(id, h, { width: w, tbr: w * 3, ...over });
    const info = {
      formats: [vert('137', 1080, 1920), vert('136', 720, 1280), vert('135', 480, 854), vert('134', 360, 640), vert('299', 2160, 3840)],
    };
    const q = (max: number) => videoPreviewRenditions(info, max).map((r) => [r.quality, r.width, r.height, r.formatId]);
    expect(q(1080)).toEqual([
      [360, 360, 640, '134'],
      [480, 480, 854, '135'],
      [720, 720, 1280, '136'],
      [1080, 1080, 1920, '137'],
    ]);
    expect(q(720).map(([, , , id]) => id)).toEqual(['134', '135', '136']);
    expect(previewSourceFor(info, '137', 1080)).toMatchObject({ formatId: '137', width: 1080, height: 1920, quality: 1080 });
    expect(previewSourceFor(info, '137', 720)).toBeNull();
    // Sin width, la calidad es height (comportamiento anterior)
    expect(videoPreviewRenditions({ formats: [vf('136', 720, { width: undefined })] }, 1080)[0]).toMatchObject({ width: null, height: 720, quality: 720 });
    // Horizontal: quality = height
    expect(videoPreviewRenditions({ formats: [vf('136', 720)] }, 1080)[0]?.quality).toBe(720);
  });

  it('size sale de filesize, clen o el clen de la URL', () => {
    const info = { formats: [vf('134', 360, { filesize: undefined }), vf('136', 720, { filesize: undefined, clen: 99 })] };
    expect(videoPreviewRenditions(info, 1080).map((r) => r.size)).toEqual([4321, 99]);
  });

  it('previewSourceFor: variantes permitidas y el mejor m4a; el resto, null', () => {
    const info = { formats: [vf('134', 360), vf('137', 1080), af('140'), af('139', { acodec: 'mp4a.40.5', abr: 48 }), af('251')] };
    expect(previewSourceFor(info, '134', 1080)).toMatchObject({ formatId: '134', contentType: 'video/mp4', height: 360 });
    expect(previewSourceFor(info, '140', 1080)).toMatchObject({ formatId: '140', contentType: 'audio/mp4' });
    expect(previewSourceFor(info, '137', 720)).toBeNull();
    expect(previewSourceFor(info, '139', 1080)).toBeNull();
    expect(previewSourceFor(info, '251', 1080)).toBeNull();
    expect(previewSourceFor(info, '999', 1080)).toBeNull();
    expect(previewAudioSource(info)?.formatId).toBe('140');
    expect(previewAudioSource({ formats: [af('251')] })).toBeNull();
  });

  it('fixture real: 160/133/134 y el m4a 140', () => {
    const info = sample as unknown as Record<string, unknown>;
    expect(heights(info).map(([, id]) => id)).toEqual(['160', '133', '134']);
    expect(previewSourceFor(info, '140', 1080)?.contentType).toBe('audio/mp4');
  });
});

describe('estimateBytes y forceZip64', () => {
  const meta = { ...deriveFormats([a('140', 'mp4a.40.2', 'm4a', 129), v('136', 720, 800)]), duration: 100 };

  it('fórmulas', () => {
    expect(estimateBytes(meta, 'mp3', 192, ON)).toBe(2400000);
    expect(estimateBytes(meta, 'wav', null, ON)).toBe(44100 * 4 * 100 + 44);
    expect(estimateBytes(meta, 'm4a', null, ON)).toBe(1000);
    expect(estimateBytes(meta, 'mp4', 720, ON)).toBe(6000);
  });

  it('forceZip64 = wav ∨ mp4 ∨ null ∨ > 3,5 GiB', () => {
    const GiB = 2 ** 30;
    expect(forceZip64('wav', 10)).toBe(true);
    expect(forceZip64('mp4', 10)).toBe(true);
    expect(forceZip64('mp3', null)).toBe(true);
    expect(forceZip64('mp3', 3.5 * GiB)).toBe(false);
    expect(forceZip64('m4a', 3.5 * GiB + 1)).toBe(true);
    expect(forceZip64('m4a', 100)).toBe(false);
  });
});
