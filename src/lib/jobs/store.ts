import type { Redis } from 'ioredis';
import { ERROR_CATALOG, type ErrorCode } from '../errors.js';
import type { OutputFormat, Quality } from '../youtube/formats.js';
import { scripts } from './lua.js';

export type ItemStatus = 'pending' | 'queued' | 'fetching' | 'downloading' | 'converting' | 'done' | 'error' | 'canceled';
export type ErrorKind = 'validation' | 'runtime';
export const ACTIVE_STATUSES: readonly ItemStatus[] = ['fetching', 'queued', 'downloading', 'converting'];
export const TERMINAL_STATUSES: readonly ItemStatus[] = ['done', 'error', 'canceled'];

export interface ItemError {
  code: ErrorCode;
  message: string;
}

export interface ItemState {
  itemId: string;
  videoId: string;
  title: string | null;
  duration: number | null;
  durationVerified: boolean;
  status: ItemStatus;
  pct: number;
  phase?: 'download' | 'convert';
  speedBps: number | null;
  etaSec: number | null;
  position: number | null;
  bytesSent: number;
  attempt: number;
  error?: ItemError;
  errorKind?: ErrorKind;
  updatedAt: number;
}

export interface JobMeta {
  format: OutputFormat;
  quality: Quality;
  createdAt: string;
  ipHash: string;
  itemIds: string[];
}

export interface Overall {
  pct: number;
  done: number;
  failed: number;
  total: number;
  active: boolean;
}

export interface Reject {
  code: ErrorCode;
  message: string;
  at: string;
  itemId?: string;
  details?: unknown;
}

export type PublicItem = Omit<ItemState, 'updatedAt'> & { stale?: true };

export interface Snapshot {
  jobId: string;
  format: OutputFormat;
  quality: Quality;
  status: 'active' | 'canceled';
  createdAt: string;
  expiresAt: string;
  seq: number;
  overall: Overall;
  lastReject: Reject | null;
  items: PublicItem[];
}

export interface JobView {
  snapshot: Snapshot;
  meta: JobMeta;
  raw: Record<string, ItemState>;
  locked: boolean;
}

export const itemError = (code: ErrorCode, message?: string): ItemError => ({ code, message: message ?? ERROR_CATALOG[code].message });

export function computeOverall(items: readonly Pick<ItemState, 'status' | 'pct'>[], active: boolean): Overall {
  let sum = 0;
  let done = 0;
  let failed = 0;
  for (const it of items) {
    if (it.status === 'done') done++;
    if (it.status === 'error') failed++;
    sum += TERMINAL_STATUSES.includes(it.status) ? 100 : it.pct;
  }
  const pct = items.length ? Math.round((sum / items.length) * 10) / 10 : 0;
  return { pct, done, failed, total: items.length, active };
}

export function archiveQueue<T extends Pick<ItemState, 'itemId' | 'status' | 'errorKind'>>(items: readonly T[]): T[] {
  return items.filter((i) => i.errorKind !== 'validation' && i.status !== 'canceled');
}

export function applyStale(item: ItemState, ctx: { now: number; locked: boolean; slotLeaseMs: number }): PublicItem {
  const { updatedAt: _u, ...pub } = item;
  if (ACTIVE_STATUSES.includes(item.status) && !ctx.locked && ctx.now - item.updatedAt > 2 * ctx.slotLeaseMs) {
    return {
      ...pub,
      status: 'error',
      error: itemError('SERVER_SHUTDOWN'),
      errorKind: 'runtime',
      phase: undefined,
      stale: true,
    } as PublicItem;
  }
  return pub;
}

function normalize(item: ItemState): ItemState {
  const out: ItemState = { ...item };
  if (out.status !== 'error') {
    delete out.errorKind;
    delete out.error;
  }
  if (out.status !== 'downloading' && out.status !== 'converting') delete out.phase;
  if (out.phase === undefined) delete out.phase;
  return out;
}

export interface NewItem {
  videoId: string;
  title: string | null;
  duration: number | null;
  durationVerified: boolean;
  validationError?: ErrorCode;
}

