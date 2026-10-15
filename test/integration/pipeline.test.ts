import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { Lifecycle } from '../../src/lib/lifecycle.js';
import { evChannel, SEM_KEYS } from '../../src/lib/jobs/lua.js';
import { Semaphore } from '../../src/lib/jobs/semaphore.js';
import { openSession, type Session } from '../../src/lib/jobs/session.js';
import { runArchive } from '../../src/lib/jobs/stream-archive.js';
import { archiveQueue, cancelJob, createJob, readJob, type JobView } from '../../src/lib/jobs/store.js';
import { cookies } from '../../src/lib/media/cookies.js';
import { prepareItem, runItem, type PipelineDeps, type StreamCtx } from '../../src/lib/media/pipeline.js';
import { configureProc, SETUBE_TMP } from '../../src/lib/media/proc.js';
import { PubSub } from '../../src/lib/pubsub.js';
import { createMetadata } from '../../src/lib/youtube/metadata.js';
import { testConfig } from './helpers/app.js';
import { createTestRedis, type TestRedis } from './helpers/redis.js';

const FAKE_YTDLP = fileURLToPath(new URL('../fixtures/fake-ytdlp.mjs', import.meta.url));
const FAKE_FFMPEG = fileURLToPath(new URL('../fixtures/fake-ffmpeg.mjs', import.meta.url));

let t: TestRedis;
let pubsub: PubSub;
let dir: string;
let config: Config;
let deps: PipelineDeps;
const logs: { msg: string; obj: Record<string, unknown> }[] = [];
const log = {
  info: (obj: object, msg: string) => void logs.push({ msg, obj: obj as Record<string, unknown> }),
  warn: (obj: object, msg: string) => void logs.push({ msg, obj: obj as Record<string, unknown> }),
  error: (obj: object, msg: string) => void logs.push({ msg, obj: obj as Record<string, unknown> }),
  debug: () => undefined,
};

beforeAll(async () => {
  t = await createTestRedis();
  pubsub = new PubSub(t.subscriber);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setube-fake-'));
  await fs.mkdir(SETUBE_TMP, { recursive: true, mode: 0o700 });
  configureProc({
    ytdlpPath: process.execPath,
    ytdlpArgsPrefix: [FAKE_YTDLP, '--scenario', dir],
    ffmpegPath: process.execPath,
    ffmpegArgsPrefix: [FAKE_FFMPEG, '--scenario', dir],
  });
  config = testConfig({ CONVERT_CONCURRENCY: '2', ZIP_PARALLEL_AUDIO: '2', STALL_TIMEOUT_MS: '1500' });
  deps = {
    config,
    redis: t.redis,
    metadata: createMetadata({ redis: t.redis, log, metaTtlSec: 600, infoJsonTtlSec: 600, metaConcurrency: 4 }),
    semaphore: new Semaphore({
      redis: t.redis, pubsub, slots: 2, holdLeaseMs: 30_000, waitLeaseMs: 20_000, queueMax: 200, waitTimeoutMs: 10_000, pollMs: 50,
    }),
    log,
    timers: { tickMs: 100, stallCheckMs: 100 },
  };
});

afterAll(async () => {
  await t?.cleanup();
  await fs.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vid = () => randomUUID().replace(/-/g, '').slice(0, 11);

async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 8000): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('waitFor: tiempo agotado');
    await sleep(25);
  }
}

const scenario = (videoId: string, sc: unknown) => fs.writeFile(path.join(dir, `${videoId}.json`), JSON.stringify(sc));

