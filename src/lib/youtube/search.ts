import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import { createLimiter, type Limiter } from '../limit.js';
import { runYtdlpJson } from './metadata.js';
import { throttledWarn } from './oembed.js';
import { isVideoId, thumbnailUrl } from './url.js';

export interface SearchItem {
  videoId: string;
  title: string | null;
  author: string | null;
  duration: number | null;
  views: number | null;
  live: boolean;
  thumbnail: string;
}

export interface SearchResult {
  query: string;
  items: SearchItem[];
}

export interface SearchDeps {
  redis: Redis;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  maxResults: number;
  ttlSec: number;
  metaTtlSec: number;
  concurrency?: number;
  timeoutMs?: number;
}

export const SEARCH_QUERY_MAX = 100;
const LIVE = new Set(['is_live', 'is_upcoming']);

/** Quita caracteres de control y espacios repetidos. Devuelve `null` si queda vacía. */
export function normalizeQuery(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const q = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q === '') return null;
  return q.length > SEARCH_QUERY_MAX ? q.slice(0, SEARCH_QUERY_MAX).trim() : q;
}

export const searchKey = (query: string) =>
  `search:${createHash('sha256').update(query.toLocaleLowerCase('es')).digest('hex').slice(0, 32)}`;

// El prefijo ytsearchN: lo pone la API: el usuario solo controla el texto, que va después de `--`
export const searchArgs = (query: string, maxResults: number) => (cookiesPath: string | null) => [
  '--ignore-config',
  '--flat-playlist',
  '-J',
  '--no-warnings',
  '--js-runtimes',
  'node',
  '--cache-dir',
  '/tmp/yt-dlp-cache',
  '--socket-timeout',
  '15',
  ...(cookiesPath ? ['--cookies', cookiesPath] : []),
  '--',
  `ytsearch${maxResults}:${query}`,
];

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export function toSearchResult(query: string, raw: Json, maxResults: number): SearchResult {
  const entries = Array.isArray(raw.entries) ? (raw.entries as Json[]) : [];
  const seen = new Set<string>();
  const items: SearchItem[] = [];
  for (const e of entries) {
    const id = e?.id;
    // Solo videos: la búsqueda puede traer canales o playlists según la consulta
    if (!isVideoId(id) || seen.has(id) || (e.ie_key !== undefined && e.ie_key !== 'Youtube')) continue;
    seen.add(id);
    items.push({
      videoId: id,
      title: str(e.title),
      author: str(e.channel) ?? str(e.uploader),
      duration: posInt(e.duration),
      views: posInt(e.view_count),
      live: typeof e.live_status === 'string' && LIVE.has(e.live_status),
      thumbnail: thumbnailUrl(id),
    });
    if (items.length >= maxResults) break;
  }
  return { query, items };
}

export function createSearch(deps: SearchDeps) {
  const warn = throttledWarn(deps.log);
  const limit: Limiter = createLimiter(deps.concurrency ?? 2);
  const inflight = new Map<string, Promise<SearchResult>>();

  async function load(query: string, key: string): Promise<SearchResult> {
    let raw: Json;
    try {
      raw = await limit(() => runYtdlpJson(searchArgs(query, deps.maxResults), deps.timeoutMs ?? 30_000));
    } catch (e) {
      if (e instanceof AppError && e.code.startsWith('UPSTREAM')) deps.log.warn({ code: e.code }, 'search_failed');
      // Los códigos propios de un video no tienen sentido para una búsqueda
      if (e instanceof AppError && ['VIDEO_UNAVAILABLE', 'PRIVATE_VIDEO', 'AGE_RESTRICTED', 'LIVE_NOT_SUPPORTED', 'UPSTREAM_FORBIDDEN'].includes(e.code)) {
        throw new AppError('UPSTREAM_ERROR');
      }
      throw e;
    }
    const result = toSearchResult(query, raw, deps.maxResults);
    try {
      const p = deps.redis.pipeline();
      p.set(key, JSON.stringify(result), 'EX', deps.ttlSec);
      // Igual que las playlists: el título y la duración sirven para crear jobs sin pedir la metadata
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
    async search(rawQuery: string): Promise<SearchResult> {
      const query = normalizeQuery(rawQuery);
      if (!query) throw new AppError('INVALID_INPUT', { details: { field: 'q' } });
      const key = searchKey(query);
      try {
        const cached = await deps.redis.get(key);
        if (cached) return { ...(JSON.parse(cached) as SearchResult), query };
      } catch (e) {
        warn('cache_unavailable', { err: { message: (e as Error).message } });
      }
      const running = inflight.get(key);
      if (running) return running.then((r) => ({ ...r, query }));
      const p = load(query, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}

export type SearchService = ReturnType<typeof createSearch>;
