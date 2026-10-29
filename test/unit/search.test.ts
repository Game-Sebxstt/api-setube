import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Value } from 'typebox/value';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { configureProc, SETUBE_TMP } from '../../src/lib/media/proc.js';
import { createSearch, normalizeQuery, searchArgs, searchKey, toSearchResult, type SearchService } from '../../src/lib/youtube/search.js';
import { SearchResponse } from '../../src/schemas/search.js';
import { buildFakeApp, fakeRedis } from './helpers/fake-app.js';

const raw = {
  _type: 'playlist',
  entries: [
    { ie_key: 'Youtube', id: '_PJvpq8uOZM', title: 'BAD BUNNY - MONACO', channel: 'Bad Bunny', duration: 440, view_count: 249332660, live_status: null },
    { ie_key: 'Youtube', id: 'rFZHOHl-L8A', title: 'lofi radio', uploader: 'Lofi Girl', duration: null, live_status: 'is_live' },
    { ie_key: 'YoutubeTab', id: 'UCmBA_wu8xGg1OfOkfW13Q0Q', title: 'Canal' },
    { ie_key: 'Youtube', id: 'no-valido', title: 'x' },
    { ie_key: 'Youtube', id: '_PJvpq8uOZM', title: 'duplicado' },
    { ie_key: 'Youtube', id: 'jNQXAC9IVRw', title: '', channel: '', duration: 19.4, view_count: -1 },
  ],
};

describe('normalizeQuery y searchKey', () => {
  it('quita control y espacios repetidos, recorta a 100 y rechaza vacías', () => {
    expect(normalizeQuery('  bad\tbunny \n monaco\u0000 ')).toBe('bad bunny monaco');
    expect(normalizeQuery(' \n\t ')).toBeNull();
    expect(normalizeQuery('a'.repeat(150))).toHaveLength(100);
  });

  it('la clave de caché no depende de mayúsculas ni contiene la consulta', () => {
    expect(searchKey('Bad Bunny')).toBe(searchKey('bad bunny'));
    expect(searchKey('bad bunny')).toMatch(/^search:[0-9a-f]{32}$/);
  });
});

describe('searchArgs', () => {
  it('el texto va tras `--` con el prefijo fijo ytsearchN:', () => {
    const argv = searchArgs('--exec rm -rf /', 12)(null);
    expect(argv.slice(-2)).toEqual(['--', 'ytsearch12:--exec rm -rf /']);
    expect(argv).toContain('--flat-playlist');
    expect(argv).not.toContain('--cookies');
    const withCookies = searchArgs('x', 5)('/tmp/setube/w-1/ck.txt');
    expect(withCookies[withCookies.indexOf('--cookies') + 1]).toBe('/tmp/setube/w-1/ck.txt');
  });
});

describe('toSearchResult', () => {
  it('solo videos válidos y sin repetir, con live, vistas y miniatura', () => {
    const r = toSearchResult('q', raw, 12);
    expect(r.items.map((i) => i.videoId)).toEqual(['_PJvpq8uOZM', 'rFZHOHl-L8A', 'jNQXAC9IVRw']);
    expect(r.items[0]).toEqual({
      videoId: '_PJvpq8uOZM',
      title: 'BAD BUNNY - MONACO',
      author: 'Bad Bunny',
      duration: 440,
      views: 249332660,
      live: false,
      thumbnail: 'https://i.ytimg.com/vi/_PJvpq8uOZM/mqdefault.jpg',
    });
    expect(r.items[1]).toMatchObject({ author: 'Lofi Girl', live: true, duration: null, views: null });
    expect(r.items[2]).toMatchObject({ title: null, author: null, duration: 19, views: null });
    expect(Value.Check(SearchResponse, r)).toBe(true);
  });

  it('respeta el máximo y tolera entries ausentes', () => {
    expect(toSearchResult('q', raw, 1).items).toHaveLength(1);
    expect(toSearchResult('q', {}, 12).items).toEqual([]);
  });
});

