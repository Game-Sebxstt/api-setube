import { randomBytes } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { cookies, CookiesError, type CookieLogger } from '../lib/media/cookies.js';

const Int = (def: number, min = 0) => Type.Integer({ default: def, minimum: min });
const Bool = (def: boolean) => Type.Boolean({ default: def });
const Str = (def: string) => Type.String({ default: def });

export const EnvSchema = Type.Object({
  PORT: Int(4000, 1),
  HOST: Str('0.0.0.0'),
  NODE_ENV: Type.Union([Type.Literal('production'), Type.Literal('development'), Type.Literal('test')], { default: 'production' }),
  LOG_LEVEL: Type.Union(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((l) => Type.Literal(l)),
    { default: 'info' },
  ),
  CORS_ORIGINS: Str('http://localhost:3000'),
  TRUST_PROXY: Str('false'),
  REDIS_URL: Str('redis://redis:6379/0'),
  IP_HASH_SALT: Str(''),
  YTDLP_PATH: Str('yt-dlp'),
  FFMPEG_PATH: Str('ffmpeg'),
  YTDLP_ARGS_PREFIX: Str('[]'),
  FFMPEG_ARGS_PREFIX: Str('[]'),
  POT_PROVIDER_URL: Str(''),
  YTDLP_PROXY: Str(''),
  YTDLP_COOKIES_FILE: Str(''),
  YOUTUBE_COOKIES_JSON: Str(''),
  AUDIO_HLS_FALLBACK: Bool(true),
  YTDLP_INFO_JSON: Bool(true),
  MAX_ITEMS_PER_JOB: Int(50, 1),
  MAX_PLAYLIST_ITEMS: Int(50, 1),
  MAX_RESOLVE_URLS: Int(50, 1),
  MAX_DURATION_AUDIO_SEC: Int(3600, 1),
  MAX_DURATION_VIDEO_SEC: Int(1200, 1),
  CONVERT_CONCURRENCY: Int(4, 1),
  QUEUE_MAX: Int(200, 1),
  QUEUE_WAIT_TIMEOUT_MS: Int(300000, 1),
  CONVERSION_TIMEOUT_MS: Int(900000, 1),
  CONVERSION_WALL_TIMEOUT_MS: Int(3600000, 1),
  STALL_TIMEOUT_MS: Int(60000, 1),
  SLOT_LEASE_MS: Int(30000, 1),
  WAIT_LEASE_MS: Int(20000, 1),
  MAX_STREAMS_PER_IP: Int(3, 1),
  MAX_STREAMS_PER_INSTANCE: Int(40, 1),
  ZIP_PARALLEL_AUDIO: Int(3, 0),
  ZIP_PARALLEL_VIDEO: Int(1, 1),
  ZIP_ITEM_BUFFER_BYTES: Int(33554432, 1),
  META_CONCURRENCY: Int(4, 1),
  META_TTL_SEC: Int(21600, 1),
  INFO_JSON_TTL_SEC: Int(10800, 1),
  OEMBED_TTL_SEC: Int(86400, 1),
  PLAYLIST_TTL_SEC: Int(1800, 1),
  JOB_TTL_SEC: Int(7200, 1),
  RATE_LIMIT_MAX: Int(120, 1),
  RATE_LIMIT_WINDOW_MS: Int(60000, 1),
  SSE_HEARTBEAT_MS: Int(15000, 1),
  SSE_MAX_LIFETIME_MS: Int(1800000, 1),
  SSE_MAX_PER_JOB: Int(5, 1),
  SHUTDOWN_GRACE_MS: Int(30000, 1),
  TURNSTILE_SECRET: Str(''),
  CLIENT_IP_HEADER: Str(''),
  PREVIEW_ENABLED: Bool(true),
  PREVIEW_MAX_STREAMS_PER_IP: Int(4, 1),
  PREVIEW_MAX_STREAMS_PER_INSTANCE: Int(100, 1),
  PREVIEW_RATE_LIMIT_MAX: Int(60, 1),
  PREVIEW_CHUNK_BYTES: Int(10485760, 1),
  PREVIEW_IDLE_TIMEOUT_MS: Int(60000, 1),
});

type Env = Static<typeof EnvSchema>;
const ENV_KEYS = Object.keys(EnvSchema.properties) as (keyof Env)[];

export type TrustProxy = boolean | number | string[];

