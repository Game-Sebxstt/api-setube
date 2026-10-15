import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, EnvSchema, loadConfig } from '../../src/config/env.js';
import { loggerOptions } from '../../src/lib/logger.js';
import { cookies } from '../../src/lib/media/cookies.js';

const HEX = 'a'.repeat(64);
const COOKIE_VALUE = 'valor-secreto-de-prueba-123';
const COOKIES_JSON = JSON.stringify([
  { domain: '.youtube.com', path: '/', secure: true, httpOnly: true, expirationDate: 2000000000, name: 'PRUEBA', value: COOKIE_VALUE },
]);

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  REDIS_URL: `redis://:${HEX}@redis:6379/0`,
  ...extra,
});

function memLogger() {
  const calls: { obj: object; msg: string }[] = [];
  return { calls, warn: (obj: object, msg: string) => calls.push({ obj, msg }) };
}

function memStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { lines, stream };
}

function keysOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).keys;
  }
  throw new Error('se esperaba ConfigError');
}

beforeEach(() => cookies.reset());
afterEach(() => {
  cookies.reset();
  delete process.env.YOUTUBE_COOKIES_JSON;
});

describe('loadConfig', () => {
  it('aplica defaults', () => {
    const c = loadConfig(base());
    expect(c.port).toBe(4000);
    expect(c.convertConcurrency).toBe(4);
    expect(c.corsOrigins).toEqual(['http://localhost:3000']);
    expect(c.trustProxy).toBe(false);
    expect(c.cookiesConfigured).toBe(false);
    expect(c.ytdlpArgsPrefix).toEqual([]);
  });

  it('convierte tipos y TRUST_PROXY', () => {
    const c = loadConfig(base({ PORT: '4100', TRUST_PROXY: '1', AUDIO_HLS_FALLBACK: 'false', CORS_ORIGINS: 'https://a.com, https://b.com' }));
    expect(c.port).toBe(4100);
    expect(c.trustProxy).toBe(1);
    expect(c.audioHlsFallback).toBe(false);
    expect(c.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('env inválido → lista de claves sin valores', () => {
    try {
      loadConfig(base({ PORT: 'abc-valor', LOG_LEVEL: 'ruidoso' }));
      throw new Error('no falló');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.keys).toEqual(expect.arrayContaining(['PORT', 'LOG_LEVEL']));
      expect(err.message).not.toContain('abc-valor');
      expect(err.message).not.toContain('ruidoso');
      expect(JSON.stringify(err.keys)).not.toContain('abc-valor');
    }
  });

  it.each([
    ['SLOT_LEASE_MS', { SLOT_LEASE_MS: '20000' }],
    ['WAIT_LEASE_MS', { WAIT_LEASE_MS: '4000' }],
    ['MAX_ITEMS_PER_JOB', { MAX_ITEMS_PER_JOB: '101', MAX_PLAYLIST_ITEMS: '50' }],
    ['ZIP_PARALLEL_AUDIO', { ZIP_PARALLEL_AUDIO: '0' }],
    ['ZIP_PARALLEL_AUDIO', { ZIP_PARALLEL_AUDIO: '5', CONVERT_CONCURRENCY: '4' }],
    ['YTDLP_ARGS_PREFIX', { YTDLP_ARGS_PREFIX: 'no-json' }],
    ['FFMPEG_ARGS_PREFIX', { FFMPEG_ARGS_PREFIX: '[1,2]' }],
    ['MAX_PLAYLIST_ITEMS', { MAX_PLAYLIST_ITEMS: '60', MAX_ITEMS_PER_JOB: '50' }],
    ['CONVERT_CONCURRENCY', { CONVERT_CONCURRENCY: '0' }],
  ])('validación cruzada: %s', (key, extra) => {
    expect(keysOf(() => loadConfig(base(extra)))).toContain(key);
  });

  it('acepta *_ARGS_PREFIX como array JSON de strings', () => {
    const c = loadConfig(base({ YTDLP_ARGS_PREFIX: '["test/fixtures/fake-ytdlp.mjs"]' }));
    expect(c.ytdlpArgsPrefix).toEqual(['test/fixtures/fake-ytdlp.mjs']);
  });

  it('REDIS_PASSWORD no hex en la URL → fatal', () => {
    expect(keysOf(() => loadConfig(base({ REDIS_URL: 'redis://:no-hex-pass@redis:6379/0' })))).toEqual(['REDIS_URL']);
    expect(keysOf(() => loadConfig(base({ REDIS_URL: 'redis://:abcd@redis:6379/0' })))).toEqual(['REDIS_URL']);
    expect(loadConfig(base({ REDIS_URL: 'redis://redis:6379/0' })).redisUrl).toBe('redis://redis:6379/0');
  });

  it('IP_HASH_SALT obligatorio en producción', () => {
    expect(keysOf(() => loadConfig(base({ NODE_ENV: 'production' })))).toContain('IP_HASH_SALT');
    expect(loadConfig(base({ NODE_ENV: 'production', IP_HASH_SALT: HEX })).isProd).toBe(true);
  });

  it('YOUTUBE_COOKIES_JSON: se borra de process.env tras cargarla', () => {
    process.env.YOUTUBE_COOKIES_JSON = COOKIES_JSON;
    const env = { ...base(), YOUTUBE_COOKIES_JSON: COOKIES_JSON };
    const c = loadConfig(env);
    expect(c.cookiesConfigured).toBe(true);
    expect(process.env.YOUTUBE_COOKIES_JSON).toBeUndefined();
    expect(env.YOUTUBE_COOKIES_JSON).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(c)).not.toContain('PRUEBA');
  });

  it('producción + YOUTUBE_COOKIES_JSON → exactamente un warn cookies_via_env sin el valor', () => {
    const log = memLogger();
    loadConfig(base({ NODE_ENV: 'production', IP_HASH_SALT: HEX, YOUTUBE_COOKIES_JSON: COOKIES_JSON }), log);
    const warns = log.calls.filter((c) => c.msg === 'cookies_via_env');
    expect(warns).toHaveLength(1);
    expect(log.calls).toHaveLength(1);
    expect(JSON.stringify(log.calls)).not.toContain(COOKIE_VALUE);
  });

  it('desarrollo + YOUTUBE_COOKIES_JSON → sin warn', () => {
    const log = memLogger();
    loadConfig(base({ YOUTUBE_COOKIES_JSON: COOKIES_JSON }), log);
    expect(log.calls).toHaveLength(0);
  });

  it('YOUTUBE_COOKIES_JSON inválido → fatal con la clave', () => {
    expect(keysOf(() => loadConfig(base({ YOUTUBE_COOKIES_JSON: '{no json' })))).toEqual(['YOUTUBE_COOKIES_JSON']);
  });

  it('YTDLP_COOKIES_FILE inexistente → fatal', () => {
    const missing = path.join(os.tmpdir(), `setube-no-existe-${Date.now()}.txt`);
    try {
      loadConfig(base({ YTDLP_COOKIES_FILE: missing }));
      throw new Error('no falló');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toEqual(['YTDLP_COOKIES_FILE']);
      expect((e as ConfigError).details).toMatchObject({ path: missing, code: 'ENOENT' });
    }
  });

  it('YTDLP_COOKIES_FILE legible → configurado; gana sobre YOUTUBE_COOKIES_JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setube-ck-'));
    const file = path.join(dir, 'ck.txt');
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n');
    try {
      const c = loadConfig(base({ YTDLP_COOKIES_FILE: file, YOUTUBE_COOKIES_JSON: COOKIES_JSON }));
      expect(c.cookiesConfigured).toBe(true);
      expect(c.cookiesFile).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('YTDLP_COOKIES_FILE sin permiso de lectura → fatal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setube-ck-'));
    const file = path.join(dir, 'ck.txt');
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n');
    fs.chmodSync(file, 0o000);
    try {
      expect(keysOf(() => loadConfig(base({ YTDLP_COOKIES_FILE: file })))).toEqual(['YTDLP_COOKIES_FILE']);
    } finally {
      fs.chmodSync(file, 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('variables de escucha en streaming', () => {
  it('defaults', () => {
    const c = loadConfig(base());
    expect(c).toMatchObject({
      clientIpHeader: null,
      previewEnabled: true,
      previewMaxStreamsPerIp: 4,
      previewMaxStreamsPerInstance: 100,
      previewRateLimitMax: 60,
      previewChunkBytes: 10485760,
      previewIdleTimeoutMs: 60000,
    });
  });

  it('PREVIEW_ENABLED=false y CLIENT_IP_HEADER en minúsculas', () => {
    const c = loadConfig(base({ PREVIEW_ENABLED: 'false', CLIENT_IP_HEADER: ' CF-Connecting-IP ' }));
    expect(c.previewEnabled).toBe(false);
    expect(c.clientIpHeader).toBe('cf-connecting-ip');
  });

  it.each([
    ['PREVIEW_CHUNK_BYTES', { PREVIEW_CHUNK_BYTES: '1048575' }],
    ['PREVIEW_CHUNK_BYTES', { PREVIEW_CHUNK_BYTES: '10485761' }],
    ['PREVIEW_IDLE_TIMEOUT_MS', { PREVIEW_IDLE_TIMEOUT_MS: '4999' }],
    ['CLIENT_IP_HEADER', { CLIENT_IP_HEADER: 'bad header!' }],
    ['PREVIEW_MAX_STREAMS_PER_IP', { PREVIEW_MAX_STREAMS_PER_IP: '0' }],
  ])('inválido: %s', (key, extra) => {
    expect(keysOf(() => loadConfig(base(extra)))).toContain(key);
  });

  it('.env.example declara exactamente las variables del esquema', () => {
    const text = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const keys = text.split(/\r?\n/).flatMap((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1] ?? []);
    expect(new Set(keys)).toEqual(new Set(Object.keys(EnvSchema.properties)));
  });
});

describe('PO token provider y proxy', () => {
  it('vacíos por defecto', () => {
    const c = loadConfig(base());
    expect(c.potProviderUrl).toBeNull();
    expect(c.ytdlpProxy).toBeNull();
  });

  it('acepta URLs válidas y quita la barra final del provider', () => {
    const c = loadConfig(base({ POT_PROVIDER_URL: 'http://pot:4416/', YTDLP_PROXY: 'http://u:p@proxy.example:8080' }));
    expect(c.potProviderUrl).toBe('http://pot:4416');
    expect(c.ytdlpProxy).toBe('http://u:p@proxy.example:8080');
    expect(loadConfig(base({ POT_PROVIDER_URL: 'https://pot.railway.internal:4416' })).potProviderUrl).toBe('https://pot.railway.internal:4416');
    expect(loadConfig(base({ POT_PROVIDER_URL: 'http://[fd12::1]:4416' })).potProviderUrl).toBe('http://[fd12::1]:4416');
    expect(loadConfig(base({ YTDLP_PROXY: 'https://proxy.example:443' })).ytdlpProxy).toBe('https://proxy.example:443');
    expect(loadConfig(base({ YTDLP_PROXY: 'socks5://u:p@10.0.0.1:1080' })).ytdlpProxy).toBe('socks5://u:p@10.0.0.1:1080');
  });

  it.each([
    'pot:4416',
    'ftp://pot:4416',
    'http://u:p@pot:4416',
    'http://pot:4416/?a=1',
    'http://pot:4416/a;b',
    'http://pot:4416/a,b',
  ])('POT_PROVIDER_URL inválida: %s', (v) => {
    expect(keysOf(() => loadConfig(base({ POT_PROVIDER_URL: v })))).toEqual(['POT_PROVIDER_URL']);
  });

  it.each([
    'proxy.example:8080',
    'socks4://proxy.example:1080',
    'ftp://proxy.example',
    'http://proxy.example:8080/ruta',
    'http://proxy.example:8080/?x=1',
  ])('YTDLP_PROXY inválido: %s', (v) => {
    expect(keysOf(() => loadConfig(base({ YTDLP_PROXY: v })))).toEqual(['YTDLP_PROXY']);
  });

  it('el error de validación no incluye el valor del proxy', () => {
    try {
      loadConfig(base({ YTDLP_PROXY: 'socks4://usuario:clave-secreta@proxy.example:1080' }));
      throw new Error('no falló');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(JSON.stringify({ m: (e as Error).message, k: (e as ConfigError).keys })).not.toContain('clave-secreta');
    }
  });
});

describe('redact del logger', () => {
  it('censura config.redisUrl, config.ytdlpProxy, req.headers.cookie y body.turnstileToken', async () => {
    const { lines, stream } = memStream();
    const app = Fastify({ logger: loggerOptions({ logLevel: 'info', isProd: true }, stream) });
    await app.ready();
    app.log.info({ config: { redisUrl: `redis://:${HEX}@redis:6379/0`, ipHashSalt: 'sal-secreta', ytdlpProxy: 'http://usuario:proxy-secreto@proxy.example:8080' } }, 'prueba');
    app.log.info({ req: { headers: { cookie: 'SID=cookie-secreta' } }, body: { turnstileToken: 'token-secreto' } }, 'prueba2');
    await app.close();
    const out = lines.join('');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(HEX);
    expect(out).not.toContain('sal-secreta');
    expect(out).not.toContain('proxy-secreto');
    expect(out).not.toContain('cookie-secreta');
    expect(out).not.toContain('token-secreto');
  });
});
