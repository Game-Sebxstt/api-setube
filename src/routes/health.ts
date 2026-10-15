import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

const VERSION = '2.0.0';

const Ok = Type.Object(
  { status: Type.Literal('ok'), redis: Type.Literal('ok'), version: Type.String(), uptimeSec: Type.Integer() },
  { additionalProperties: false },
);
const Degraded = Type.Object(
  { status: Type.Literal('degraded'), redis: Type.Literal('down') },
  { additionalProperties: false },
);

async function pingWithin(ping: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return res === 'PONG';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const health: FastifyPluginAsyncTypebox = async (app) => {
  let lastOk: boolean | null = null;
  app.get(
    '/health',
    { config: { rateLimit: false }, logLevel: 'warn', schema: { response: { 200: Ok, 503: Degraded } } },
    async (_req, reply) => {
      const ok = await pingWithin(() => app.redis.ping(), 1000);
      if (lastOk !== null && ok !== lastOk) {
        app.log.warn({ redis: ok ? 'ok' : 'down' }, 'health_changed');
      } else if (lastOk === null && !ok) {
        app.log.warn({ redis: 'down' }, 'health_changed');
      }
      lastOk = ok;
      if (!ok) return reply.code(503).send({ status: 'degraded', redis: 'down' } as const);
      return { status: 'ok', redis: 'ok', version: VERSION, uptimeSec: Math.floor(process.uptime()) } as const;
    },
  );
};

export default health;