export interface Config {
  port: number;
  host: string;
  nodeEnv: 'production' | 'development' | 'test';
  isProd: boolean;
  logLevel: string;
  corsOrigins: string[];
  trustProxy: TrustProxy;
  redisUrl: string;
  ipHashSalt: string;
  ytdlpPath: string;
  ffmpegPath: string;
  ytdlpArgsPrefix: string[];
  ffmpegArgsPrefix: string[];
  potProviderUrl: string | null;
  ytdlpProxy: string | null;
  cookiesFile: string | null;
  cookiesConfigured: boolean;
  audioHlsFallback: boolean;
  ytdlpInfoJson: boolean;
  maxItemsPerJob: number;
  maxPlaylistItems: number;
  maxResolveUrls: number;
  maxDurationAudioSec: number;
  maxDurationVideoSec: number;
  convertConcurrency: number;
  queueMax: number;
  queueWaitTimeoutMs: number;
  conversionTimeoutMs: number;
  conversionWallTimeoutMs: number;
  stallTimeoutMs: number;
  slotLeaseMs: number;
  waitLeaseMs: number;
  maxStreamsPerIp: number;
  maxStreamsPerInstance: number;
  zipParallelAudio: number;
  zipParallelVideo: number;
  zipItemBufferBytes: number;
  metaConcurrency: number;
  metaTtlSec: number;
  infoJsonTtlSec: number;
  oembedTtlSec: number;
  playlistTtlSec: number;
  jobTtlSec: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  sseHeartbeatMs: number;
  sseMaxLifetimeMs: number;
  sseMaxPerJob: number;
  shutdownGraceMs: number;
  turnstileSecret: string | null;
  clientIpHeader: string | null;
  previewEnabled: boolean;
  previewMaxStreamsPerIp: number;
  previewMaxStreamsPerInstance: number;
  previewRateLimitMax: number;
  previewChunkBytes: number;
  previewIdleTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly keys: string[];
  readonly details: Record<string, unknown> | undefined;
  constructor(keys: string[], details?: Record<string, unknown>) {
    super(`Configuración inválida: ${keys.join(', ')}`);
    this.name = 'ConfigError';
    this.keys = [...new Set(keys)];
    this.details = details;
  }
}

function keyOfError(e: { instancePath: string; params: object }): string[] {
  const seg = e.instancePath.split('/').filter(Boolean)[0];
  if (seg) return [seg];
  const p = e.params as { requiredProperties?: string[]; additionalProperties?: string[] };
  return p.requiredProperties ?? p.additionalProperties ?? ['(env)'];
}

function parseArgsPrefix(raw: string): string[] | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch {
    /* inválido */
  }
  return null;
}

function parseTrustProxy(raw: string): TrustProxy | null {
  const s = raw.trim();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length > 0 && list.every((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x))) return list;
  return null;
}

// null = vacío, false = inválido. Sin `,` ni `;`: yt-dlp los usa como separadores en --extractor-args
function parsePotUrl(raw: string): string | null | false {
  const s = raw.trim();
  if (s === '') return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return false;
  if (/[,;\s]/.test(s) || u.search || u.hash) return false;
  return s.replace(/\/+$/, '');
}

function parseProxyUrl(raw: string): string | null | false {
  const s = raw.trim();
  if (s === '') return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol) || !u.hostname || /\s/.test(s)) return false;
  if ((u.pathname !== '' && u.pathname !== '/') || u.search || u.hash) return false;
  return s;
}

