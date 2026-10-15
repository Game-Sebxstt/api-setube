import type { Redis } from 'ioredis';

export type MessageHandler = (message: string, channel: string) => void;

export interface PubSubLogger {
  warn(obj: object, msg: string): void;
}

export class PubSub {
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly readyListeners = new Set<() => void>();
  private readyOnce = false;

  constructor(
    private readonly sub: Redis,
    private readonly log?: PubSubLogger,
  ) {
    this.readyOnce = sub.status === 'ready';
    sub.on('message', (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const h of set) {
        try {
          h(message, channel);
        } catch (e) {
          this.log?.warn({ err: { message: (e as Error).message } }, 'pubsub_handler_failed');
        }
      }
    });
    // autoResubscribe está desactivado: se resuscribe aquí para controlar el orden
    // y avisar a los SSE de que reenvíen snapshot.
    sub.on('ready', () => {
      const channels = [...this.handlers.keys()];
      if (channels.length) {
        sub.subscribe(...channels).catch((e: Error & { code?: string }) =>
          this.log?.warn({ err: { message: e.message, code: e.code } }, 'pubsub_resubscribe_failed'),
        );
      }
      if (this.readyOnce) for (const l of this.readyListeners) l();
      this.readyOnce = true;
    });
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (first) {
      try {
        await this.sub.subscribe(channel);
      } catch (e) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(channel);
        throw e;
      }
    }
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  onReconnect(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  channelCount(): number {
    return this.handlers.size;
  }
}
