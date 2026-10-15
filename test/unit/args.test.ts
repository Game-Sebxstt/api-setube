import { describe, expect, it } from 'vitest';
import { cleanMetadata, ffmpegArgs, progressFd, ytdlpDownloadArgs, ytdlpInfoArgs } from '../../src/lib/media/args.js';

const ID = 'jNQXAC9IVRw';
const BASE_FF = ['-hide_banner', '-loglevel', 'error', '-nostats'];

const withPrefix = (prefix: string[], args: string[]) => [...prefix, ...args];

describe('ytdlpDownloadArgs', () => {
  it('argv exacto con --load-info-json - (nunca /dev/stdin) y sin cookies', () => {
    const argv = ytdlpDownloadArgs({ videoId: ID, formatId: '251', infoJson: true, hls: false })(null);
    expect(argv).toEqual([
      '--ignore-config', '--no-playlist', '--newline', '--progress', '--no-colors',
      '--progress-template', 'download:SETUBE_PROGRESS %(progress)j',
      '--js-runtimes', 'node', '--cache-dir', '/tmp/yt-dlp-cache',
      '--socket-timeout', '15', '--retries', '3', '--fragment-retries', '3', '--http-chunk-size', '10M',
      '-f', '251', '-o', '-',
      '--load-info-json', '-',
    ]);
    expect(argv.join(' ')).not.toContain('/dev/stdin');
    expect(argv).not.toContain(ID);
  });

  it('con cookies del workDir del proceso', () => {
    const argv = ytdlpDownloadArgs({ videoId: ID, formatId: '140', infoJson: true, hls: false })('/tmp/setube/w-abc/ck-1.txt');
    const i = argv.indexOf('--cookies');
    expect(argv[i + 1]).toBe('/tmp/setube/w-abc/ck-1.txt');
  });

  it('ruta de extracción (YTDLP_INFO_JSON=false): videoId tras --', () => {
    const argv = ytdlpDownloadArgs({ videoId: ID, formatId: '140', infoJson: false, hls: false })(null);
    expect(argv).not.toContain('--load-info-json');
    expect(argv.slice(-2)).toEqual(['--', `https://www.youtube.com/watch?v=${ID}`]);
  });

  it('el respaldo HLS añade --concurrent-fragments 1', () => {
    const argv = ytdlpDownloadArgs({ videoId: ID, formatId: '233', infoJson: true, hls: true })(null);
    const i = argv.indexOf('--concurrent-fragments');
    expect(argv[i + 1]).toBe('1');
    expect(ytdlpDownloadArgs({ videoId: ID, formatId: '140', infoJson: true, hls: false })(null)).not.toContain('--concurrent-fragments');
  });

  it('YTDLP_ARGS_PREFIX se antepone', () => {
    const argv = withPrefix(['test/fixtures/fake-ytdlp.mjs'], ytdlpDownloadArgs({ videoId: ID, formatId: '1', infoJson: true, hls: false })(null));
    expect(argv[0]).toBe('test/fixtures/fake-ytdlp.mjs');
    expect(argv[1]).toBe('--ignore-config');
  });

  it('-J de metadata: videoId tras --', () => {
    const argv = ytdlpInfoArgs(ID)(null);
    expect(argv.slice(-2)).toEqual(['--', `https://www.youtube.com/watch?v=${ID}`]);
    expect(argv).toContain('-J');
  });
});

describe('ffmpegArgs', () => {
  const t = { title: 'Mi "canción"\u0000\n', artist: 'Autor\u0007' };

  it.each([128, 192, 320] as const)('mp3 %i kbps CBR', (q) => {
    expect(ffmpegArgs({ selection: { format: 'mp3', quality: q, transcode: false }, ...t })).toEqual([
      ...BASE_FF, '-progress', 'pipe:3',
      '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${q}k`, '-ar', '44100', '-ac', '2',
      '-write_xing', '0', '-id3v2_version', '3',
      '-metadata', 'title=Mi "canción"', '-metadata', 'artist=Autor',
      '-f', 'mp3', 'pipe:1',
    ]);
  });

  it('m4a copia', () => {
    expect(ffmpegArgs({ selection: { format: 'm4a', quality: null, transcode: false }, ...t })).toEqual([
      ...BASE_FF, '-progress', 'pipe:3',
      '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-c:a', 'copy',
      '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '2000000',
      '-metadata', 'title=Mi "canción"', '-metadata', 'artist=Autor',
      '-f', 'ipod', 'pipe:1',
    ]);
  });

  it('m4a fallback recodifica a AAC 192k', () => {
    const argv = ffmpegArgs({ selection: { format: 'm4a', quality: null, transcode: true }, ...t });
    expect(argv.join(' ')).toContain('-c:a aac -b:a 192k');
    expect(argv).not.toContain('copy');
  });

  it('wav', () => {
    expect(ffmpegArgs({ selection: { format: 'wav', quality: null, transcode: false }, ...t })).toEqual([
      ...BASE_FF, '-progress', 'pipe:3',
      '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', '-f', 'wav', 'pipe:1',
    ]);
  });

  it('mp4 sin recodificar, audio por pipe:3 y progreso por pipe:4', () => {
    expect(ffmpegArgs({ selection: { format: 'mp4', quality: 720, transcode: false }, ...t })).toEqual([
      ...BASE_FF, '-progress', 'pipe:4',
      '-i', 'pipe:0', '-i', 'pipe:3', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-metadata', 'title=Mi "canción"',
      '-f', 'mp4', 'pipe:1',
    ]);
    expect(progressFd('mp4')).toBe(4);
    expect(progressFd('mp3')).toBe(3);
  });

  it('ningún argumento con espacios sin separar (salvo valores de -metadata)', () => {
    for (const format of ['mp3', 'm4a', 'wav', 'mp4'] as const) {
      const argv = ffmpegArgs({ selection: { format, quality: format === 'mp3' ? 192 : null, transcode: false }, title: 'a b', artist: 'c d' });
      argv.forEach((a, i) => {
        if (argv[i - 1] === '-metadata') return;
        expect(a).not.toMatch(/\s/);
      });
    }
    const y = ytdlpDownloadArgs({ videoId: ID, formatId: '1', infoJson: true, hls: true })('/tmp/x/ck.txt');
    y.forEach((a, i) => {
      if (y[i - 1] === '--progress-template') return;
      expect(a).not.toMatch(/\s/);
    });
  });

  it('cleanMetadata quita \\0 y controles', () => {
    expect(cleanMetadata('a\u0000b\r\nc\u009f')).toBe('a b c');
    expect(cleanMetadata(null)).toBe('');
  });
});
