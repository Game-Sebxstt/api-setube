export type { Source } from '../youtube/formats.js';

export interface Opened {
  body: ReadableStream<Uint8Array>;
  start: number;
  end: number;
  total: number;
  finalUrl: string;
  redirects: number;
}

export interface UpstreamDeps {
  fetch: typeof fetch;
  chunkBytes: number;
  headersTimeoutMs?: number;
}

export type UpstreamKind = 'forbidden' | 'gone' | 'range' | 'blocked' | 'network' | 'timeout' | 'invalid' | 'size' | 'aborted';

// Mensaje fijo y sin cause: los errores de undici pueden llevar el host firmado de googlevideo
export class UpstreamError extends Error {
  readonly kind: UpstreamKind;
  readonly total: number | undefined;
  constructor(kind: UpstreamKind, total?: number) {
    super('upstream');
    this.name = 'UpstreamError';
    this.kind = kind;
    this.total = total;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const CONTENT_RANGE = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/;
const UNSATISFIED = /^bytes \*\/(\d{1,16})$/;

export const isGooglevideo = (u: URL) => u.protocol === 'https:' && u.hostname.endsWith('.googlevideo.com');

function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

function statusError(res: Response): UpstreamError {
  switch (res.status) {
    case 403:
      return new UpstreamError('forbidden');
    case 410:
      return new UpstreamError('gone');
    case 416: {
      const m = UNSATISFIED.exec(res.headers.get('content-range') ?? '');
      const t = m?.[1] ? Number(m[1]) : undefined;
      return new UpstreamError('range', t && Number.isSafeInteger(t) && t > 0 ? t : undefined);
    }
    case 429:
      return new UpstreamError('blocked');
    default:
      return new UpstreamError('invalid');
  }
}

export async function openChunk(
  d: UpstreamDeps,
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  total: number | null,
  signal: AbortSignal,
): Promise<Opened> {
  const chunkEnd = Math.min(end, start + d.chunkBytes - 1);
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), d.headersTimeoutMs ?? 15_000);
  t.unref?.();
  const sig = AbortSignal.any([signal, timer.signal]);
  const init: RequestInit = { headers: { ...headers, Range: `bytes=${start}-${chunkEnd}` }, redirect: 'manual', signal: sig };
  let current = url;
  let redirects = 0;
  try {
    for (;;) {
      let res: Response;
      try {
        res = await d.fetch(current, init);
      } catch {
        if (signal.aborted) throw new UpstreamError('aborted');
        if (timer.signal.aborted) throw new UpstreamError('timeout');
        throw new UpstreamError('network');
      }
      if (REDIRECTS.has(res.status)) {
        discard(res);
        const loc = res.headers.get('location');
        if (!loc || redirects >= MAX_REDIRECTS) throw new UpstreamError('invalid');
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          throw new UpstreamError('invalid');
        }
        if (!isGooglevideo(next)) throw new UpstreamError('invalid');
        current = next.toString();
        redirects++;
        continue;
      }
      if (res.status !== 206) {
        discard(res);
        throw statusError(res);
      }
      const m = CONTENT_RANGE.exec(res.headers.get('content-range') ?? '');
      const s = Number(m?.[1]);
      const e = Number(m?.[2]);
      const tt = Number(m?.[3]);
      if (!m || !Number.isSafeInteger(tt) || tt <= 0 || !res.body) {
        discard(res);
        throw new UpstreamError('invalid');
      }
      if (total !== null && tt !== total) {
        discard(res);
        throw new UpstreamError('size', tt);
      }
      if (s !== start || e < s || e > chunkEnd || e >= tt) {
        discard(res);
        throw new UpstreamError('invalid');
      }
      return { body: res.body, start: s, end: e, total: tt, finalUrl: current, redirects };
    }
  } finally {
    clearTimeout(t);
  }
}
