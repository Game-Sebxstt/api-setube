import type { Redis } from 'ioredis';
import type { ErrorCode } from '../errors.js';
import { computeOverall, itemError, updateItem, type ItemState, type ItemStatus, type ItemUpdate, type Overall } from './store.js';

type Patch = Partial<Omit<ItemState, 'itemId' | 'status' | 'error' | 'errorKind'>>;

export interface ReporterOpts {
  redis: Redis;
  jobId: string;
  ttlSec: number;
  items: ItemState[];
  log?: { warn(obj: object, msg: string): void };
  onExpired?: () => void;
  throttleMs?: number;
}

export class Reporter {
  private readonly state = new Map<string, ItemState>();
  private readonly lastPub = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private chain: Promise<unknown> = Promise.resolve();
  private disabled = false;
  private expired = false;

  constructor(private readonly o: ReporterOpts) {
    for (const it of o.items) this.state.set(it.itemId, { ...it });
  }

  get(itemId: string): ItemState {
    const s = this.state.get(itemId);
    if (!s) throw new Error(`item desconocido: ${itemId}`);
    return s;
  }

  overall(): Overall {
    return computeOverall([...this.state.values()], true);
  }

  disable(): void {
    this.disabled = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  startAttempt(itemId: string): Promise<number> {
    const prev = this.get(itemId);
    return this.transition(itemId, 'fetching', {
      attempt: prev.attempt + 1,
      pct: 0,
      bytesSent: 0,
      speedBps: null,
      etaSec: null,
      position: null,
    });
  }

  transition(itemId: string, status: Exclude<ItemStatus, 'error'>, patch: Patch = {}): Promise<number> {
    const prev = this.get(itemId);
    const next = { ...prev, ...patch, status, updatedAt: Date.now() } as ItemState;
    delete next.error;
    delete next.errorKind;
    if (status === 'done') next.pct = 100;
    if (status !== 'queued') next.position = null;
    this.state.set(itemId, next);
    return this.publish(itemId, status);
  }

  fail(itemId: string, code: ErrorCode, patch: Patch = {}, message?: string): Promise<number> {
    const prev = this.get(itemId);
    const next: ItemState = {
      ...prev,
      ...patch,
      status: 'error',
      error: itemError(code, message),
      errorKind: 'runtime',
      speedBps: null,
      etaSec: null,
      position: null,
      updatedAt: Date.now(),
    };
    delete next.phase;
    this.state.set(itemId, next);
    return this.publish(itemId, 'error');
  }

  progress(itemId: string, patch: Patch): void {
    const prev = this.get(itemId);
    this.state.set(itemId, { ...prev, ...patch, updatedAt: Date.now() });
    if (this.disabled || this.timers.has(itemId)) return;
    const wait = (this.lastPub.get(itemId) ?? 0) + (this.o.throttleMs ?? 500) - Date.now();
    if (wait <= 0) {
      void this.publish(itemId, this.get(itemId).status);
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(itemId);
      void this.publish(itemId, this.get(itemId).status);
    }, wait);
    t.unref?.();
    this.timers.set(itemId, t);
  }

  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  private publish(itemId: string, event: string): Promise<number> {
    const t = this.timers.get(itemId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(itemId);
    }
    if (this.disabled || this.expired) return Promise.resolve(0);
    this.lastPub.set(itemId, Date.now());
    const snapshot = { ...this.get(itemId) } as ItemUpdate;
    const overall = this.overall();
    const p = this.chain.then(async () => {
      if (this.disabled || this.expired) return 0;
      try {
        const seq = await updateItem(this.o.redis, this.o.jobId, snapshot, event, overall, this.o.ttlSec);
        if (seq === 0 && !this.expired) {
          this.expired = true;
          this.o.log?.warn({ jobId: this.o.jobId }, 'job_expired_during_stream');
          this.o.onExpired?.();
        }
        return seq;
      } catch (e) {
        this.o.log?.warn({ err: { message: (e as Error).message } }, 'update_item_failed');
        return -1;
      }
    });
    this.chain = p;
    return p;
  }
}
