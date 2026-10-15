import { describe, expect, it, vi } from 'vitest';
import { FfmpegProgressParser, ItemProgress, parseYtdlpLine, type YtdlpProgress } from '../../src/lib/media/progress.js';

const line = (o: unknown) => `SETUBE_PROGRESS ${JSON.stringify(o)}`;
const p = (o: Partial<YtdlpProgress>): YtdlpProgress => ({
  downloaded: null, total: null, totalEstimate: null, speed: null, eta: null, status: 'downloading', ...o,
});

describe('parseYtdlpLine', () => {
  it('mapea explícitamente las claves del diccionario de progreso', () => {
    expect(
      parseYtdlpLine(line({ downloaded_bytes: 500, total_bytes: 1000, total_bytes_estimate: 1100, speed: 250.5, eta: 2, status: 'downloading', extra: 1 })),
    ).toEqual({ downloaded: 500, total: 1000, totalEstimate: 1100, speed: 250.5, eta: 2, status: 'downloading' });
  });

  it('solo con total_bytes_estimate', () => {
    expect(parseYtdlpLine(line({ downloaded_bytes: 10, total_bytes_estimate: 99, status: 'finished' }))).toMatchObject({
      total: null, totalEstimate: 99, status: 'finished',
    });
  });

  it('todo null / ausente', () => {
    expect(parseYtdlpLine(line({}))).toEqual({ downloaded: null, total: null, totalEstimate: null, speed: null, eta: null, status: null });
    expect(parseYtdlpLine(line({ downloaded_bytes: null, total_bytes: null, speed: null, eta: null, status: null }))).toMatchObject({
      downloaded: null, total: null, speed: null, eta: null, status: null,
    });
  });

  it('negativos, NaN, cero en totales y strings → null', () => {
    expect(
      parseYtdlpLine('SETUBE_PROGRESS {"downloaded_bytes":-1,"total_bytes":0,"total_bytes_estimate":"12","speed":NaN,"eta":-5,"status":"raro"}'),
    ).toBeNull();
    expect(parseYtdlpLine(line({ downloaded_bytes: -1, total_bytes: 0, total_bytes_estimate: '12', speed: -3, eta: -5, status: 'raro' }))).toEqual({
      downloaded: null, total: null, totalEstimate: null, speed: null, eta: null, status: null,
    });
  });

  it('líneas sin prefijo y JSON corrupto → null (debug)', () => {
    const log = { debug: vi.fn() };
    expect(parseYtdlpLine('[download]  45.0% of 3.00MiB', log)).toBeNull();
    expect(parseYtdlpLine('SETUBE_PROGRESS {roto', log)).toBeNull();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(parseYtdlpLine('SETUBE_PROGRESS [1,2]')).toBeNull();
  });
});

describe('FfmpegProgressParser', () => {
  it('emite al llegar progress=continue|end, con N/A → null', () => {
    const f = new FfmpegProgressParser();
    expect(f.push('frame=0')).toBeNull();
    expect(f.push('out_time_us=N/A')).toBeNull();
    expect(f.push('speed=N/A')).toBeNull();
    expect(f.push('progress=continue')).toEqual({ outTimeUs: null, speed: null, end: false });
    f.push('out_time_us=1500000');
    f.push('speed=2.5x');
    expect(f.push('progress=continue')).toEqual({ outTimeUs: 1500000, speed: 2.5, end: false });
    f.push('out_time_us=-7');
    expect(f.push('progress=continue')).toMatchObject({ outTimeUs: null });
    f.push('out_time_us=3000000');
    expect(f.push('progress=end')).toEqual({ outTimeUs: 3000000, speed: null, end: true });
  });

  it('ignora líneas sin =', () => {
    const f = new FfmpegProgressParser();
    expect(f.push('basura')).toBeNull();
  });
});

