import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVC1,
  groupSegments,
  masterPlaylist,
  mediaPlaylist,
  mediaPlaylistUri,
  mediaUri,
  type MasterInput,
} from '../../src/lib/preview/hls.js';
import type { Mp4Segment } from '../../src/lib/preview/mp4-index.js';
import { hlsPlan } from '../../src/routes/preview.js';
import { audioFormat, infoWith, videoFormat } from './helpers/upstream.js';

const SID = 'a'.repeat(32);
const TS = 15360;

// Fragmentos consecutivos desde `first` con las duraciones dadas (en segundos) y 1000 B cada uno
function frags(durations: number[], o: { first?: number; sap?: (i: number) => boolean; size?: number } = {}): Mp4Segment[] {
  let offset = o.first ?? 1000;
  let start = 0;
  return durations.map((d, i) => {
    const size = o.size ?? 1000;
    const s: Mp4Segment = { offset, size, start, duration: Math.round(d * TS), startsWithSap: o.sap ? o.sap(i) : true, sapType: 1 };
    offset += size;
    start += s.duration;
    return s;
  });
}

const ix = (segments: Mp4Segment[], over: Partial<{ formatId: string; initEnd: number; timescale: number }> = {}) => ({
  formatId: '136',
  initEnd: 800,
  timescale: TS,
  segments,
  ...over,
});

const master: MasterInput = {
  sid: SID,
  audio: { formatId: '140', bps: 129_000, codec: 'mp4a.40.2' },
  variants: [
    { formatId: '136', videoBps: 1_500_000, width: 1280, height: 720, fps: 30, codec: 'avc1.4d401f' },
    { formatId: '134', videoBps: 400_000, width: 640, height: 360, fps: 29.97, codec: 'avc1.4d401e' },
    { formatId: '137', videoBps: 3_000_000, width: null, height: 1080, fps: null, codec: 'avc1' },
  ],
};

describe('masterPlaylist', () => {
  it('estructura exacta: versión 7, segmentos independientes, grupo de audio y una variante por formato', () => {
    expect(masterPlaylist(master)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="140.m3u8?sid=${SID}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=2443500,AVERAGE-BANDWIDTH=1629000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
        `136.m3u8?sid=${SID}`,
        '#EXT-X-STREAM-INF:BANDWIDTH=793500,AVERAGE-BANDWIDTH=529000,RESOLUTION=640x360,FRAME-RATE=29.970,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"',
        `134.m3u8?sid=${SID}`,
        `#EXT-X-STREAM-INF:BANDWIDTH=4693500,AVERAGE-BANDWIDTH=3129000,CODECS="${DEFAULT_AVC1},mp4a.40.2",AUDIO="aud"`,
        `137.m3u8?sid=${SID}`,
        '',
      ].join('\n'),
    );
  });

  it('códec de audio desconocido → mp4a.40.2; HE-AAC se respeta', () => {
    expect(masterPlaylist({ ...master, audio: { ...master.audio, codec: '' } })).toContain('CODECS="avc1.4d401f,mp4a.40.2"');
    expect(masterPlaylist({ ...master, audio: { ...master.audio, codec: 'mp4a.40.5' } })).toContain('CODECS="avc1.4d401f,mp4a.40.5"');
  });

  it('sin variantes falla en vez de generar un playlist inválido; las URIs van codificadas', () => {
    expect(() => masterPlaylist({ ...master, variants: [] })).toThrow();
    const text = masterPlaylist({ ...master, sid: 'x"y\n' });
    expect(text).toContain('URI="140.m3u8?sid=x%22y%0A"');
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(7);
  });

  it('URIs relativas: el media playlist junto al master y los bytes en ../media/', () => {
    expect(mediaPlaylistUri('136', SID)).toBe(`136.m3u8?sid=${SID}`);
    expect(mediaUri('140', SID)).toBe(`../media/140?sid=${SID}`);
    const base = new URL(`https://api.example/api/videos/jNQXAC9IVRw/hls/master.m3u8?sid=${SID}`);
    const playlist = new URL(mediaPlaylistUri('136', SID), base);
    expect(playlist.pathname).toBe('/api/videos/jNQXAC9IVRw/hls/136.m3u8');
    const media = new URL(mediaUri('136', SID), playlist);
    expect(media.pathname).toBe('/api/videos/jNQXAC9IVRw/media/136');
    expect(media.searchParams.get('sid')).toBe(SID);
  });
});

