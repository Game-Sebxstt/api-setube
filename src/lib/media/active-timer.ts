export type TimerCode = 'CONVERSION_TIMEOUT' | 'STALLED';

export interface TimerOut {
  readonly writableNeedDrain: boolean;
  readonly writableEnded: boolean;
}

export interface ActiveTimerOpts {
  mode: 'file' | 'archive';
  out: TimerOut;
  slotAt: number;
  headAt?: () => number | undefined;
  lastActivity: () => number;
  activeLimitMs: number;
  wallLimitMs: number;
  stallLimitMs: number;
  onExpire: (code: TimerCode) => void;
  onIgnored?: (code: TimerCode) => void;
  tickMs?: number;
  stallCheckMs?: number;
  now?: () => number;
}

export class ActiveTimer {
  private activeMs = 0;
  private lastTick: number;
  private lastDrainSeen = 0;
  private fired = false;
  private ignored = false;
  private readonly tickT: NodeJS.Timeout;
  private readonly stallT: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: ActiveTimerOpts) {
    this.now = o.now ?? Date.now;
    this.lastTick = this.now();
    this.tickT = setInterval(() => this.tick(), o.tickMs ?? 1000);
    this.stallT = setInterval(() => this.stallCheck(), o.stallCheckMs ?? 5000);
    this.tickT.unref?.();
    this.stallT.unref?.();
  }

  get active(): number {
    return this.activeMs;
  }

  stop(): void {
    clearInterval(this.tickT);
    clearInterval(this.stallT);
  }

  private expire(code: TimerCode): void {
    if (this.fired) return;
    if (this.o.out.writableEnded) {
      if (!this.ignored) {
        this.ignored = true;
        this.o.onIgnored?.(code);
      }
      return;
    }
    this.fired = true;
    this.stop();
    this.o.onExpire(code);
  }

  private tick(): void {
    const now = this.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const { out } = this.o;
    if (out.writableNeedDrain) this.lastDrainSeen = now;
    if (!out.writableNeedDrain && !out.writableEnded) this.activeMs += dt;
    if (this.activeMs > this.o.activeLimitMs) return this.expire('CONVERSION_TIMEOUT');
    const wallStart = this.o.mode === 'file' ? this.o.slotAt : this.o.headAt?.();
    if (wallStart !== undefined && now - wallStart > this.o.wallLimitMs) this.expire('CONVERSION_TIMEOUT');
  }

  private stallCheck(): void {
    const now = this.now();
    const { out } = this.o;
    if (out.writableEnded) return;
    if (out.writableNeedDrain) {
      this.lastDrainSeen = now;
      return;
    }
    const idleSince = Math.max(this.o.lastActivity(), this.lastDrainSeen, this.o.slotAt);
    if (now - idleSince > this.o.stallLimitMs) this.expire('STALLED');
  }
}
