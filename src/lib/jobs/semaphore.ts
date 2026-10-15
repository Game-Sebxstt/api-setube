import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import type { PubSub } from '../pubsub.js';
import { SEM_KEYS, SEM_WAKE, scripts } from './lua.js';

export interface SemaphoreOpts {
  redis: Redis;
  pubsub: PubSub;
  slots: number;
  holdLeaseMs: number;
  waitLeaseMs: number;
  queueMax: number;
  waitTimeoutMs: number;
  log?: { warn(obj: object, msg: string): void };
  pollMs?: number;
  pollJitterMs?: number;
  renewMs?: number;
}

export interface SlotHandle {
  readonly at: number;
  release(): Promise<void>;
}

export interface AcquireOpts {
  signal?: AbortSignal;
  onPosition?: (position: number) => void;
}

export class Semaphore {
  private readonly wakers = new Set<() => void>();
  private wakeSub: Promise<unknown> | null = null;

  constructor(private readonly o: SemaphoreOpts) {}

  queueLength(): Promise<number> {
    return this.o.redis.zcard(SEM_KEYS.queue);
  }

  private ensureWakeSub(): Promise<unknown> {
    this.wakeSub ??= this.o.pubsub
      .subscribe(SEM_WAKE, () => {
        for (const w of [...this.wakers]) w();
      })
      .catch((e: Error) => {
        this.wakeSub = null;
        this.o.log?.warn({ err: { message: e.message } }, 'sem_wake_subscribe_failed');
      });
    return this.wakeSub;
  }

  private wait(signal?: AbortSignal): Promise<void> {
    const ms = (this.o.pollMs ?? 1000) + Math.random() * (this.o.pollJitterMs ?? 250);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async acquire(ticket: string, opts: AcquireOpts = {}): Promise<SlotHandle> {
    const s = scripts(this.o.redis);
    const { signal } = opts;
    await this.ensureWakeSub();
    const deadline = Date.now() + this.o.waitTimeoutMs;
    let lastPos = -1;
    for (;;) {
      if (signal?.aborted) {
        await s.semRelease(ticket).catch(() => undefined);
        throw signal.reason;
      }
      const [ok, pos] = await s.semAcquire(ticket, this.o.slots, this.o.holdLeaseMs, this.o.waitLeaseMs, this.o.queueMax);
      if (ok === 1) break;
      if (ok === -1) throw new AppError('QUEUE_FULL');
      if (pos !== lastPos) {
        lastPos = pos;
        opts.onPosition?.(pos);
      }
      if (Date.now() >= deadline) {
        await s.semRelease(ticket).catch(() => undefined);
        throw new AppError('QUEUE_TIMEOUT');
      }
      await this.wait(signal);
    }
    return this.holder(ticket);
  }

  private holder(ticket: string): SlotHandle {
    const s = scripts(this.o.redis);
    const renew = setInterval(() => {
      s.semRenew(ticket, this.o.holdLeaseMs)
        .then((existed) => {
          if (!existed) this.o.log?.warn({ ticket }, 'slot_lease_lost');
        })
        .catch((e: Error) => this.o.log?.warn({ err: { message: e.message } }, 'slot_renew_failed'));
    }, this.o.renewMs ?? 10_000);
    renew.unref?.();
    let released: Promise<void> | null = null;
    return {
      at: Date.now(),
      release: () => {
        released ??= (async () => {
          clearInterval(renew);
          await s.semRelease(ticket).catch((e: Error) => this.o.log?.warn({ err: { message: e.message } }, 'slot_release_failed'));
        })();
        return released;
      },
    };
  }
}
