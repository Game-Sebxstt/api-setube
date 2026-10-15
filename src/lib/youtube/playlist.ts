import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import { runYtdlpJson } from './metadata.js';
import { throttledWarn } from './oembed.js';
import { isVideoId, playlistUrl, thumbnailUrl } from './url.js';

export interface PlaylistItem {
  videoId: string;
  title: string | null;
  duration: number | null;
  thumbnail: string;
}

export interface PlaylistResult {
  playlistId: string;
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  count: number;
  truncated: boolean;
  skipped: number;
  items: PlaylistItem[];
}

export interface PlaylistDeps {
  redis: Redis;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  maxItems: number;
  ttlSec: number;
  metaTtlSec: number;
  timeoutMs?: number;
}

const HIDDEN_TITLES = new Set(['[Private video]', '[Deleted video]']);

export const playlistArgs = (playlistId: string, maxItems: number) => (cookiesPath: string | null) => [
  '--ignore-config',
  '--flat-playlist',
  '-J',
  '--playlist-end',
  String(maxItems),
  '--js-runtimes',
  'node',
  '--cache-dir',
  '/tmp/yt-dlp-cache',
  ...(cookiesPath ? ['--cookies', cookiesPath] : []),
  '--',
  playlistUrl(playlistId),
];

type Json = Record<string, unknown>;

export function toPlaylistResult(playlistId: string, raw: Json, maxItems: number): PlaylistResult {
  const entries = Array.isArray(raw.entries) ? (raw.entries as Json[]) : [];
  let skipped = 0;
  const items: PlaylistItem[] = [];
  for (const e of entries) {
    const id = e?.id;
    const title = typeof e?.title === 'string' ? e.title : null;
    if (!isVideoId(id) || (title !== null && HIDDEN_TITLES.has(title))) {
      skipped++;
      continue;
    }
    if (items.length >= maxItems) continue;
    items.push({
      videoId: id,
      title,
      duration: typeof e.duration === 'number' && Number.isFinite(e.duration) ? Math.round(e.duration) : null,
      thumbnail: thumbnailUrl(id),
    });
  }
  const count = typeof raw.playlist_count === 'number' ? raw.playlist_count : entries.length;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    playlistId,
    title: str(raw.title),
    thumbnail: items[0]?.thumbnail ?? null,
    author: str(raw.channel) ?? str(raw.uploader),
    count,
    truncated: count > items.length + skipped,
    skipped,
    items,
  };
}

export function createPlaylists(deps: PlaylistDeps) {
  const warn = throttledWarn(deps.log);
  const inflight = new Map<string, Promise<PlaylistResult>>();

  async function load(playlistId: string): Promise<PlaylistResult> {
    let raw: Json;
    try {
      raw = await runYtdlpJson(playlistArgs(playlistId, deps.maxItems), deps.timeoutMs ?? 30_000);
    } catch (e) {
      const stderr = e instanceof AppError && e.cause instanceof Error ? e.cause.message : '';
      if (
        e instanceof AppError &&
        (e.code === 'VIDEO_UNAVAILABLE' ||
          e.code === 'PRIVATE_VIDEO' ||
          (e.code === 'UPSTREAM_ERROR' && /playlist does not exist|playlist is private|playlist.*unavailable/i.test(stderr)))
      ) {
        throw new AppError('PLAYLIST_UNAVAILABLE');
      }
      if (e instanceof AppError && e.code.startsWith('UPSTREAM')) deps.log.warn({ playlistId, code: e.code }, 'playlist_failed');
      if (e instanceof AppError && (e.code === 'AGE_RESTRICTED' || e.code === 'LIVE_NOT_SUPPORTED' || e.code === 'UPSTREAM_FORBIDDEN')) {
        throw new AppError('UPSTREAM_ERROR');
      }
      throw e;
    }
    const result = toPlaylistResult(playlistId, raw, deps.maxItems);
    if (result.items.length === 0) throw new AppError('PLAYLIST_EMPTY');
    try {
      const p = deps.redis.pipeline();
      p.set(`pl:${playlistId}`, JSON.stringify(result), 'EX', deps.ttlSec);
      for (const it of result.items) {
        p.set(`meta:lite:${it.videoId}`, JSON.stringify({ title: it.title, duration: it.duration }), 'EX', deps.metaTtlSec);
      }
      await p.exec();
    } catch (e) {
      warn('cache_unavailable', { err: { message: (e as Error).message } });
    }
    return result;
  }

  return {
    async resolve(playlistId: string): Promise<PlaylistResult> {
      try {
        const cached = await deps.redis.get(`pl:${playlistId}`);
        if (cached) return JSON.parse(cached) as PlaylistResult;
      } catch (e) {
        warn('cache_unavailable', { err: { message: (e as Error).message } });
      }
      const running = inflight.get(playlistId);
      if (running) return running;
      const p = load(playlistId).finally(() => inflight.delete(playlistId));
      inflight.set(playlistId, p);
      return p;
    },
  };
}

export type PlaylistService = ReturnType<typeof createPlaylists>;
