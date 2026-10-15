import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveFormats,
  estimateBytes,
  forceZip64,
  rankPreviewFormats,
  selectFormats,
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