function redisPasswordOk(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return false;
  const pass = decodeURIComponent(u.password);
  return pass === '' || /^[0-9a-fA-F]{32,}$/.test(pass);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, log?: CookieLogger): Config {
  const raw: Record<string, unknown> = {};
  for (const k of ENV_KEYS) {
    const v = source[k];
    if (v !== undefined && v !== '') raw[k] = v;
  }
  Value.Default(EnvSchema, raw);
  Value.Convert(EnvSchema, raw);
  if (!Value.Check(EnvSchema, raw)) {
    const keys = Value.Errors(EnvSchema, raw).flatMap(keyOfError);
    throw new ConfigError(keys.length ? keys : ['(env)']);
  }
  const env = raw as Env;

  const bad: string[] = [];
  if (env.MAX_ITEMS_PER_JOB > 100) bad.push('MAX_ITEMS_PER_JOB');
  if (env.MAX_PLAYLIST_ITEMS > env.MAX_ITEMS_PER_JOB) bad.push('MAX_PLAYLIST_ITEMS');
  if (env.ZIP_PARALLEL_AUDIO < 1 || env.ZIP_PARALLEL_AUDIO > env.CONVERT_CONCURRENCY) bad.push('ZIP_PARALLEL_AUDIO');
  if (env.SLOT_LEASE_MS < 25000) bad.push('SLOT_LEASE_MS');
  if (env.WAIT_LEASE_MS < 5000) bad.push('WAIT_LEASE_MS');
  const ytdlpArgsPrefix = parseArgsPrefix(env.YTDLP_ARGS_PREFIX);
  if (!ytdlpArgsPrefix) bad.push('YTDLP_ARGS_PREFIX');
  const ffmpegArgsPrefix = parseArgsPrefix(env.FFMPEG_ARGS_PREFIX);
  if (!ffmpegArgsPrefix) bad.push('FFMPEG_ARGS_PREFIX');
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy === null) bad.push('TRUST_PROXY');
  if (!redisPasswordOk(env.REDIS_URL)) bad.push('REDIS_URL');
  const isProd = env.NODE_ENV === 'production';
  if (isProd && env.IP_HASH_SALT === '') bad.push('IP_HASH_SALT');
  const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (corsOrigins.length === 0) bad.push('CORS_ORIGINS');
  if (env.PREVIEW_CHUNK_BYTES < 1048576 || env.PREVIEW_CHUNK_BYTES > 10485760) bad.push('PREVIEW_CHUNK_BYTES');
  if (env.PREVIEW_IDLE_TIMEOUT_MS < 5000) bad.push('PREVIEW_IDLE_TIMEOUT_MS');
  const clientIpHeader = env.CLIENT_IP_HEADER.trim().toLowerCase();
  if (clientIpHeader !== '' && !/^[a-z0-9-]{1,64}$/.test(clientIpHeader)) bad.push('CLIENT_IP_HEADER');
  const potProviderUrl = parsePotUrl(env.POT_PROVIDER_URL);
  if (potProviderUrl === false) bad.push('POT_PROVIDER_URL');
  const ytdlpProxy = parseProxyUrl(env.YTDLP_PROXY);
  if (ytdlpProxy === false) bad.push('YTDLP_PROXY');
  if (bad.length) throw new ConfigError(bad);

  const cookiesFile = env.YTDLP_COOKIES_FILE || null;
  try {
    cookies.load({ file: cookiesFile, json: env.YOUTUBE_COOKIES_JSON || null, isProd, env: source, log });
  } catch (e) {
    if (e instanceof CookiesError) {
      throw new ConfigError([e.key], e.path ? { path: e.path, code: e.code } : { code: e.code });
    }
    throw e;
  }

  return {
    port: env.PORT,
    host: env.HOST,
    nodeEnv: env.NODE_ENV,
    isProd,
    logLevel: env.LOG_LEVEL,
    corsOrigins,
    trustProxy: trustProxy as TrustProxy,
    redisUrl: env.REDIS_URL,
    ipHashSalt: env.IP_HASH_SALT || randomBytes(32).toString('hex'),
    ytdlpPath: env.YTDLP_PATH,
    ffmpegPath: env.FFMPEG_PATH,
    ytdlpArgsPrefix: ytdlpArgsPrefix as string[],
    ffmpegArgsPrefix: ffmpegArgsPrefix as string[],
    potProviderUrl: potProviderUrl || null,
    ytdlpProxy: ytdlpProxy || null,
    cookiesFile,
    cookiesConfigured: cookies.configured,
    audioHlsFallback: env.AUDIO_HLS_FALLBACK,
    ytdlpInfoJson: env.YTDLP_INFO_JSON,
    maxItemsPerJob: env.MAX_ITEMS_PER_JOB,
    maxPlaylistItems: env.MAX_PLAYLIST_ITEMS,
    maxResolveUrls: env.MAX_RESOLVE_URLS,
    maxDurationAudioSec: env.MAX_DURATION_AUDIO_SEC,
    maxDurationVideoSec: env.MAX_DURATION_VIDEO_SEC,
    convertConcurrency: env.CONVERT_CONCURRENCY,
    queueMax: env.QUEUE_MAX,
    queueWaitTimeoutMs: env.QUEUE_WAIT_TIMEOUT_MS,
    conversionTimeoutMs: env.CONVERSION_TIMEOUT_MS,
    conversionWallTimeoutMs: env.CONVERSION_WALL_TIMEOUT_MS,
    stallTimeoutMs: env.STALL_TIMEOUT_MS,
    slotLeaseMs: env.SLOT_LEASE_MS,
    waitLeaseMs: env.WAIT_LEASE_MS,
    maxStreamsPerIp: env.MAX_STREAMS_PER_IP,
    maxStreamsPerInstance: env.MAX_STREAMS_PER_INSTANCE,
    zipParallelAudio: env.ZIP_PARALLEL_AUDIO,
    zipParallelVideo: env.ZIP_PARALLEL_VIDEO,
    zipItemBufferBytes: env.ZIP_ITEM_BUFFER_BYTES,
    metaConcurrency: env.META_CONCURRENCY,
    metaTtlSec: env.META_TTL_SEC,
    infoJsonTtlSec: env.INFO_JSON_TTL_SEC,
    oembedTtlSec: env.OEMBED_TTL_SEC,
    playlistTtlSec: env.PLAYLIST_TTL_SEC,
    jobTtlSec: env.JOB_TTL_SEC,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    sseHeartbeatMs: env.SSE_HEARTBEAT_MS,
    sseMaxLifetimeMs: env.SSE_MAX_LIFETIME_MS,
    sseMaxPerJob: env.SSE_MAX_PER_JOB,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    turnstileSecret: env.TURNSTILE_SECRET || null,
    clientIpHeader: clientIpHeader || null,
    previewEnabled: env.PREVIEW_ENABLED,
    previewMaxStreamsPerIp: env.PREVIEW_MAX_STREAMS_PER_IP,
    previewMaxStreamsPerInstance: env.PREVIEW_MAX_STREAMS_PER_INSTANCE,
    previewRateLimitMax: env.PREVIEW_RATE_LIMIT_MAX,
    previewChunkBytes: env.PREVIEW_CHUNK_BYTES,
    previewIdleTimeoutMs: env.PREVIEW_IDLE_TIMEOUT_MS,
  };
}
