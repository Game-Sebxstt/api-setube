import type { Redis } from 'ioredis';

const NOW = `local _t = redis.call('TIME'); local now = tonumber(_t[1]) * 1000 + math.floor(tonumber(_t[2]) / 1000)`;

const UPDATE_ITEM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSET', KEYS[1], 'it:' .. ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('PUBLISH', ARGV[5], '{"id":' .. seq .. ',"event":"' .. ARGV[3] .. '","data":' .. ARGV[2] .. ',"overall":' .. ARGV[6] .. '}')
return seq`;

const SNAPSHOT = `
${NOW}
return { redis.call('HGETALL', KEYS[1]), redis.call('PTTL', KEYS[1]), redis.call('EXISTS', KEYS[2]), now }`;

const CANCEL_JOB = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'status') == 'canceled' then return 2 end
${NOW}
redis.call('HSET', KEYS[1], 'status', 'canceled')
local meta = cjson.decode(redis.call('HGET', KEYS[1], 'meta'))
local total, done, failed, sum = 0, 0, 0, 0
for _, id in ipairs(meta.itemIds) do
  local raw = redis.call('HGET', KEYS[1], 'it:' .. id)
  if raw then
    local it = cjson.decode(raw)
    if it.status == 'pending' then
      it.status = 'canceled'; it.updatedAt = now; it.position = cjson.null
      redis.call('HSET', KEYS[1], 'it:' .. id, cjson.encode(it))
    end
    total = total + 1
    if it.status == 'done' then done = done + 1 end
    if it.status == 'error' then failed = failed + 1 end
    if it.status == 'done' or it.status == 'error' or it.status == 'canceled' then sum = sum + 100
    else sum = sum + (tonumber(it.pct) or 0) end
  end
end
local pct = 0
if total > 0 then pct = math.floor(sum / total * 10 + 0.5) / 10 end
local active = redis.call('EXISTS', KEYS[2]) == 1
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
local overall = cjson.encode({ pct = pct, done = done, failed = failed, total = total, active = active })
redis.call('PUBLISH', ARGV[3], '{"id":' .. seq .. ',"event":"canceled","data":{"jobId":' .. cjson.encode(ARGV[1]) .. ',"overall":' .. overall .. '}}')
redis.call('PUBLISH', ARGV[4], 'cancel')
return 1`;

const REJECT_JOB = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSET', KEYS[1], 'lastReject', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('PUBLISH', ARGV[3], '{"id":' .. seq .. ',"event":"rejected","data":' .. ARGV[1] .. '}')
return seq`;

const SEM_ACQUIRE = `
local t = redis.call('TIME'); local now = t[1]*1000 + math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local dead = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
for _, m in ipairs(dead) do redis.call('ZREM', KEYS[1], m); redis.call('ZREM', KEYS[3], m) end
local tk = ARGV[1]
if redis.call('ZSCORE', KEYS[2], tk) then
  redis.call('ZADD', KEYS[2], now + ARGV[3], tk); return {1, 0} end
if not redis.call('ZSCORE', KEYS[1], tk) then
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return {-1, 0} end
  redis.call('ZADD', KEYS[1], redis.call('INCR', KEYS[4]), tk)
end
redis.call('ZADD', KEYS[3], now + ARGV[4], tk)
local rank = redis.call('ZRANK', KEYS[1], tk)
local free = tonumber(ARGV[2]) - redis.call('ZCARD', KEYS[2])
if rank < free then
  redis.call('ZREM', KEYS[1], tk); redis.call('ZREM', KEYS[3], tk)
  redis.call('ZADD', KEYS[2], now + ARGV[3], tk); return {1, 0}
end
return {0, rank - math.max(free, 0) + 1}`;

const SEM_RENEW = `
${NOW}
local added = redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
if added == 1 then return 0 end
return 1`;

const SEM_RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('PUBLISH', ARGV[2], '1')
return 1`;

const LEASE_ACQUIRE = `
${NOW}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local lease = tonumber(ARGV[2])
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + lease, ARGV[1]); redis.call('PEXPIRE', KEYS[1], lease); return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now + lease, ARGV[1])
redis.call('PEXPIRE', KEYS[1], lease)
return 1`;

const LEASE_RENEW = `
${NOW}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local lease = tonumber(ARGV[2])
local had = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not had then return 0 end
redis.call('ZADD', KEYS[1], 'XX', now + lease, ARGV[1])
redis.call('PEXPIRE', KEYS[1], lease)
return 1`;

const LEASE_RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

const LOCK_ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then return 1 end
return 0`;

const LOCK_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])); return 1 end
return 0`;

const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const SCRIPTS = {
  setubeUpdateItem: [1, UPDATE_ITEM],
  setubeSnapshot: [2, SNAPSHOT],
  setubeCancelJob: [2, CANCEL_JOB],
  setubeRejectJob: [1, REJECT_JOB],
  setubeSemAcquire: [4, SEM_ACQUIRE],
  setubeSemRenew: [1, SEM_RENEW],
  setubeSemRelease: [3, SEM_RELEASE],
  setubeLeaseAcquire: [1, LEASE_ACQUIRE],
  setubeLeaseRenew: [1, LEASE_RENEW],
  setubeLeaseRelease: [1, LEASE_RELEASE],
  setubeLockAcquire: [1, LOCK_ACQUIRE],
  setubeLockRenew: [1, LOCK_RENEW],
  setubeLockRelease: [1, LOCK_RELEASE],
} as const;