describe('createSearch con yt-dlp falso', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
    script = path.join(dir, 'fake.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
const q = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, q + '\\n');
if (q.includes('bloqueo')) { process.stderr.write("ERROR: [youtube] Sign in to confirm you're not a bot\\n"); process.exit(1); }
process.stdout.write(JSON.stringify(${JSON.stringify(raw)}));`,
    );
    fs.mkdirSync(SETUBE_TMP, { recursive: true, mode: 0o700 });
    configureProc({ ytdlpPath: process.execPath, ytdlpArgsPrefix: [script], ytdlpNet: { potProviderUrl: null, proxy: null } });
  });
  afterAll(() => {
    configureProc({ ytdlpPath: 'yt-dlp', ytdlpArgsPrefix: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');

  function memRedis() {
    const store = new Map<string, string>();
    const redis = fakeRedis({
      get: async (k: unknown) => store.get(String(k)) ?? null,
    });
    (redis as unknown as { pipeline: () => unknown }).pipeline = () => {
      const ops: [string, string][] = [];
      const p = {
        set: (k: string, v: string) => {
          ops.push([k, v]);
          return p;
        },
        exec: async () => {
          for (const [k, v] of ops) store.set(k, v);
          return [];
        },
      };
      return p;
    };
    return { redis, store };
  }
  const log = { warn: () => undefined, info: () => undefined };

  it('busca, guarda en caché (también meta:lite) y deduplica búsquedas simultáneas', async () => {
    const { redis, store } = memRedis();
    const s = createSearch({ redis, log, maxResults: 12, ttlSec: 60, metaTtlSec: 60 });
    const [a, b] = await Promise.all([s.search('Bad  Bunny'), s.search('bad bunny')]);
    expect(a.items).toHaveLength(3);
    expect(b.items).toHaveLength(3);
    expect(calls()).toEqual(['ytsearch12:Bad Bunny']);
    expect(store.has(searchKey('bad bunny'))).toBe(true);
    expect(JSON.parse(store.get('meta:lite:_PJvpq8uOZM') ?? '{}')).toEqual({ title: 'BAD BUNNY - MONACO', duration: 440 });
    const c = await s.search('BAD BUNNY');
    expect(c.query).toBe('BAD BUNNY');
    expect(calls()).toHaveLength(1);
  });

  it('el bloqueo de YouTube se propaga como UPSTREAM_BLOCKED y la consulta vacía es INVALID_INPUT', async () => {
    const s = createSearch({ redis: memRedis().redis, log, maxResults: 12, ttlSec: 60, metaTtlSec: 60 });
    await expect(s.search('bloqueo')).rejects.toMatchObject({ code: 'UPSTREAM_BLOCKED' });
    await expect(s.search('   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('GET /api/search', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  const service = (impl: SearchService['search']): SearchService => ({ search: impl });

  it('devuelve resultados, cachea 5 min y expone search en /api/config', async () => {
    let got = '';
    app = await buildFakeApp({}, { youtube: { search: service(async (q) => ((got = q), toSearchResult(q, raw, 12))) } });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=bad%20bunny' });
    expect(res.statusCode).toBe(200);
    expect(got).toBe('bad bunny');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().items).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json().search).toBe(true);
  });

  it('valida q y respeta SEARCH_ENABLED=false', async () => {
    app = await buildFakeApp({}, { youtube: { search: service(async () => ({ query: '', items: [] })) } });
    expect((await app.inject({ method: 'GET', url: '/api/search' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/search?q=${'a'.repeat(201)}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/search?q=x&extra=1' })).statusCode).toBe(400);
    await app.close();
    app = await buildFakeApp({}, { youtube: { search: service(async () => ({ query: '', items: [] })) } }, { SEARCH_ENABLED: 'false' });
    expect((await app.inject({ method: 'GET', url: '/api/search?q=x' })).json().error.code).toBe('SERVICE_UNAVAILABLE');
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json().search).toBe(false);
  });

  it('los errores del servicio salen con el formato estándar', async () => {
    app = await buildFakeApp({}, { youtube: { search: service(async () => Promise.reject(new AppError('UPSTREAM_BLOCKED'))) } });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=x' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_BLOCKED');
  });
});
