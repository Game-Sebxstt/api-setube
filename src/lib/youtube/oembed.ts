import type { Redis } from 'ioredis';
import { mapLimit } from '../limit.js';
import { playlistUrl, watchUrl } from './url.js';

export interface OembedInfo {
  title: string | null;
  author: string | null;
  error?: 'VIDEO_UNAVAILABLE';
}

export interface OembedLogger {
  warn(obj: object, msg: string): void;
}

export interface OembedDeps {
  redis: Redis;
  fetch: typeof fetch;
  ttlSec: number;
  log: OembedLogger;
  timeoutMs?: number;
  concurrency?: number;
}

const NEGATIVE_TTL_SEC = 600;
const ENDPOINT = 'https://www.youtube.com/oembed';

const oembedUrl = (target: string) => `${ENDPOINT}?${new URLSearchParams({ format: 'json', url: target }).toString()}`;

type Outcome = { kind: 'ok'; title: string | null; author: string | null } | { kind: 'gone' } | { kind: 'unknown' };

export function throttledWarn(log: OembedLogger, everyMs = 60_000) {
  const last = new Map<string, number>();
  const counts = new Map<string, number>();
  return (msg: string, obj: object = {}) => {
    const now = Date.now();
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
    if (now - (last.get(msg) ?? 0) < everyMs) return;
    last.set(msg, now);
    log.warn({ ...obj, count: counts.get(msg) }, msg);
    counts.set(msg, 0);
  };
}

export function createOembed(deps: OembedDeps) {
  const timeoutMs = deps.timeoutMs ?? 2500;
  const concurrency = deps.concurrency ?? 8;
  const warn = throttledWarn(deps.log);

  async function fetchOne(target: string): Promise<Outcome> {
    try {
      const res = await deps.fetch(oembedUrl(target), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (res.status === 404 || res.status === 400) return { kind: 'gone' };
      if (!res.ok) {
        warn('oembed_unavailable', { status: res.status });
        return { kind: 'unknown' };
      }
      const j = (await res.json()) as { title?: unknown; author_name?: unknown };
      return {
        kind: 'ok',
        title: typeof j.title === 'string' && j.title !== '' ? j.title : null,
        author: typeof j.author_name === 'string' && j.author_name !== '' ? j.author_name : null,
      };
    } catch {
      warn('oembed_unavailable', { status: 'timeout_or_network' });
      return { kind: 'unknown' };
    }
  }

  async function videos(ids: readonly string[]): Promise<Map<string, OembedInfo>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, OembedInfo>();
    let cached: (string | null)[] = [];
    let cacheOk = true;
    if (unique.length) {
      try {
        cached = await deps.redis.mget(...unique.map((id) => `oembed:${id}`));
      } catch (e) {
        cacheOk = false;
        warn('cache_unavailable', { err: { message: (e as Error).message } });
      }
    }
    const misses: string[] = [];
    unique.forEach((id, i) => {
      const raw = cached[i];
      if (raw) {
        try {
          const v = JSON.parse(raw) as { title?: string | null; author?: string | null; error?: string };
          out.set(id, v.error === 'VIDEO_UNAVAILABLE' ? { title: null, author: null, error: 'VIDEO_UNAVAILABLE' } : { title: v.title ?? null, author: v.author ?? null });
          return;
        } catch {
          /* entrada corrupta: se trata como miss */
        }
      }
      misses.push(id);
    });

    const results = await mapLimit(misses, concurrency, (id) => fetchOne(watchUrl(id)));
    const writes: [string, string, number][] = [];
    misses.forEach((id, i) => {
      const r = results[i] as Outcome;
      if (r.kind === 'ok') {
        out.set(id, { title: r.title, author: r.author });
        writes.push([`oembed:${id}`, JSON.stringify({ title: r.title, author: r.author }), deps.ttlSec]);
      } else if (r.kind === 'gone') {
        out.set(id, { title: null, author: null, error: 'VIDEO_UNAVAILABLE' });
        writes.push([`oembed:${id}`, JSON.stringify({ error: 'VIDEO_UNAVAILABLE' }), NEGATIVE_TTL_SEC]);
      } else {
        out.set(id, { title: null, author: null });
      }
    });
    if (cacheOk && writes.length) {
      try {
        const p = deps.redis.pipeline();
        for (const [k, v, ttl] of writes) p.set(k, v, 'EX', ttl);
        await p.exec();
      } catch (e) {
        warn('cache_unavailable', { err: { message: (e as Error).message } });
      }
    }
    return out;
  }

  async function playlist(id: string): Promise<{ title: string | null; author: string | null }> {
    const key = `oembed:pl:${id}`;
    let cacheOk = true;
    try {
      const raw = await deps.redis.get(key);
      if (raw) {
        const v = JSON.parse(raw) as { title?: string | null; author?: string | null };
        return { title: v.title ?? null, author: v.author ?? null };
      }
    } catch (e) {
      cacheOk = false;
      warn('cache_unavailable', { err: { message: (e as Error).message } });
    }
    const r = await fetchOne(playlistUrl(id));
    const value = r.kind === 'ok' ? { title: r.title, author: r.author } : { title: null, author: null };
    if (cacheOk && r.kind !== 'unknown') {
      await deps.redis
        .set(key, JSON.stringify(value), 'EX', r.kind === 'ok' ? deps.ttlSec : NEGATIVE_TTL_SEC)
        .catch((e: Error) => warn('cache_unavailable', { err: { message: e.message } }));
    }
    return value;
  }

  return { videos, playlist };
}

export type OembedService = ReturnType<typeof createOembed>;