describe('ItemProgress', () => {
  it('mapeo 0–85 descarga / 85–100 conversión y tope 99,9', () => {
    const ip = new ItemProgress([{ role: 'A', formatId: '251', bytes: 1000 }], 100);
    expect(ip.compute().pct).toBe(0);
    ip.ytdlp('A', p({ downloaded: 500, total: 1000 }));
    expect(ip.compute()).toMatchObject({ pct: 42.5, phase: 'download' });
    ip.ffmpeg(50e6);
    expect(ip.compute().pct).toBe(50); // 85*0.5 + 15*0.5
    ip.ytdlp('A', p({ downloaded: 1000, total: 1000 }));
    ip.ffmpeg(100e6);
    expect(ip.compute().pct).toBe(99.9);
  });

  it('monotonía: nunca baja dentro del intento', () => {
    const ip = new ItemProgress([{ role: 'A', formatId: 'x', bytes: 1000 }], 10);
    ip.ytdlp('A', p({ downloaded: 800, total: 1000 }));
    const a = ip.compute().pct;
    ip.ytdlp('A', p({ downloaded: 100, total: 1000 }));
    expect(ip.compute().pct).toBe(a);
  });

  it('sin tamaño conocido usa el tiempo de ffmpeg', () => {
    const ip = new ItemProgress([{ role: 'A', formatId: 'hls', bytes: null }], 100);
    ip.ytdlp('A', p({ downloaded: 12345 }));
    expect(ip.compute().pct).toBe(0);
    ip.ffmpeg(40e6);
    expect(ip.compute().pct).toBe(40); // 85*0.4 + 15*0.4
  });

  it('video: suma de dos yt-dlp; A sin líneas usa meta.bytes y dl=0 (no infla)', () => {
    const ip = new ItemProgress(
      [{ role: 'V', formatId: '136', bytes: 9000 }, { role: 'A', formatId: '140', bytes: 1000 }],
      100,
    );
    ip.ytdlp('V', p({ downloaded: 9000, total: 9000 }));
    // dlFrac = 9000 / 10000 = 0.9 (no 1.0)
    expect(ip.compute().pct).toBe(76.5);
    ip.ytdlp('A', p({ downloaded: 1000, total: 1000 }));
    expect(ip.compute().pct).toBe(85);
  });

  it('un totalP null ⇒ dlTotal null ⇒ % de ffmpeg', () => {
    const ip = new ItemProgress(
      [{ role: 'V', formatId: '136', bytes: null }, { role: 'A', formatId: '140', bytes: 1000 }],
      100,
    );
    ip.ytdlp('A', p({ downloaded: 1000, total: 1000 }));
    ip.ffmpeg(10e6);
    expect(ip.compute().pct).toBe(10);
    ip.ytdlp('V', p({ downloaded: 500, total: 1000 }));
    expect(ip.compute().pct).toBe(65.3); // 85*0.75 + 15*0.1 = 65.25 → 1 decimal
  });

  it('un proceso terminado cuenta como su total aunque la última línea no llegara a 100 %', () => {
    const ip = new ItemProgress([{ role: 'A', formatId: 'x', bytes: 1000 }], 0);
    ip.ytdlp('A', p({ downloaded: 700, total: 1000 }));
    ip.exited('A', true);
    expect(ip.compute()).toMatchObject({ pct: 99.9, phase: 'convert' });
  });

  it('speedBps suma y etaSec es el mayor de los yt-dlp vivos', () => {
    const ip = new ItemProgress(
      [{ role: 'V', formatId: 'v', bytes: 10 }, { role: 'A', formatId: 'a', bytes: 10 }],
      10,
    );
    ip.ytdlp('V', p({ speed: 100, eta: 5 }));
    ip.ytdlp('A', p({ speed: 50, eta: 9 }));
    expect(ip.compute()).toMatchObject({ speedBps: 150, etaSec: 9 });
  });

  it('reinicio por fallback 403: mismo intento, sin retroceso del %', () => {
    const ip = new ItemProgress([{ role: 'A', formatId: 'x', bytes: 1000 }], 100);
    ip.ytdlp('A', p({ downloaded: 400, total: 1000 }));
    const before = ip.compute().pct;
    ip.restart();
    expect(ip.compute().pct).toBe(before);
    ip.ytdlp('A', p({ downloaded: 100, total: 1000 }));
    expect(ip.compute().pct).toBe(before);
    ip.ytdlp('A', p({ downloaded: 600, total: 1000 }));
    expect(ip.compute().pct).toBeGreaterThan(before);
  });
});
