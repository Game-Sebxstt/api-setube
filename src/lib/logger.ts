import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config/env.js';

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'body.turnstileToken',
  'req.body.turnstileToken',
  'config.redisUrl',
  'config.ipHashSalt',
  'config.turnstileSecret',
  'config.youtubeCookiesJson',
  'config.cookiesNetscape',
  'config.ytdlpProxy',
];

export function redactQuery(url: string): string {
  return url.replace(/([?&]sid=)[^&#]*/gi, '$1[redacted]');
}

interface ReqLike {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

const reqSerializer = (req: ReqLike) => ({
  method: req.method,
  url: typeof req.url === 'string' ? redactQuery(req.url) : req.url,
  version: typeof req.headers?.['accept-version'] === 'string' ? req.headers['accept-version'] : undefined,
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

export function loggerOptions(
  config: Pick<Config, 'logLevel' | 'isProd'>,
  stream?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  const base = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: { req: reqSerializer },
  };
  if (stream) return { ...base, stream } as never;
  if (!config.isProd) {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } };
  }
  return base;
}