type Arg = string | number;
type Cmd = (...args: Arg[]) => Promise<unknown>;

export const SEM_KEYS = { queue: 'sem:queue', holders: 'sem:holders', waiters: 'sem:waiters', seq: 'sem:seq' } as const;
export const SEM_WAKE = 'sem:wake';
export const LOCK_TTL_MS = 30_000;

export const jobKey = (jobId: string) => `job:${jobId}`;
export const lockKey = (jobId: string) => `job:${jobId}:lock`;
export const subsKey = (jobId: string) => `job:${jobId}:subs`;
export const ipsKey = (ipHash: string) => `ips:${ipHash}`;
export const evChannel = (jobId: string) => `ev:job:${jobId}`;
export const ctlChannel = (jobId: string) => `ctl:job:${jobId}`;

export interface JobScripts {
  updateItem(jobId: string, itemId: string, itemJson: string, event: string, ttlSec: number, overallJson: string): Promise<number>;
  snapshot(jobId: string): Promise<{ hash: Record<string, string>; pttl: number; locked: boolean; now: number }>;
  cancelJob(jobId: string, ttlSec: number): Promise<0 | 1 | 2>;
  rejectJob(jobId: string, rejectJson: string, ttlSec: number): Promise<number>;
  semAcquire(ticket: string, slots: number, holdLeaseMs: number, waitLeaseMs: number, queueMax: number): Promise<[number, number]>;
  semRenew(ticket: string, leaseMs: number): Promise<boolean>;
  semRelease(ticket: string): Promise<void>;
  leaseAcquire(key: string, member: string, leaseMs: number, limit: number): Promise<boolean>;
  leaseRenew(key: string, member: string, leaseMs: number): Promise<boolean>;
  leaseRelease(key: string, member: string): Promise<void>;
  lockAcquire(jobId: string, streamId: string, ttlMs?: number): Promise<boolean>;
  lockRenew(jobId: string, streamId: string, ttlMs?: number): Promise<boolean>;
  lockRelease(jobId: string, streamId: string): Promise<void>;
}

const cache = new WeakMap<Redis, JobScripts>();

export function scripts(redis: Redis): JobScripts {
  const hit = cache.get(redis);
  if (hit) return hit;
  const r = redis as unknown as Record<string, Cmd>;
  for (const [name, [numberOfKeys, lua]] of Object.entries(SCRIPTS)) {
    if (typeof r[name] !== 'function') redis.defineCommand(name, { numberOfKeys, lua });
  }
  const call = (name: keyof typeof SCRIPTS, ...args: Arg[]) => (r[name] as Cmd).call(redis, ...args);

  const api: JobScripts = {
    async updateItem(jobId, itemId, itemJson, event, ttlSec, overallJson) {
      return Number(await call('setubeUpdateItem', jobKey(jobId), itemId, itemJson, event, ttlSec, evChannel(jobId), overallJson));
    },
    async snapshot(jobId) {
      const [flat, pttl, locked, now] = (await call('setubeSnapshot', jobKey(jobId), lockKey(jobId))) as [string[], number, number, number];
      const hash: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) hash[flat[i] as string] = flat[i + 1] as string;
      return { hash, pttl: Number(pttl), locked: Number(locked) === 1, now: Number(now) };
    },
    async cancelJob(jobId, ttlSec) {
      return Number(await call('setubeCancelJob', jobKey(jobId), lockKey(jobId), jobId, ttlSec, evChannel(jobId), ctlChannel(jobId))) as 0 | 1 | 2;
    },
    async rejectJob(jobId, rejectJson, ttlSec) {
      return Number(await call('setubeRejectJob', jobKey(jobId), rejectJson, ttlSec, evChannel(jobId)));
    },
    async semAcquire(ticket, slots, holdLeaseMs, waitLeaseMs, queueMax) {
      const [a, b] = (await call(
        'setubeSemAcquire', SEM_KEYS.queue, SEM_KEYS.holders, SEM_KEYS.waiters, SEM_KEYS.seq,
        ticket, slots, holdLeaseMs, waitLeaseMs, queueMax,
      )) as [number, number];
      return [Number(a), Number(b)];
    },
    async semRenew(ticket, leaseMs) {
      return Number(await call('setubeSemRenew', SEM_KEYS.holders, ticket, leaseMs)) === 1;
    },
    async semRelease(ticket) {
      await call('setubeSemRelease', SEM_KEYS.queue, SEM_KEYS.holders, SEM_KEYS.waiters, ticket, SEM_WAKE);
    },
    async leaseAcquire(key, member, leaseMs, limit) {
      return Number(await call('setubeLeaseAcquire', key, member, leaseMs, limit)) === 1;
    },
    async leaseRenew(key, member, leaseMs) {
      return Number(await call('setubeLeaseRenew', key, member, leaseMs)) === 1;
    },
    async leaseRelease(key, member) {
      await call('setubeLeaseRelease', key, member);
    },
    async lockAcquire(jobId, streamId, ttlMs = LOCK_TTL_MS) {
      return Number(await call('setubeLockAcquire', lockKey(jobId), streamId, ttlMs)) === 1;
    },
    async lockRenew(jobId, streamId, ttlMs = LOCK_TTL_MS) {
      return Number(await call('setubeLockRenew', lockKey(jobId), streamId, ttlMs)) === 1;
    },
    async lockRelease(jobId, streamId) {
      await call('setubeLockRelease', lockKey(jobId), streamId);
    },
  };
  cache.set(redis, api);
  return api;
}
