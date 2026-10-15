import type { Meta } from '../../../src/lib/youtube/metadata.js';

export const pattern = (n: number): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255;
  return b;
};

export const nowSec = () => Math.floor(Date.now() / 1000);

export const gvUrl = (itag: string, extra = '') =>
  `https://rr1---sn-test.googlevideo.com/videoplayback?expire=${nowSec() + 6 * 3600}&itag=${itag}&ip=203.0.113.9${extra}`;

export function audioFormat(id: string, size: number | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  const opus = id === '251' || id.startsWith('25');
  return {
    format_id: id,
    ext: opus ? 'webm' : 'm4a',
    acodec: opus ? 'opus' : 'mp4a.40.2',
    vcodec: 'none',
    protocol: 'https',
    abr: opus ? 130 : 128,
    ...(size !== null ? { filesize: size } : {}),
    url: gvUrl(id),
    http_headers: { 'User-Agent': 'UA-test', Accept: '*/*' },
    ...over,
  };
}

export const infoWith = (formats: Record<string, unknown>[], epoch = nowSec()) => ({ id: 'jNQXAC9IVRw', epoch, formats });

export function fakeMeta(over: Partial<Meta> = {}): Meta {
  return {
    videoId: 'jNQXAC9IVRw',
    title: 'Me at the zoo',
    author: 'jawed',
    duration: 19,
    live: false,
    description: null,
    ageLimit: 0,
    fetchedAt: new Date().toISOString(),
    audio: { m4a: { formatId: '140', abr: 128, bytes: 1000 }, opus: { formatId: '251', abr: 130, bytes: 1000 } },
    formatGaps: [],
    video: [],
    ...over,
  };
}

export interface Call {
  url: string;
  range: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
  signal: AbortSignal | undefined;
}

type Handler = (c: Call, n: number) => Response | Promise<Response>;

export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = { url: String(input), range: headers.Range ?? '', headers, redirect: init?.redirect, signal: init?.signal ?? undefined };
    calls.push(c);
    if (c.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(c, calls.length);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// Sirve `data` respetando Range, en bloques de `block` bytes y con stream de tipo pull
export function serve(data: Buffer, c: Call, o: { block?: number; contentType?: string; truncateAt?: number } = {}): Response {
  const m = /^bytes=(\d+)-(\d+)$/.exec(c.range);
  if (!m) return new Response(null, { status: 200 });
  const start = Number(m[1]);
  if (start >= data.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${data.length}` } });
  const end = Math.min(Number(m[2]), data.length - 1);
  const block = o.block ?? 16 * 1024;
  let pos = start;
  const stop = o.truncateAt !== undefined ? Math.min(end + 1, o.truncateAt) : end + 1;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      // Igual que undici: abortar la señal corta también el cuerpo
      if (c.signal?.aborted) return ctrl.error(new DOMException('aborted', 'AbortError'));
      if (pos >= stop) return ctrl.close();
      const n = Math.min(block, stop - pos);
      ctrl.enqueue(new Uint8Array(data.subarray(pos, pos + n)));
      pos += n;
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-type': o.contentType ?? 'audio/mp4' },
  });
}

export const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });
