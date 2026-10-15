import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

export interface LiveStream {
  abort(reason: string): void;
  finished: Promise<unknown>;
}

export interface LiveSse {
  raw: ServerResponse;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)).unref());

export class Lifecycle {
  draining = false;
  readonly streams = new Set<LiveStream>();
  readonly sse = new Set<LiveSse>();

  trackStream(s: LiveStream): () => void {
    this.streams.add(s);
    const off = () => this.streams.delete(s);
    s.finished.then(off, off);
    return off;
  }

  trackSse(s: LiveSse): () => void {
    this.sse.add(s);
    return () => this.sse.delete(s);
  }

  closeSse(): void {
    this.draining = true;
    for (const s of this.sse) {
      try {
        if (!s.raw.writableEnded) s.raw.end('event: server-restart\ndata: {}\n\n');
      } catch {
        /* conexión ya cerrada */
      }
    }
    this.sse.clear();
  }

  private allFinished(): Promise<unknown> {
    return Promise.allSettled([...this.streams].map((s) => s.finished));
  }

  async shutdown(app: FastifyInstance, graceMs: number): Promise<void> {
    const closing = app.close();
    await Promise.race([this.allFinished(), sleep(graceMs - 5000)]);
    if (this.streams.size) {
      app.log.info({ streams: this.streams.size }, 'shutdown_abort_streams');
      for (const s of this.streams) s.abort('SERVER_SHUTDOWN');
      await Promise.race([this.allFinished(), sleep(3000)]);
    }
    await closing;
  }
}

export function registerLifecycle(app: FastifyInstance, lifecycle: Lifecycle): void {
  app.addHook('preClose', async () => {
    lifecycle.closeSse();
  });
}
