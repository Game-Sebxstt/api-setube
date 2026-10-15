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
];

export function loggerOptions(
  config: Pick<Config, 'logLevel' | 'isProd'>,
  stream?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  const base = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  if (stream) return { ...base, stream } as never;
  if (!config.isProd) {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } };
  }
  return base;
}
