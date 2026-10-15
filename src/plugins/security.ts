import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../lib/errors.js';
import { ipHash } from '../lib/ip.js';

export default fp(
  async (app) => {
    const { config } = app;

    await app.register(helmet, {
      global: true,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    });

    await app.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['content-type', 'last-event-id'],
      exposedHeaders: ['x-request-id', 'retry-after'],
      credentials: false,
      maxAge: 600,
    });

    // Si Redis cae, el rate limit queda abierto (skipOnError); se registra un error por minuto.
    let lastErrorLog = 0;
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimitMax,
      timeWindow: config.rateLimitWindowMs,
      redis: app.redis,
      nameSpace: 'rl:',
      skipOnError: true,
      keyGenerator: (req) => ipHash(req.ip, config.ipHashSalt),
      errorResponseBuilder: (_req, ctx) => {
        const retryAfterSec = Math.max(1, Math.ceil(ctx.ttl / 1000));
        return new AppError('RATE_LIMITED', { details: { retryAfterSec } });
      },
    });

    app.redis.on('error', () => {
      const now = Date.now();
      if (now - lastErrorLog < 60_000) return;
      lastErrorLog = now;
      app.log.error({ component: 'rate-limit' }, 'rate_limit_store_unavailable');
    });
  },
  { name: 'setube-security', dependencies: ['setube-redis'] },
);
