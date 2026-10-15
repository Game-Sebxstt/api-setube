import type { Selection } from '../youtube/formats.js';
import { infoArgs } from '../youtube/metadata.js';
import { playlistArgs } from '../youtube/playlist.js';
import { watchUrl } from '../youtube/url.js';

export const ytdlpInfoArgs = infoArgs;
export const ytdlpPlaylistArgs = playlistArgs;

export const PROGRESS_TEMPLATE = 'download:SETUBE_PROGRESS %(progress)j';

export interface DownloadArgsOpts {
  videoId: string;
  formatId: string;
  infoJson: boolean;
  hls: boolean;
}

export function ytdlpDownloadArgs(o: DownloadArgsOpts): (cookiesPath: string | null) => string[] {
  return (cookiesPath) => [
    '--ignore-config',
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-colors',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--js-runtimes',
    'node',
    '--cache-dir',
    '/tmp/yt-dlp-cache',
    '--socket-timeout',
    '15',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--http-chunk-size',
    '10M',
    ...(cookiesPath ? ['--cookies', cookiesPath] : []),
    '-f',
    o.formatId,
    '-o',
    '-',
    ...(o.hls ? ['--concurrent-fragments', '1'] : []),
    ...(o.infoJson ? ['--load-info-json', '-'] : ['--', watchUrl(o.videoId)]),
  ];
}

export function cleanMetadata(v: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

const FFMPEG_BASE = ['-hide_banner', '-loglevel', 'error', '-nostats'];

export interface FfmpegArgsOpts {
  selection: Pick<Selection, 'format' | 'quality' | 'transcode'>;
  title: string | null;
  artist: string | null;
}

export const progressFd = (format: Selection['format']) => (format === 'mp4' ? 4 : 3);

export function ffmpegArgs(o: FfmpegArgsOpts): string[] {
  const { format, quality, transcode } = o.selection;
  const fd = progressFd(format);
  const base = [...FFMPEG_BASE, '-progress', `pipe:${fd}`];
  const meta = (withArtist: boolean) => [
    '-metadata',
    `title=${cleanMetadata(o.title)}`,
    ...(withArtist ? ['-metadata', `artist=${cleanMetadata(o.artist)}`] : []),
  ];
  switch (format) {
    case 'mp3': {
      const kbps = typeof quality === 'number' ? quality : 192;
      return [
        ...base,
        '-i', 'pipe:0', '-map', '0:a:0', '-vn',
        '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-ar', '44100', '-ac', '2',
        '-write_xing', '0', '-id3v2_version', '3',
        ...meta(true),
        '-f', 'mp3', 'pipe:1',
      ];
    }
    case 'm4a':
      return [
        ...base,
        '-i', 'pipe:0', '-map', '0:a:0', '-vn',
        ...(transcode ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']),
        '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '2000000',
        ...meta(true),
        '-f', 'ipod', 'pipe:1',
      ];
    case 'wav':
      return [
        ...base,
        '-i', 'pipe:0', '-map', '0:a:0', '-vn',
        '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        '-f', 'wav', 'pipe:1',
      ];
    case 'mp4':
      return [
        ...base,
        '-i', 'pipe:0', '-i', 'pipe:3', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        ...meta(false),
        '-f', 'mp4', 'pipe:1',
      ];
  }
}
