import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppError, type ErrorCode } from '../errors.js';
import { createLimiter, type Limiter } from '../limit.js';
import { collect, spawnYtdlp } from '../media/proc.js';
import { deriveFormats, type MetaFormats, type RawFormat } from './formats.js';
import { gunzipInfo, gzipInfo, infoJsonTtl, sanitizeInfoJson } from './infojson.js';
import { watchUrl } from './url.js';
import { classifyYtdlpError } from './ytdlp-errors.js';
import { throttledWarn } from './oembed.js';

type Json = Record<string, unknown>;

export interface Meta extends MetaFormats {
  videoId: string;
  title: string | null;
  author: string | null;
  duration: number;
  live: boolean;
  description: string | null;
  ageLimit: number;
  fetchedAt: string;
}

export interface MetaLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export interface MetadataDeps {
  redis: Redis;
  log: MetaLogger;
  metaTtlSec: number;
  infoJsonTtlSec: number;
  metaConcurrency: number;
  timeoutMs?: number;
  lockPollMs?: number;
  lockWaitMs?: number;
}

const NEGATIVE_TTL_SEC = 600;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const LIVE = new Set(['is_live', 'is_upcoming', 'post_live']);
const DESCRIPTION_MAX = 200;
const NEGATIVE_CODES = new Set<ErrorCode>(['VIDEO_UNAVAILABLE', 'PRIVATE_VIDEO']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (ms: number) => Math.round(ms * (0.7 + Math.random() * 0.6));

export function clipDescription(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (t === '') return null;
  const cps = Array.from(t);
  return cps.length > DESCRIPTION_MAX ? cps.slice(0, DESCRIPTION_MAX).join('') + '…' : t;
}

export function deriveMeta(videoId: string, info: Json, now = new Date()): Meta {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const formats = Array.isArray(info.formats) ? (info.formats as RawFormat[]) : [];
  return {
    videoId,
    title: str(info.title),
    author: str(info.channel) ?? str(info.uploader),
    duration: typeof info.duration === 'number' && Number.isFinite(info.duration) ? Math.round(info.duration) : 0,
    live: typeof info.live_status === 'string' && LIVE.has(info.live_status),
    description: clipDescription(info.description),
    ageLimit: typeof info.age_limit === 'number' ? info.age_limit : 0,
    fetchedAt: now.toISOString(),
    ...deriveFormats(formats),
  };
}

export async function runYtdlpJson(args: (cookiesPath: string | null) => string[], timeoutMs: number): Promise<Json> {
  const proc = await spawnYtdlp(args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const r = await collect(proc.child, proc.exited, { timeoutMs, maxBytes: MAX_JSON_BYTES });
  if (r.timedOut) throw new AppError('UPSTREAM_TIMEOUT');
  if (r.overflow) throw new AppError('UPSTREAM_ERROR', { details: { reason: 'json_too_large' } });
  if (r.exit.code === null && r.exit.signal === null) throw new AppError('INTERNAL', { message: 'yt-dlp no se pudo ejecutar.' });
  if (r.exit.code !== 0) {
    const code = classifyYtdlpError(r.stderr.lines(), r.exit.code) ?? 'UPSTREAM_ERROR';
    throw new AppError(code, { details: undefined, cause: new Error(r.stderr.lines().slice(-5).join('\n')) });
  }
  try {
    const parsed: unknown = JSON.parse(r.stdout.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('no es un objeto');
    return parsed as Json;
  } catch {
    throw new AppError('UPSTREAM_ERROR', { details: { reason: 'invalid_json' } });
  }
}

export const infoArgs = (videoId: string) => (cookiesPath: string | null) => [
  '--ignore-config',
  '--no-playlist',
  '-J',
  '--skip-download',
  '--no-warnings',
  '--js-runtimes',
  'node',
  '--cache-dir',
  '/tmp/yt-dlp-cache',
  '--socket-timeout',
  '15',
  ...(cookiesPath ? ['--cookies', cookiesPath] : []),
  '--',
  watchUrl(videoId),
];

const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export function createMetadata(deps: MetadataDeps) {
  const limit: Limiter = createLimiter(deps.metaConcurrency);
  const inflight = new Map<string, Promise<{ meta: Meta; infoJson: Json | null }>>();
  const instance = randomUUID();
  const warn = throttledWarn(deps.log);
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const pollMs = deps.lockPollMs ?? 250;
  const lockWaitMs = deps.lockWaitMs ?? 35_000;

  async function cacheGet(key: string): Promise<string | null> {
    try {
      return await deps.redis.get(key);
    } catch (e) {
      warn('cache_unavailable', { err: { message: (e as Error).message } });
      return null;
    }
  }

  function decodeMeta(raw: string | null): Meta | AppError | null {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Meta | { error: ErrorCode };
      if ('error' in v) return new AppError(v.error);
      return v;
    } catch {
      return null;
    }
  }

  async function extractOnce(videoId: string): Promise<Json> {
    try {
      return await limit(() => runYtdlpJson(infoArgs(videoId), timeoutMs));
    } catch (e) {
      if (e instanceof AppError && e.code === 'UPSTREAM_ERROR') {
        await sleep(jitter(500));
        return limit(() => runYtdlpJson(infoArgs(videoId), timeoutMs));
      }
      throw e;
    }
  }

  async function store(videoId: string, raw: Json): Promise<{ meta: Meta; infoJson: Json | null }> {
    const meta = deriveMeta(videoId, raw);
    const infoJson = sanitizeInfoJson(raw);
    const ttl = infoJsonTtl(infoJson, deps.infoJsonTtlSec);
    try {
      const p = deps.redis.pipeline();
      p.set(`meta:${videoId}`, JSON.stringify(meta), 'EX', deps.metaTtlSec);
      if (ttl !== null) p.set(`ytinfo:${videoId}`, gzipInfo(infoJson), 'EX', ttl);
      else p.del(`ytinfo:${videoId}`);
      await p.exec();
    } catch (e) {
      warn('cache_unavailable', { err: { message: (e as Error).message } });
    }
    return { meta, infoJson };
  }

  async function storeNegative(videoId: string, err: unknown): Promise<void> {
    if (!(err instanceof AppError) || !NEGATIVE_CODES.has(err.code)) return;
    try {
      await deps.redis.set(`meta:${videoId}`, JSON.stringify({ error: err.code }), 'EX', NEGATIVE_TTL_SEC);
    } catch {
      /* degradado */
    }
  }

  function logFailure(videoId: string, err: unknown): void {
    if (!(err instanceof AppError)) return;
    if (err.code === 'UPSTREAM_BLOCKED' || err.code === 'UPSTREAM_TIMEOUT' || err.code === 'UPSTREAM_ERROR') {
      deps.log.warn({ videoId, code: err.code }, 'metadata_failed');
    } else {
      deps.log.info({ videoId, code: err.code }, 'metadata_failed');
    }
  }

  async function tryLock(videoId: string): Promise<boolean | null> {
    try {
      return (await deps.redis.set(`lock:meta:${videoId}`, instance, 'PX', 45_000, 'NX')) === 'OK';
    } catch {
      return null;
    }
  }

  async function releaseLock(videoId: string): Promise<void> {
    try {
      await deps.redis.eval(RELEASE_LOCK, 1, `lock:meta:${videoId}`, instance);
    } catch {
      /* expira solo */
    }
  }

  function extract(videoId: string, fresh: boolean): Promise<{ meta: Meta; infoJson: Json | null }> {
    const key = `${fresh ? 'r' : 'g'}:${videoId}`;
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const locked = await tryLock(videoId);
      if (locked === false) {
        // Otra instancia extrae: sondea hasta 35 s; si no aparece, extrae esta
        const until = Date.now() + lockWaitMs;
        while (Date.now() < until) {
          await sleep(pollMs);
          const lockAlive = await deps.redis.exists(`lock:meta:${videoId}`).catch(() => 0);
          if (fresh && lockAlive) continue;
          const m = decodeMeta(await cacheGet(`meta:${videoId}`));
          if (m instanceof AppError) throw m;
          if (m) {
            const info = await readInfoJson(videoId);
            if (info) return { meta: m, infoJson: info };
            if (!fresh) return { meta: m, infoJson: null };
          }
          if (!lockAlive) break;
        }
      }
      try {
        const raw = await extractOnce(videoId);
        return await store(videoId, raw);
      } catch (e) {
        await storeNegative(videoId, e);
        logFailure(videoId, e);
        throw e;
      } finally {
        if (locked) await releaseLock(videoId);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function readInfoJson(videoId: string): Promise<Json | null> {
    try {
      const buf = await deps.redis.getBuffer(`ytinfo:${videoId}`);
      return buf ? gunzipInfo(buf) : null;
    } catch {
      return null;
    }
  }

  return {
    async get(videoId: string): Promise<Meta> {
      const cached = decodeMeta(await cacheGet(`meta:${videoId}`));
      if (cached instanceof AppError) throw cached;
      if (cached) return cached;
      return (await extract(videoId, false)).meta;
    },
    async refresh(videoId: string): Promise<{ meta: Meta; infoJson: Json }> {
      const r = await extract(videoId, true);
      if (!r.infoJson) throw new AppError('INTERNAL', { message: 'refresh sin info JSON' });
      return { meta: r.meta, infoJson: r.infoJson };
    },
    readInfoJson,
  };
}

export type MetadataService = ReturnType<typeof createMetadata>;
