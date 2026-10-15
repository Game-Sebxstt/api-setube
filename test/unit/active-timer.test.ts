import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveTimer, type ActiveTimerOpts, type TimerOut } from '../../src/lib/media/active-timer.js';

const S = 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

function make(o: Partial<ActiveTimerOpts> & { out: TimerOut }) {
  const onExpire = vi.fn();
  const onIgnored = vi.fn();
  let activity = Date.now();
  const timer = new ActiveTimer({
    mode: 'file',
    slotAt: Date.now(),
    lastActivity: () => activity,
    activeLimitMs: 10 * S,
    wallLimitMs: 100 * S,
    stallLimitMs: 60 * S,
    onExpire,
    onIgnored,
    ...o,
  });
  return { timer, onExpire, onIgnored, touch: () => (activity = Date.now()) };
}

describe('ActiveTimer', () => {
  it('el tiempo activo no avanza con writableNeedDrain', () => {
    const out = { writableNeedDrain: true, writableEnded: false };
    const { timer, onExpire } = make({ out });
    vi.advanceTimersByTime(30 * S);
    expect(timer.active).toBe(0);
    expect(onExpire).not.toHaveBeenCalled();
    out.writableNeedDrain = false;
    vi.advanceTimersByTime(3 * S);
    expect(timer.active).toBe(3 * S);
    timer.stop();
  });

  it('antes del primer byte (sin backpressure): el activo avanza y el stall salta a STALL_TIMEOUT_MS', () => {
    const out = { writableNeedDrain: false, writableEnded: false };
    const { timer, onExpire } = make({ out, mode: 'archive', activeLimitMs: 900 * S, stallLimitMs: 20 * S });
    vi.advanceTimersByTime(19 * S);
    expect(timer.active).toBe(19 * S);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6 * S);
    expect(onExpire).toHaveBeenCalledWith('STALLED');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('CONVERSION_TIMEOUT al superar el tiempo activo', () => {
    const out = { writableNeedDrain: false, writableEnded: false };
    const { onExpire, touch } = make({ out });
    for (let i = 0; i < 11; i++) {
      touch();
      vi.advanceTimersByTime(S);
    }
    expect(onExpire).toHaveBeenCalledWith('CONVERSION_TIMEOUT');
  });

  it('el tope de reloj vence aunque haya backpressure; el stall no salta con backpressure', () => {
    const out = { writableNeedDrain: true, writableEnded: false };
    const { onExpire } = make({ out, stallLimitMs: 5 * S, wallLimitMs: 50 * S });
    vi.advanceTimersByTime(49 * S);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * S);
    expect(onExpire).toHaveBeenCalledWith('CONVERSION_TIMEOUT');
  });

  it('archive con archiver bloqueado: una entrada NO cabeza no vence por reloj; la cabeza sí desde su headAt', () => {
    const blocked = { writableNeedDrain: true, writableEnded: false };
    const h: { at?: number } = {};
    const notHead = make({ out: blocked, mode: 'archive', wallLimitMs: 10 * S, headAt: () => undefined });
    const head = make({ out: { ...blocked }, mode: 'archive', wallLimitMs: 10 * S, headAt: () => h.at });
    vi.advanceTimersByTime(30 * S);
    expect(notHead.onExpire).not.toHaveBeenCalled();
    expect(head.onExpire).not.toHaveBeenCalled();
    h.at = Date.now();
    vi.advanceTimersByTime(9 * S);
    expect(head.onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * S);
    expect(head.onExpire).toHaveBeenCalledWith('CONVERSION_TIMEOUT');
    expect(notHead.onExpire).not.toHaveBeenCalled();
    notHead.timer.stop();
  });

  it('salida completa: vencer reloj, activo o stall no dispara error (queda pendiente de done)', () => {
    const out = { writableNeedDrain: false, writableEnded: false };
    const { timer, onExpire, onIgnored } = make({ out, activeLimitMs: 3 * S, wallLimitMs: 4 * S, stallLimitMs: 2 * S });
    out.writableEnded = true;
    vi.advanceTimersByTime(60 * S);
    expect(onExpire).not.toHaveBeenCalled();
    expect(onIgnored).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('stop() detiene los intervalos', () => {
    const out = { writableNeedDrain: false, writableEnded: false };
    const { timer, onExpire } = make({ out, activeLimitMs: S });
    timer.stop();
    vi.advanceTimersByTime(60 * S);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
