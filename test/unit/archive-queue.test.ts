import { describe, expect, it } from 'vitest';
import { applyStale, archiveQueue, computeOverall, type ItemState } from '../../src/lib/jobs/store.js';

const item = (itemId: string, o: Partial<ItemState>): ItemState => ({
  itemId, videoId: 'jNQXAC9IVRw', title: null, duration: 19, durationVerified: true, status: 'pending', pct: 0,
  speedBps: null, etaSec: null, position: null, bytesSent: 0, attempt: 0, updatedAt: 0, ...o,
});

describe('archiveQueue (orden de items en /archive)', () => {
  it('devuelve done, error runtime y pending en el orden del job; excluye validation y canceled', () => {
    const items = [
      item('i0', { status: 'done', pct: 100 }),
      item('i1', { status: 'error', errorKind: 'validation', error: { code: 'LIMIT_DURATION', message: 'x' } }),
      item('i2', { status: 'error', errorKind: 'runtime', error: { code: 'UPSTREAM_TIMEOUT', message: 'x' } }),
      item('i3', { status: 'canceled' }),
      item('i4', { status: 'pending' }),
    ];
    expect(archiveQueue(items).map((i) => i.itemId)).toEqual(['i0', 'i2', 'i4']);
  });

  it('todos validation → vacía (→ NO_VALID_ITEMS)', () => {
    const items = [
      item('i0', { status: 'error', errorKind: 'validation' }),
      item('i1', { status: 'error', errorKind: 'validation' }),
    ];
    expect(archiveQueue(items)).toEqual([]);
  });
});

describe('computeOverall', () => {
  it('media contando terminales como 100 y conteos', () => {
    const o = computeOverall(
      [item('i0', { status: 'done', pct: 100 }), item('i1', { status: 'downloading', pct: 50 }), item('i2', { status: 'error' })],
      true,
    );
    expect(o).toEqual({ pct: 83.3, done: 1, failed: 1, total: 3, active: true });
    expect(computeOverall([], false)).toEqual({ pct: 0, done: 0, failed: 0, total: 0, active: false });
  });
});

describe('applyStale (items activos sin lock al leer el job)', () => {
  const now = 1_000_000;
  it('activo viejo sin lock → error SERVER_SHUTDOWN stale (runtime)', () => {
    const r = applyStale(item('i0', { status: 'downloading', updatedAt: now - 70_000, phase: 'download' }), { now, locked: false, slotLeaseMs: 30_000 });
    expect(r).toMatchObject({ status: 'error', error: { code: 'SERVER_SHUTDOWN' }, errorKind: 'runtime', stale: true });
    expect(r).not.toHaveProperty('updatedAt');
  });
  it('pending viejo o con lock vivo → sin cambios', () => {
    expect(applyStale(item('i0', { status: 'pending', updatedAt: 0 }), { now, locked: false, slotLeaseMs: 30_000 }).status).toBe('pending');
    expect(applyStale(item('i0', { status: 'queued', updatedAt: 0 }), { now, locked: true, slotLeaseMs: 30_000 }).status).toBe('queued');
  });
});