export async function createJob(
  redis: Redis,
  args: { jobId: string; format: OutputFormat; quality: Quality; ipHash: string; items: NewItem[]; ttlSec: number; now?: number },
): Promise<{ meta: JobMeta; items: ItemState[] }> {
  const now = args.now ?? Date.now();
  const itemIds = args.items.map((_, i) => `i${i}`);
  const meta: JobMeta = { format: args.format, quality: args.quality, createdAt: new Date(now).toISOString(), ipHash: args.ipHash, itemIds };
  const items: ItemState[] = args.items.map((it, i) => {
    const base: ItemState = {
      itemId: itemIds[i] as string,
      videoId: it.videoId,
      title: it.title,
      duration: it.duration,
      durationVerified: it.durationVerified,
      status: 'pending',
      pct: 0,
      speedBps: null,
      etaSec: null,
      position: null,
      bytesSent: 0,
      attempt: 0,
      updatedAt: now,
    };
    if (it.validationError) {
      return { ...base, status: 'error', error: itemError(it.validationError), errorKind: 'validation' };
    }
    return base;
  });
  const fields: string[] = ['meta', JSON.stringify(meta), 'status', 'active', 'seq', '0'];
  for (const it of items) fields.push(`it:${it.itemId}`, JSON.stringify(it));
  await redis.multi().hset(`job:${args.jobId}`, ...fields).expire(`job:${args.jobId}`, args.ttlSec).exec();
  return { meta, items };
}

export type ItemUpdate =
  | (Omit<ItemState, 'status' | 'error' | 'errorKind'> & { status: Exclude<ItemStatus, 'error'> })
  | (Omit<ItemState, 'status' | 'error' | 'errorKind'> & { status: 'error'; error: ItemError; errorKind: 'runtime' });

export async function updateItem(
  redis: Redis,
  jobId: string,
  update: ItemUpdate,
  event: string,
  overall: Overall,
  ttlSec: number,
): Promise<number> {
  const item = normalize(update as ItemState);
  return scripts(redis).updateItem(jobId, item.itemId, JSON.stringify(item), event, ttlSec, JSON.stringify(overall));
}

export async function rejectJob(
  redis: Redis,
  jobId: string,
  r: { code: ErrorCode; message?: string; itemId?: string; details?: unknown },
  ttlSec: number,
): Promise<number> {
  const reject: Reject = { code: r.code, message: r.message ?? ERROR_CATALOG[r.code].message, at: new Date().toISOString() };
  if (r.itemId) reject.itemId = r.itemId;
  if (r.details !== undefined) reject.details = r.details;
  return scripts(redis).rejectJob(jobId, JSON.stringify(reject), ttlSec);
}

export async function cancelJob(redis: Redis, jobId: string, ttlSec: number): Promise<0 | 1 | 2> {
  return scripts(redis).cancelJob(jobId, ttlSec);
}

export async function readJob(redis: Redis, jobId: string, opts: { slotLeaseMs: number }): Promise<JobView | null> {
  const { hash, pttl, locked, now } = await scripts(redis).snapshot(jobId);
  if (!hash.meta) return null;
  const meta = JSON.parse(hash.meta) as JobMeta;
  const raw: Record<string, ItemState> = {};
  const items: PublicItem[] = [];
  for (const id of meta.itemIds) {
    const s = hash[`it:${id}`];
    if (!s) continue;
    const it = JSON.parse(s) as ItemState;
    raw[id] = it;
    items.push(applyStale(it, { now, locked, slotLeaseMs: opts.slotLeaseMs }));
  }
  const snapshot: Snapshot = {
    jobId,
    format: meta.format,
    quality: meta.quality,
    status: hash.status === 'canceled' ? 'canceled' : 'active',
    createdAt: meta.createdAt,
    expiresAt: new Date(now + Math.max(0, pttl)).toISOString(),
    seq: Number(hash.seq ?? 0),
    overall: computeOverall(items, locked),
    lastReject: hash.lastReject ? (JSON.parse(hash.lastReject) as Reject) : null,
    items,
  };
  return { snapshot, meta, raw, locked };
}