type LogLine = { kind: string; pid: number; cwd: string; videoId?: string; argv?: string[]; cookies?: { path: string; inCwd: boolean; exists: boolean; name: string } | null; mode?: string };
async function readLog(name: 'ytdlp.log' | 'ffmpeg.log'): Promise<LogLine[]> {
  try {
    return (await fs.readFile(path.join(dir, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogLine);
  } catch {
    return [];
  }
}
const ylog = async (videoId: string, kind?: string) => (await readLog('ytdlp.log')).filter((l) => l.videoId === videoId && (!kind || l.kind === kind));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (p: string) => fs.access(p).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT');

async function makeJob(videoIds: string[], format: 'mp3' | 'mp4' = 'mp3'): Promise<{ jobId: string; view: JobView }> {
  const jobId = randomUUID();
  await createJob(t.redis, {
    jobId, format, quality: format === 'mp3' ? 192 : 360, ipHash: 'h', ttlSec: 600,
    items: videoIds.map((videoId) => ({ videoId, title: null, duration: null, durationVerified: false })),
  });
  return { jobId, view: (await readJob(t.redis, jobId, { slotLeaseMs: config.slotLeaseMs }))! };
}

async function open(jobId: string, view: JobView): Promise<{ s: Session; ctx: StreamCtx }> {
  const s = await openSession({
    redis: t.redis, pubsub, lifecycle: new Lifecycle(), log, view, jobId, ipHash: randomUUID(),
    maxPerIp: 3, slotLeaseMs: config.slotLeaseMs, jobTtlSec: config.jobTtlSec,
  });
  const ctx: StreamCtx = {
    deps, jobId, streamId: s.streamId, format: view.meta.format, quality: view.meta.quality,
    reporter: s.reporter, signal: s.signal, isCanceled: s.isCanceled,
  };
  return { s, ctx };
}

function fileSink() {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  return { out, bytes: () => chunks.reduce((a, c) => a + c.length, 0), body: () => Buffer.concat(chunks) };
}

async function events(jobId: string) {
  const sub = t.subscriber.duplicate();
  const list: { id: number; event: string; data: Record<string, unknown> }[] = [];
  sub.on('message', (_c: string, m: string) => list.push(JSON.parse(m)));
  await sub.subscribe(evChannel(jobId));
  return { list, close: () => sub.quit() };
}

async function runFile(jobId: string, view: JobView, itemId = 'i0') {
  const { s, ctx } = await open(jobId, view);
  const sink = fileSink();
  sink.out.on('close', () => {
    if (!sink.out.writableFinished) s.abort('client_closed');
  });
  try {
    const prepared = await prepareItem(ctx, itemId);
    const result = await runItem(ctx, itemId, { mode: 'file', out: sink.out }, prepared);
    return { result, sink };
  } finally {
    await s.close();
  }
}

const item = async (jobId: string, itemId = 'i0') =>
  (await readJob(t.redis, jobId, { slotLeaseMs: config.slotLeaseMs }))!.snapshot.items.find((i) => i.itemId === itemId)!;

describe('pipeline (runItem)', () => {
  it('éxito → done al 100 %, cwd w-* propio por yt-dlp (-J incluido), ffmpeg en SETUBE_TMP, stdin sin webpage_url', async () => {
    const v = vid();
    const { jobId, view } = await makeJob([v]);
    const ev = await events(jobId);
    const { result, sink } = await runFile(jobId, view);
    expect(result).toMatchObject({ outcome: 'done', firstByte: true });
    expect(sink.bytes()).toBe(200000);
    expect(await item(jobId)).toMatchObject({ status: 'done', pct: 100, attempt: 1, bytesSent: 200000, durationVerified: true });
    await sleep(50);
    expect(ev.list.map((e) => e.event)).toEqual(expect.arrayContaining(['fetching', 'queued', 'downloading', 'converting', 'done']));
    await ev.close();

    const [info] = await ylog(v, 'info');
    const [dl] = await ylog(v, 'download');
    for (const l of [info!, dl!]) {
      expect(path.dirname(l.cwd)).toBe(SETUBE_TMP);
      expect(path.basename(l.cwd)).toMatch(/^w-/);
      expect(await gone(l.cwd)).toBe(true);
    }
    expect(info!.cwd).not.toBe(dl!.cwd);
    expect(dl!.argv!.join(' ')).toContain('--load-info-json -');
    const ff = (await readLog('ffmpeg.log')).filter((l) => l.kind === 'start').at(-1)!;
    expect(ff.cwd).toBe(SETUBE_TMP);
    expect(logs.some((l) => l.msg === 'item_finished' && l.obj.itemId === 'i0' && l.obj.jobId === jobId && l.obj.outcome === 'done')).toBe(true);
  });

  it('«The info failed to download»: SIGKILL, ningún byte posterior llega a ffmpeg y fallback con refresh, mismo attempt', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'infoFailed' }, { mode: 'ok' }] } });
    const { jobId, view } = await makeJob([v]);
    const ev = await events(jobId);
    const { result, sink } = await runFile(jobId, view);
    expect(result.outcome).toBe('done');
    expect(sink.body().includes(0x42)).toBe(false);
    const dls = await ylog(v, 'download');
    expect(dls).toHaveLength(2);
    expect(alive(dls[0]!.pid)).toBe(false);
    expect((await readLog('ffmpeg.log')).some((l) => l.kind === 'sawB')).toBe(false);
    const infos = await ylog(v, 'info');
    expect(infos).toHaveLength(2);
    for (const i of infos) expect(path.basename(i.cwd)).toMatch(/^w-/);
    await sleep(50);
    const attempts = new Set(ev.list.filter((e) => e.data?.itemId === 'i0').map((e) => e.data.attempt));
    expect([...attempts]).toEqual([1]);
    expect(logs.some((l) => l.msg === 'info_json_refresh' && l.obj.jobId === jobId)).toBe(true);
    await ev.close();
  });

  it('fallback 403: primer intento 403 → refresh una vez → done; dos 403 → UPSTREAM_FORBIDDEN', async () => {
    const a = vid();
    await scenario(a, { downloads: { '*': [{ mode: 'fail403' }, { mode: 'ok' }] } });
    const j1 = await makeJob([a]);
    expect((await runFile(j1.jobId, j1.view)).result.outcome).toBe('done');
    expect(await ylog(a, 'info')).toHaveLength(2);

    const b = vid();
    await scenario(b, { downloads: { '*': [{ mode: 'fail403' }, { mode: 'fail403' }] } });
    const j2 = await makeJob([b]);
    expect((await runFile(j2.jobId, j2.view)).result).toMatchObject({ outcome: 'error', code: 'UPSTREAM_FORBIDDEN' });
    expect(await ylog(b, 'info')).toHaveLength(2);
    expect(await ylog(b, 'download')).toHaveLength(2);
    expect(await item(j2.jobId)).toMatchObject({ status: 'error', errorKind: 'runtime', error: { code: 'UPSTREAM_FORBIDDEN' } });
  });

  it('yt-dlp con código 1 tras emitir bytes → error aunque ffmpeg salga con 0', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'exit1AfterBytes' }] } });
    const { jobId, view } = await makeJob([v]);
    const { result } = await runFile(jobId, view);
    expect(result).toMatchObject({ outcome: 'error', code: 'UPSTREAM_ERROR', firstByte: true });
    expect(await item(jobId)).toMatchObject({ status: 'error', errorKind: 'runtime' });
  });

  it('monotonía por intento: un segundo stream sobre un item done publica attempt 2 y pct 0 primero', async () => {
    const v = vid();
    const { jobId, view } = await makeJob([v]);
    await runFile(jobId, view);
    const ev = await events(jobId);
    const view2 = (await readJob(t.redis, jobId, { slotLeaseMs: config.slotLeaseMs }))!;
    const { result } = await runFile(jobId, view2);
    expect(result.outcome).toBe('done');
    await sleep(50);
    const first = ev.list.find((e) => e.data?.itemId === 'i0')!;
    expect(first).toMatchObject({ event: 'fetching', data: { attempt: 2, pct: 0, bytesSent: 0 } });
    expect(await item(jobId)).toMatchObject({ status: 'done', attempt: 2 });
    await ev.close();
  });

  it('cancelación por ctl:job → SIGKILL a los procesos (por PID) y slot libre', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'hang' }] } });
    const { jobId, view } = await makeJob([v]);
    const p = runFile(jobId, view);
    const dl = await waitFor(async () => (await ylog(v, 'download'))[0]);
    await waitFor(async () => (await item(jobId)).status === 'downloading');
    const ffPids = (await readLog('ffmpeg.log')).filter((l) => l.kind === 'start').map((l) => l.pid);
    expect(alive(dl.pid)).toBe(true);
    const t0 = Date.now();
    expect(await cancelJob(t.redis, jobId, 600)).toBe(1);
    const { result } = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.outcome).toBe('canceled');
    expect(alive(dl.pid)).toBe(false);
    expect(alive(ffPids.at(-1)!)).toBe(false);
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
    expect(await item(jobId)).toMatchObject({ status: 'canceled' });
    expect(await gone(dl.cwd)).toBe(true);
  });

  it('cancelación con el cliente en backpressure (no lee) → canceled < 2 s, procesos muertos y slot libre', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'ok', bytes: 50_000_000, chunk: 65_536, delayMs: 1 }] } });
    const { jobId, view } = await makeJob([v]);
    const { s, ctx } = await open(jobId, view);
    let got = 0;
    const out = new Writable({
      highWaterMark: 16_384,
      write(c: Buffer) {
        got += c.length;
      },
    });
    try {
      const prepared = await prepareItem(ctx, 'i0');
      const p = runItem(ctx, 'i0', { mode: 'file', out }, prepared);
      await waitFor(() => got > 0);
      const dl = await waitFor(async () => (await ylog(v, 'download'))[0]);
      const ffPid = (await readLog('ffmpeg.log')).filter((l) => l.kind === 'start').at(-1)!.pid;
      await sleep(500);
      expect(out.writableNeedDrain).toBe(true);
      const t0 = Date.now();
      expect(await cancelJob(t.redis, jobId, 600)).toBe(1);
      const result = await p;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(result.outcome).toBe('canceled');
      expect(alive(dl.pid)).toBe(false);
      expect(alive(ffPid)).toBe(false);
      expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
      expect(await gone(dl.cwd)).toBe(true);
    } finally {
      await s.close();
      out.destroy();
    }
  });

  it('desconexión del cliente → DOWNLOAD_INTERRUPTED', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'ok', bytes: 2_000_000, chunk: 8192, delayMs: 10 }] } });
    const { jobId, view } = await makeJob([v]);
    const { s, ctx } = await open(jobId, view);
    const sink = fileSink();
    sink.out.on('close', () => {
      if (!sink.out.writableFinished) s.abort('client_closed');
    });
    const prepared = await prepareItem(ctx, 'i0');
    const p = runItem(ctx, 'i0', { mode: 'file', out: sink.out }, prepared);
    await waitFor(() => sink.bytes() > 50_000);
    sink.out.destroy();
    const result = await p;
    await s.close();
    expect(result).toMatchObject({ outcome: 'error', code: 'DOWNLOAD_INTERRUPTED' });
    expect(await item(jobId)).toMatchObject({ status: 'error', error: { code: 'DOWNLOAD_INTERRUPTED' } });
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
  });

  it('stall: yt-dlp colgado sin bytes → STALLED a los STALL_TIMEOUT_MS, procesos muertos', async () => {
    const v = vid();
    await scenario(v, { downloads: { '*': [{ mode: 'hang' }] } });
    const { jobId, view } = await makeJob([v]);
    const t0 = Date.now();
    const { result } = await runFile(jobId, view);
    expect(result).toMatchObject({ outcome: 'error', code: 'STALLED' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    const [dl] = await ylog(v, 'download');
    expect(alive(dl!.pid)).toBe(false);
  });

  it('dos items concurrentes: cwd distintos, sin fragmentos compartidos y ENOENT al terminar (también con SIGKILL)', async () => {
    for (const mode of ['ok', 'hang'] as const) {
      const a = vid();
      const b = vid();
      await scenario(a, { downloads: { '*': [{ mode, delayMs: 5 }] } });
      await scenario(b, { downloads: { '*': [{ mode, delayMs: 5 }] } });
      const { jobId, view } = await makeJob([a, b]);
      const { s, ctx } = await open(jobId, view);
      const [pa, pb] = await Promise.all([prepareItem(ctx, 'i0'), prepareItem(ctx, 'i1')]);
      const runs = Promise.all([
        runItem(ctx, 'i0', { mode: 'file', out: fileSink().out }, pa),
        runItem(ctx, 'i1', { mode: 'file', out: fileSink().out }, pb),
      ]);
      const [la, lb] = await waitFor(async () => {
        const x = (await ylog(a, 'download'))[0];
        const y = (await ylog(b, 'download'))[0];
        return x && y ? [x, y] : null;
      });
      if (mode === 'hang') {
        await waitFor(async () => (await item(jobId, 'i1')).status === 'downloading');
        await cancelJob(t.redis, jobId, 600);
      }
      const results = await runs;
      await s.close();
      expect(results.map((r) => r.outcome)).toEqual(mode === 'ok' ? ['done', 'done'] : ['canceled', 'canceled']);
      expect(la!.cwd).not.toBe(lb!.cwd);
      expect(await gone(la!.cwd)).toBe(true);
      expect(await gone(lb!.cwd)).toBe(true);
      if (mode === 'hang') expect([la!.pid, lb!.pid].some(alive)).toBe(false);
    }
  });

  it('cookies configuradas: --cookies <su cwd>/ck-<uuid>.txt y el archivo no existe tras el exit', async () => {
    cookies.load({
      file: null,
      json: JSON.stringify([{ domain: '.youtube.com', name: 'SID', value: 'no-es-real', path: '/', secure: true }]),
      isProd: false,
    });
    try {
      const v = vid();
      const { jobId, view } = await makeJob([v]);
      expect((await runFile(jobId, view)).result.outcome).toBe('done');
      for (const l of await ylog(v)) {
        expect(l.cookies).toMatchObject({ inCwd: true, exists: true });
        expect(l.cookies!.name).toMatch(/^ck-[0-9a-f-]{36}\.txt$/);
        expect(await gone(l.cookies!.path)).toBe(true);
      }
    } finally {
      cookies.reset();
    }
  });
});

