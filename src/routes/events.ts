import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { AppError } from '../lib/errors.js';
import { subsLeases } from '../lib/jobs/leases.js';
import { evChannel, jobKey } from '../lib/jobs/lua.js';
import { readJob } from '../lib/jobs/store.js';
import { ErrorResponse } from '../schemas/common.js';
import { JobParams } from '../schemas/jobs.js';
import { critical } from './jobs.js';

interface BusMessage {
  id: number;
  event: string;
  data: unknown;
  overall?: unknown;
}

export function formatStateEvent(m: BusMessage): string {
  const data = m.overall !== undefined ? { item: m.data, overall: m.overall } : m.data;
  return `id: ${m.id}\nevent: ${m.event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const eventsRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const subs = subsLeases(app.redis);

  app.get(
    '/api/jobs/:id/events',
    {
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { params: JobParams, response: { '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      const jobId = req.params.id;
      if (app.lifecycle.draining) throw new AppError('SERVER_SHUTDOWN');
      const exists = await critical(app.redis.exists(jobKey(jobId)), req.log);
      if (!exists) throw new AppError('JOB_NOT_FOUND');
      const connId = randomUUID();
      if (!(await critical(subs.acquire(jobId, connId, config.sseMaxPerJob), req.log))) throw new AppError('TOO_MANY_SUBSCRIBERS');

      const lastEventId = req.headers['last-event-id'];
      if (lastEventId) req.log.debug({ jobId, lastEventId }, 'sse_reconnect');

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      raw.write('retry: 3000\n\n');

      let closed = false;
      let lastSeq = 0;
      let buffer: BusMessage[] | null = [];
      const write = (s: string) => {
        if (!closed && !raw.writableEnded) raw.write(s);
      };
      const onMessage = (msg: string) => {
        let m: BusMessage;
        try {
          m = JSON.parse(msg) as BusMessage;
        } catch {
          return;
        }
        if (buffer) {
          buffer.push(m);
          return;
        }
        if (m.id <= lastSeq) return;
        lastSeq = m.id;
        write(formatStateEvent(m));
      };

      const timers: NodeJS.Timeout[] = [];
      let unsubscribe: (() => Promise<void>) | null = null;
      let offReconnect: (() => void) | null = null;
      const untrack = app.lifecycle.trackSse({ raw });

      const cleanup = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearTimeout(t);
        untrack();
        offReconnect?.();
        void unsubscribe?.();
        subs.release(jobId, connId).catch(() => undefined);
      };
      const end = (tail = '') => {
        if (!raw.writableEnded) raw.end(tail);
        cleanup();
      };
      raw.on('close', cleanup);
      raw.on('error', cleanup);

      const sendSnapshot = async () => {
        const view = await readJob(app.redis, jobId, { slotLeaseMs: config.slotLeaseMs });
        if (!view) {
          end('event: expired\ndata: {}\n\n');
          return;
        }
        const S = view.snapshot.seq;
        write(`id: ${S}\nevent: snapshot\ndata: ${JSON.stringify(view.snapshot)}\n\n`);
        lastSeq = Math.max(lastSeq, S);
        const pending = buffer ?? [];
        buffer = null;
        for (const m of pending) {
          if (m.id <= lastSeq) continue;
          lastSeq = m.id;
          write(formatStateEvent(m));
        }
      };

      try {
        unsubscribe = await app.pubsub.subscribe(evChannel(jobId), onMessage);
        if (closed) {
          void unsubscribe();
          return;
        }
        await sendSnapshot();
      } catch (e) {
        req.log.error({ err: { message: (e as Error).message } }, 'sse_setup_failed');
        end();
        return;
      }

      offReconnect = app.pubsub.onReconnect(() => {
        buffer = [];
        sendSnapshot().catch(() => {
          buffer = null;
        });
      });

      timers.push(
        setInterval(async () => {
          write(': ping\n\n');
          try {
            const [renewed, alive] = await Promise.all([subs.renew(jobId, connId), app.redis.exists(jobKey(jobId))]);
            if (!alive) return end('event: expired\ndata: {}\n\n');
            if (!renewed) await subs.acquire(jobId, connId, config.sseMaxPerJob);
          } catch {
            /* Redis caído: se mantiene la conexión con heartbeats */
          }
        }, config.sseHeartbeatMs),
        setTimeout(() => end(), config.sseMaxLifetimeMs),
      );
      for (const t of timers) t.unref?.();
    },
  );
};

export default eventsRoute;
