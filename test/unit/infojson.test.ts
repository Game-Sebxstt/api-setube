import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expireTs, gunzipInfo, gzipInfo, infoJsonTtl, sanitizeInfoJson } from '../../src/lib/youtube/infojson.js';

type Json = Record<string, unknown>;
const load = () => JSON.parse(readFileSync(new URL('../fixtures/info-sample.json', import.meta.url), 'utf8')) as Json;

function forbiddenPaths(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => forbiddenPaths(x, `${at}/${i}`));
  if (typeof v !== 'object' || v === null) return [];
  return Object.entries(v).flatMap(([k, val]) => {
    const here = `${at}/${k}`;
    const bad = /^cookies?$/i.test(k) || k === 'webpage_url' || k === 'original_url' ? [here] : [];
    return [...bad, ...forbiddenPaths(val, here)];
  });
}

describe('sanitizeInfoJson', () => {
  it('el fixture tiene lo que hay que quitar', () => {
    expect(forbiddenPaths(load()).length).toBeGreaterThanOrEqual(6);
  });

  it('sin webpage_url/original_url ni ninguna clave cookies/Cookie a ningún nivel', () => {
    const out = sanitizeInfoJson(load());
    expect(forbiddenPaths(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('no-es-real');
  });

  it('conserva url y el resto de http_headers', () => {
    const out = sanitizeInfoJson(load());
    const formats = out.formats as Json[];
    const f139 = formats.find((f) => f.format_id === '139') as Json;
    expect(f139.url).toContain('itag=139');
    expect(f139.http_headers).toEqual({ 'User-Agent': 'Mozilla/5.0', Accept: '*/*' });
    expect(out.http_headers).toEqual({ 'User-Agent': 'Mozilla/5.0' });
    const f160 = formats.find((f) => f.format_id === '160') as Json;
    expect(f160.fragments).toBeDefined();
  });

  it('quita storyboards/mhtml y los campos pesados', () => {
    const out = sanitizeInfoJson(load());
    const ids = (out.formats as Json[]).map((f) => f.format_id);
    expect(ids).not.toContain('sb0');
    for (const k of ['automatic_captions', 'subtitles', 'thumbnails', 'heatmap', 'description', 'tags', 'chapters', 'comments', 'requested_formats', 'requested_subtitles', '_format_sort_fields']) {
      expect(out).not.toHaveProperty(k);
    }
    expect(out.title).toBe('Me at the zoo');
    expect(out.duration).toBe(19);
  });

  it('no muta la entrada', () => {
    const input = load();
    sanitizeInfoJson(input);
    expect(input.webpage_url).toBeDefined();
    expect(input.cookies).toBeDefined();
  });

  it('gzip ida y vuelta', () => {
    const out = sanitizeInfoJson(load());
    expect(gunzipInfo(gzipInfo(out))).toEqual(out);
  });
});

describe('frescura', () => {
  it('expireTs del primer formato con URL', () => {
    expect(expireTs(load())).toBe(1999999999);
  });

  it('TTL = min(INFO_JSON_TTL_SEC, expire − now − 1800); < 60 → null', () => {
    const info = load();
    expect(infoJsonTtl(info, 10800, 1999999999 - 100000)).toBe(10800);
    expect(infoJsonTtl(info, 10800, 1999999999 - 1800 - 3600)).toBe(3600);
    expect(infoJsonTtl(info, 10800, 1999999999 - 1800 - 59)).toBeNull();
    expect(infoJsonTtl({ formats: [] }, 10800)).toBe(10800);
  });
});