describe('groupSegments', () => {
  it('fragmentos de 2 s se agrupan en segmentos de 6 s; el último se queda con lo que sobra', () => {
    const g = groupSegments(ix(frags([2, 2, 2, 2, 2, 2, 2, 2])));
    expect(g.map((s) => s.duration)).toEqual([6, 6, 4]);
    expect(g.map((s) => [s.offset, s.size])).toEqual([[1000, 3000], [4000, 3000], [7000, 2000]]);
    expect(g.every((s) => s.independent)).toBe(true);
  });

  it('fragmentos de ~5,3 s (los de YouTube) no se juntan: pasarían de 9 s', () => {
    expect(groupSegments(ix(frags([5.339, 5.339, 5.339]))).map((s) => s.duration.toFixed(3))).toEqual(['5.339', '5.339', '5.339']);
  });

  it('un fragmento más largo que el objetivo (audio de 10 s) es un segmento por sí solo', () => {
    expect(groupSegments(ix(frags([10, 10, 3]))).map((s) => s.duration)).toEqual([10, 10, 3]);
  });

  it('un fragmento que no empieza en keyframe se une al anterior aunque pase del objetivo', () => {
    const g = groupSegments(ix(frags([4, 2, 2, 2, 2], { sap: (i) => i !== 2 })));
    expect(g.map((s) => s.duration)).toEqual([8, 4]);
    expect(g.every((s) => s.independent)).toBe(true);
  });

  it('si el sidx no marca ningún SAP, cada fragmento es una frontera posible y no se declaran independientes', () => {
    const g = groupSegments(ix(frags([3, 3, 3, 3], { sap: () => false })));
    expect(g.map((s) => s.duration)).toEqual([6, 6]);
    expect(g.some((s) => s.independent)).toBe(false);
  });

  it('cubre todos los bytes de los fragmentos, contiguos y en orden', () => {
    const f = frags([1.5, 2.5, 1, 4, 0.5, 6, 2, 2, 2, 1], { size: 777 });
    const g = groupSegments(ix(f));
    expect(g[0]?.offset).toBe(f[0]?.offset);
    for (let i = 1; i < g.length; i++) expect(g[i]?.offset).toBe((g[i - 1]?.offset ?? 0) + (g[i - 1]?.size ?? 0));
    expect(g.reduce((n, s) => n + s.size, 0)).toBe(777 * f.length);
    expect(g.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(22.5, 6);
  });
});

describe('mediaPlaylist', () => {
  it('estructura exacta: VOD, TARGETDURATION, EXT-X-MAP del init, BYTERANGE por segmento y ENDLIST', () => {
    expect(mediaPlaylist(ix(frags([2, 2, 2, 2.5])), SID)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXT-X-MAP:URI="../media/136?sid=${SID}",BYTERANGE="800@0"`,
        '#EXTINF:6.00000,',
        '#EXT-X-BYTERANGE:3000@1000',
        `../media/136?sid=${SID}`,
        '#EXTINF:2.50000,',
        '#EXT-X-BYTERANGE:1000@4000',
        `../media/136?sid=${SID}`,
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });

  it('RFC 8216 §4.3.3.1: cada EXTINF redondeado es ≤ TARGETDURATION', () => {
    for (const durations of [[6.4, 6.4], [6.6, 1], [5.339, 5.339, 5.339], [10, 10, 3], [0.2], [9.49, 2]]) {
      const text = mediaPlaylist(ix(frags(durations)), SID);
      const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1]);
      const infs = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
      expect(infs.length).toBeGreaterThan(0);
      for (const d of infs) expect(Math.round(d)).toBeLessThanOrEqual(target);
      expect(target).toBe(Math.max(1, ...infs.map((d) => Math.round(d))));
    }
  });

  it('sin SAP en el primer fragmento no declara EXT-X-INDEPENDENT-SEGMENTS', () => {
    const text = mediaPlaylist(ix(frags([2, 2, 2, 2], { sap: (i) => i !== 0 })), SID);
    expect(text).not.toContain('INDEPENDENT-SEGMENTS');
  });

  it('el audio usa su formatId en las URIs', () => {
    const text = mediaPlaylist(ix(frags([10, 10]), { formatId: '140', initEnd: 650 }), SID);
    expect(text).toContain(`#EXT-X-MAP:URI="../media/140?sid=${SID}",BYTERANGE="650@0"`);
    expect(text.split('\n').filter((l) => l === `../media/140?sid=${SID}`)).toHaveLength(2);
  });
});

describe('hlsPlan', () => {
  const info = (formats: Record<string, unknown>[]) => infoWith(formats);

  it('arranca por 720p y después el resto de menor a mayor; la media sale de tamaño / duración', () => {
    const p = hlsPlan(
      info([videoFormat('137', 1080, 3_000_000), videoFormat('134', 360, 500_000), videoFormat('136', 720, 1_000_000), audioFormat('140', 250_000)]),
      20,
      1080,
    );
    expect(p?.start).toBe('136');
    expect(p?.variants.map((v) => v.formatId)).toEqual(['136', '134', '137']);
    expect(p?.variants[0]).toMatchObject({ videoBps: 400_000, width: 1280, height: 720, fps: 30, codec: 'avc1.4d401f' });
    expect(p?.audio).toEqual({ formatId: '140', bps: 100_000, codec: 'mp4a.40.2' });
  });

  it('sin 720p arranca por la más cercana por debajo; si todas son mayores, por la más baja', () => {
    expect(hlsPlan(info([videoFormat('135', 480, 1), videoFormat('137', 1080, 1), audioFormat('140', 1)]), 10, 1080)?.start).toBe('135');
    expect(hlsPlan(info([videoFormat('137', 1080, 1), videoFormat('299', 1080, 1, { fps: 60, tbr: 9000 }), audioFormat('140', 1)]), 10, 1080)?.start).toBe('299');
  });

  it('sin tamaño usa el tbr / abr de yt-dlp, y sin tbr una estimación por píxeles', () => {
    const p = hlsPlan(info([videoFormat('136', 720, null), videoFormat('134', 360, null, { tbr: undefined }), audioFormat('140', null)]), 20, 1080);
    expect(p?.variants.find((v) => v.formatId === '136')?.videoBps).toBe(2_160_000);
    expect(p?.variants.find((v) => v.formatId === '134')?.videoBps).toBe(640 * 360 * 30 * 0.1);
    expect(p?.audio.bps).toBe(128_000);
  });

  it('respeta PREVIEW_VIDEO_MAX_HEIGHT y devuelve null sin variantes o sin m4a', () => {
    const all = [videoFormat('134', 360, 1), videoFormat('137', 1080, 1), audioFormat('140', 1)];
    expect(hlsPlan(info(all), 10, 720)?.variants.map((v) => v.formatId)).toEqual(['134']);
    expect(hlsPlan(info([audioFormat('140', 1)]), 10, 1080)).toBeNull();
    expect(hlsPlan(info([videoFormat('136', 720, 1), audioFormat('251', 1)]), 10, 1080)).toBeNull();
  });
});