describe('pipeline (ZIP)', () => {
  async function zip(videoIds: string[], dest: Writable) {
    const { jobId, view } = await makeJob(videoIds);
    const { s, ctx } = await open(jobId, view);
    const items = view.meta.itemIds.map((id) => view.raw[id]!);
    const p = runArchive({
      ctx, abort: s.abort, queue: archiveQueue(items), excluded: [], dest, parallel: 2, forceZip64: false, ext: 'mp3',
    }).finally(() => s.close());
    return { jobId, p };
  }

  it('archiver bloqueado y K=2: el item que terminó de escribir retiene el slot en converting 99,9 hasta que se consume', async () => {
    const a = vid();
    const b = vid();
    await scenario(a, { bytes: 1_000_000 });
    await scenario(b, { bytes: 1_000_000 });
    // Destino que no lee (cliente bloqueado): retiene los callbacks de write hasta `unblock`
    // (un PassThrough como último stream de pipeline() se reanuda solo y no bloquea nada)
    let size = 0;
    let held: (() => void)[] | null = [];
    const dest = new Writable({
      write(c: Buffer, _e, cb) {
        size += c.length;
        if (held) held.push(cb);
        else cb();
      },
    });
    const unblock = () => {
      const cbs = held ?? [];
      held = null;
      for (const cb of cbs) cb();
    };
    const { jobId, p } = await zip([a, b], dest);
    let last: unknown;
    const waiting = await waitFor(async () => {
      const snap = (await readJob(t.redis, jobId, { slotLeaseMs: config.slotLeaseMs }))!.snapshot;
      const holders = await t.redis.zcard(SEM_KEYS.holders);
      last = { holders, items: snap.items.map((i) => [i.status, i.pct, i.bytesSent]) };
      return holders === 2 && snap.items.find((i) => i.status === 'converting' && i.pct === 99.9) ? snap : null;
    }, 8_000).catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(last)}`);
    });
    expect(waiting.items.some((i) => i.status === 'done')).toBe(false);
    await sleep(500);
    expect((await readJob(t.redis, jobId, { slotLeaseMs: config.slotLeaseMs }))!.snapshot.items.some((i) => i.status === 'done')).toBe(false);
    unblock();
    const r = await p;
    expect(r.aborted).toBe(false);
    expect(Object.values(r.results).map((x) => x.outcome)).toEqual(['done', 'done']);
    expect(r.entries).toHaveLength(2);
    expect(r.entries).not.toContain('ERRORES.txt');
    expect(size).toBeGreaterThan(2_000_000);
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
  }, 20_000);

  it('item sin primer byte → STALLED con slot libre; el otro termina; ZIP finalizado con ERRORES.txt y sin entrada del fallido', async () => {
    const a = vid();
    const b = vid();
    await scenario(a, { downloads: { '*': [{ mode: 'hang' }] } });
    const dest = new PassThrough();
    let size = 0;
    dest.on('data', (c: Buffer) => (size += c.length));
    const { jobId, p } = await zip([a, b], dest);
    const pa = (await waitFor(async () => (await ylog(a, 'download'))[0]))!.pid;
    const r = await p;
    expect(r.results.i0).toMatchObject({ outcome: 'error', code: 'STALLED', firstByte: false });
    expect(r.results.i1).toMatchObject({ outcome: 'done' });
    expect(alive(pa)).toBe(false);
    expect(await t.redis.zcard(SEM_KEYS.holders)).toBe(0);
    expect(r.entries).toContain('ERRORES.txt');
    expect(r.entries).toHaveLength(2);
    expect(r.entries.some((n) => n.includes(a))).toBe(false);
    expect(size).toBeGreaterThan(200_000);
    expect((await item(jobId, 'i0')).error?.code).toBe('STALLED');
  });

  it('item que falla antes del primer byte (privado/no disponible) → ERRORES.txt y sin entrada', async () => {
    const a = vid();
    const b = vid();
    await scenario(a, { downloads: { '*': [{ mode: 'fail', message: 'Video unavailable' }] } });
    const dest = new PassThrough();
    dest.resume();
    const { p } = await zip([a, b], dest);
    const r = await p;
    expect(r.results.i0).toMatchObject({ outcome: 'error', code: 'VIDEO_UNAVAILABLE', firstByte: false });
    expect(r.results.i1).toMatchObject({ outcome: 'done' });
    expect(r.entries.filter((n) => n !== 'ERRORES.txt')).toEqual([`Título ${b}.mp3`]);
    expect(r.entries).toContain('ERRORES.txt');
  });
});
