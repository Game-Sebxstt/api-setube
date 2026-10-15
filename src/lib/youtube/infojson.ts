import { gunzipSync, gzipSync } from 'node:zlib';

type Json = Record<string, unknown>;

const HEAVY_TOP = [
  'automatic_captions',
  'subtitles',
  'thumbnails',
  'heatmap',
  'description',
  'tags',
  'chapters',
  'comments',
  '_format_sort_fields',
  // yt-dlp re-extrae desde webpage_url ante un DownloadError: se quita para que el fallback lo controle Setube
  'webpage_url',
  'original_url',
];

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function stripCookieHeaders(headers: unknown): Json | undefined {
  if (!isObj(headers)) return undefined;
  const out: Json = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'cookie') out[k] = v;
  return out;
}

function sanitizeFormat(f: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === 'cookies') continue;
    if (k === 'http_headers') {
      const h = stripCookieHeaders(v);
      if (h) out[k] = h;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const isStoryboard = (f: Json) => f.format_note === 'storyboard' || f.ext === 'mhtml';

function deepStripCookies(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepStripCookies);
  if (!isObj(v)) return v;
  const out: Json = {};
  for (const [k, val] of Object.entries(v)) {
    if (k.toLowerCase() === 'cookies') continue;
    out[k] = k === 'http_headers' ? stripCookieHeaders(val) ?? val : deepStripCookies(val);
  }
  return out;
}

export function sanitizeInfoJson(info: Json): Json {
  return deepStripCookies(sanitizeTop(info)) as Json;
}

function sanitizeTop(info: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(info)) {
    if (HEAVY_TOP.includes(k) || k.startsWith('requested_') || k === 'cookies') continue;
    if (k === 'http_headers') {
      const h = stripCookieHeaders(v);
      if (h) out[k] = h;
      continue;
    }
    if (k === 'formats' && Array.isArray(v)) {
      out[k] = v.filter((f): f is Json => isObj(f) && !isStoryboard(f)).map(sanitizeFormat);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function expireTs(info: Json): number | null {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  for (const f of formats) {
    if (!isObj(f) || typeof f.url !== 'string') continue;
    try {
      const u = new URL(f.url);
      const e = u.searchParams.get('expire') ?? /\/expire\/(\d+)/.exec(u.pathname)?.[1] ?? null;
      if (e && /^\d+$/.test(e)) return Number(e);
    } catch {
      /* URL inválida */
    }
  }
  return null;
}

export function infoJsonTtl(info: Json, maxTtlSec: number, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const exp = expireTs(info);
  const ttl = exp === null ? maxTtlSec : Math.min(maxTtlSec, exp - nowSec - 1800);
  return ttl < 60 ? null : Math.floor(ttl);
}

export const gzipInfo = (info: Json): Buffer => gzipSync(Buffer.from(JSON.stringify(info)), { level: 6 });
export const gunzipInfo = (buf: Buffer): Json => JSON.parse(gunzipSync(buf).toString('utf8')) as Json;
