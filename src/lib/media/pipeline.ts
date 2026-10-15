import type { ChildProcess } from 'node:child_process';
import { PassThrough, Transform, type Readable, type TransformCallback, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { Redis } from 'ioredis';
import type { Config } from '../../config/env.js';
import { AppError, type ErrorCode } from '../errors.js';
import type { Reporter } from '../jobs/reporter.js';
import type { Semaphore, SlotHandle } from '../jobs/semaphore.js';
import { selectFormats, type FormatGap, type OutputFormat, type Quality, type Selection } from '../youtube/formats.js';
import type { Meta, MetadataService } from '../youtube/metadata.js';
import { classifyYtdlpError } from '../youtube/ytdlp-errors.js';
import { ActiveTimer, type TimerCode } from './active-timer.js';
import { ffmpegArgs, progressFd, ytdlpDownloadArgs } from './args.js';
import { classifyLiveLine, Gate, kill, readLines, RingBuffer, spawnFfmpeg, spawnYtdlp, type Exit } from './proc.js';
import { FfmpegProgressParser, isProgressLine, ItemProgress, parseYtdlpLine } from './progress.js';

type Json = Record<string, unknown>;

export interface PipelineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export interface PipelineDeps {
  config: Config;
  redis: Redis;
  metadata: MetadataService;
  semaphore: Semaphore;
  log: PipelineLogger;
  timers?: { tickMs?: number; stallCheckMs?: number };
}

export interface StreamCtx {
  deps: PipelineDeps;
  jobId: string;
  streamId: string;
  format: OutputFormat;
  quality: Quality;
  reporter: Reporter;
  signal: AbortSignal;
  isCanceled: () => Promise<boolean>;
}

export interface Prepared {
  meta: Meta;
  infoJson: Json | null;
  selection: Selection;
}

export type ItemSink =
  | { mode: 'file'; out: Writable }
  | {
      mode: 'archive';
      out: PassThrough;
      onFirstByte: () => void;
      headAt: () => number | undefined;
    };

export type ItemOutcome = 'done' | 'error' | 'canceled';

export interface ItemResult {
  outcome: ItemOutcome;
  code?: ErrorCode;
  firstByte: boolean;
}

const durationLimit = (cfg: Config, format: OutputFormat) => (format === 'mp4' ? cfg.maxDurationVideoSec : cfg.maxDurationAudioSec);

const REASON_CODES: Record<string, ErrorCode> = {
  client_closed: 'DOWNLOAD_INTERRUPTED',
  SERVER_SHUTDOWN: 'SERVER_SHUTDOWN',
  lock_lost: 'INTERNAL',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  CONVERSION_TIMEOUT: 'CONVERSION_TIMEOUT',
  STALLED: 'STALLED',
};

const isIgnorableStreamError = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
};

class CountingGate extends Gate {
  constructor(private readonly onChunk: (n: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.shut) this.onChunk(chunk.length);
    super._transform(chunk, enc, cb);
  }
}

class Counter extends Transform {
  bytes = 0;
  constructor(private readonly onChunk: (n: number, first: boolean) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const first = this.bytes === 0;
    this.bytes += chunk.length;
    this.onChunk(chunk.length, first);
    cb(null, chunk);
  }
}

export async function prepareItem(ctx: StreamCtx, itemId: string): Promise<Prepared> {
  const { config, metadata } = ctx.deps;
  await ctx.reporter.startAttempt(itemId);
  const { videoId } = ctx.reporter.get(itemId);
  let meta = await metadata.get(videoId);
  let infoJson: Json | null = null;
  if (config.ytdlpInfoJson) {
    infoJson = await metadata.readInfoJson(videoId);
    if (!infoJson) ({ meta, infoJson } = await metadata.refresh(videoId));
  }
  ctx.reporter.progress(itemId, { title: meta.title, duration: meta.duration, durationVerified: true });
  if (meta.live) throw new AppError('LIVE_NOT_SUPPORTED');
  if (meta.duration > durationLimit(config, ctx.format)) throw new AppError('LIMIT_DURATION');
  const sel = selectFormats(meta, ctx.format, ctx.quality, { audioHlsFallback: config.audioHlsFallback });
  if (!sel.ok) throw new AppError('FORMAT_UNAVAILABLE', { cause: { reason: sel.reason } });
  if (sel.selection.format === 'm4a' && sel.selection.transcode) ctx.deps.log.info({ videoId }, 'm4a_transcode_fallback');
  if (sel.selection.protocol === 'm3u8_native') ctx.deps.log.info({ videoId }, 'audio_hls_fallback');
  return { meta, infoJson, selection: sel.selection };
}

type AttemptResult = { kind: 'ok' } | { kind: 'fallback' } | { kind: 'error'; code: ErrorCode };

interface Runner {
  ctx: StreamCtx;
  itemId: string;
  sink: ItemSink;
  signal: AbortSignal;
  progress: ItemProgress;
  exiteds: Promise<Exit>[];
  children: Set<ChildProcess>;
  firstByte: boolean;
  bytesSent: number;
  lastActivity: number;
  closed: boolean;
}

function publishProgress(r: Runner): void {
  const p = r.progress.compute();
  r.ctx.reporter.progress(r.itemId, { pct: p.pct, phase: p.phase, speedBps: p.speedBps, etaSec: p.etaSec, bytesSent: r.bytesSent });
}

function killAll(r: Runner): void {
  for (const c of r.children) kill(c);
}

async function runAttempt(r: Runner, prep: Prepared): Promise<AttemptResult> {
  const { ctx, sink, signal } = r;
  const { config, log } = ctx.deps;
  const { selection, meta, infoJson } = prep;
  const video = selection.format === 'mp4';
  const useInfo = config.ytdlpInfoJson && infoJson !== null;

  type YProc = { role: 'A' | 'V'; child: ChildProcess; exited: Promise<Exit>; ring: RingBuffer; gate: CountingGate; exit?: Exit };
  const yprocs: YProc[] = [];
  let ff: { child: ChildProcess; exited: Promise<Exit> } | undefined;
  let triggered = false;
  let failFast = false;
  const attemptKill = () => {
    failFast = true;
    for (const y of yprocs) kill(y.child);
    kill(ff?.child);
    // Con el cliente en backpressure, el stdout pausado (con datos pendientes) nunca emite 'end' y el
    // 'close' del hijo no llega: exited no resolvería y el slot quedaría retenido. Se descarta la salida.
    for (const y of yprocs) y.child.stdout?.destroy();
    ff?.child.stdout?.destroy();
  };

  try {
    for (const p of selection.procs) {
      const proc = await spawnYtdlp(
        ytdlpDownloadArgs({ videoId: meta.videoId, formatId: p.formatId, infoJson: useInfo, hls: selection.protocol === 'm3u8_native' }),
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      r.children.add(proc.child);
      r.exiteds.push(proc.exited);
      const gate = new CountingGate(() => (r.lastActivity = Date.now()));
      yprocs.push({ role: p.role, child: proc.child, exited: proc.exited, ring: new RingBuffer(50), gate });
      if (signal.aborted) break;
    }
    if (!signal.aborted) {
      ff = spawnFfmpeg(ffmpegArgs({ selection, title: meta.title, artist: meta.author }), {
        stdio: video ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      r.children.add(ff.child);
    }
  } catch (e) {
    for (const y of yprocs) kill(y.child);
    await Promise.allSettled(yprocs.map((y) => y.exited));
    log.error({ code: (e as AppError).cause && ((e as AppError).cause as NodeJS.ErrnoException).code }, 'spawn_failed');
    return { kind: 'error', code: 'INTERNAL' };
  }
  if (signal.aborted || !ff) {
    for (const y of yprocs) kill(y.child);
    await Promise.allSettled(yprocs.map((y) => y.exited));
    throw signal.reason;
  }
  const ffp = ff;

  const onAbort = () => attemptKill();
  signal.addEventListener('abort', onAbort, { once: true });

  const ffRing = new RingBuffer(20);
  const parser = new FfmpegProgressParser();
  readLines(ffp.child.stdio[progressFd(selection.format)] as Readable, (line) => {
    const b = parser.push(line);
    if (b) {
      r.progress.ffmpeg(b.outTimeUs);
      publishProgress(r);
    }
  });
  if (ffp.child.stderr) readLines(ffp.child.stderr, (line) => ffRing.push(line));
  const counter = new Counter((n, first) => {
    r.bytesSent += n;
    r.lastActivity = Date.now();
    if (first && !r.firstByte && !r.closed) {
      r.firstByte = true;
      if (sink.mode === 'archive') sink.onFirstByte();
    }
  });
  const counterDone = pipeline(ffp.child.stdout as Readable, counter).catch((e) => {
    if (!isIgnorableStreamError(e)) log.debug({ err: { message: (e as Error).message } }, 'ffmpeg_stdout_error');
  });
  counter.pipe(sink.out, { end: false });

  const inputs: Writable[] = [ffp.child.stdin as Writable, (ffp.child.stdio[3] as Writable | null) ?? (ffp.child.stdin as Writable)];
  yprocs.forEach((y, i) => {
    const stdin = y.child.stdin as Writable;
    stdin.on('error', () => undefined);
    if (useInfo) stdin.end(JSON.stringify(infoJson));
    else stdin.end();
    const dest = video ? (inputs[i] as Writable) : (ffp.child.stdin as Writable);
    dest.on('error', () => undefined);
    pipeline(y.child.stdout as Readable, y.gate, dest).catch((e) => {
      if (!isIgnorableStreamError(e) && !failFast) log.debug({ err: { message: (e as Error).message } }, 'ytdlp_stdout_error');
    });
    readLines(y.child.stderr as Readable, (line) => {
      if (isProgressLine(line)) {
        const p = parseYtdlpLine(line, log);
        if (p) {
          r.progress.ytdlp(y.role, p);
          publishProgress(r);
        }
        return;
      }
      y.ring.push(line);
      if (!triggered && classifyLiveLine(line)) {
        triggered = true;
        y.gate.close();
        attemptKill();
      }
    });
    y.exited.then((exit) => {
      y.exit = exit;
      r.children.delete(y.child);
      const ok = exit.code === 0;
      r.progress.exited(y.role, ok && !triggered);
      if (!ok && !failFast) attemptKill();
      if (yprocs.every((x) => x.exit?.code === 0) && !triggered && !failFast && !signal.aborted) {
        const p = r.progress.compute();
        void ctx.reporter.transition(r.itemId, 'converting', {
          pct: p.pct, phase: 'convert', speedBps: null, etaSec: null, bytesSent: r.bytesSent,
        });
      }
    });
  });
  let ffExit: Exit | undefined;
  ffp.exited.then((exit) => {
    ffExit = exit;
    r.children.delete(ffp.child);
    if (exit.code !== 0 && !failFast) attemptKill();
  });

  await Promise.allSettled([...yprocs.map((y) => y.exited), ffp.exited]);
  signal.removeEventListener('abort', onAbort);

  const settle = () => {
    counter.unpipe(sink.out);
    counter.resume();
  };
  if (signal.aborted) {
    settle();
    throw signal.reason;
  }
  const forbidden = (): AttemptResult => {
    settle();
    return r.firstByte ? { kind: 'error', code: 'UPSTREAM_FORBIDDEN' } : { kind: 'fallback' };
  };
  if (triggered) return forbidden();
  const failedY = yprocs.find((y) => y.exit && y.exit.code !== null && y.exit.code !== 0);
  if (failedY) {
    const code = classifyYtdlpError(failedY.ring.lines(), failedY.exit?.code ?? 1) ?? 'UPSTREAM_ERROR';
    if (code === 'UPSTREAM_FORBIDDEN') return forbidden();
    settle();
    log.warn({ jobId: ctx.jobId, itemId: r.itemId, code, stderr: failedY.ring.lines().slice(-10) }, 'ytdlp_failed');
    return { kind: 'error', code };
  }
  if (yprocs.some((y) => y.exit && y.exit.code === null && y.exit.signal === null)) {
    settle();
    return { kind: 'error', code: 'INTERNAL' };
  }
  if (!ffExit || ffExit.code !== 0) {
    settle();
    log.error({ jobId: ctx.jobId, itemId: r.itemId, exit: ffExit, stderr: ffRing.lines() }, 'ffmpeg_failed');
    return { kind: 'error', code: 'INTERNAL' };
  }
  if (yprocs.some((y) => y.exit?.code !== 0)) {
    settle();
    return { kind: 'error', code: 'UPSTREAM_ERROR' };
  }
  await counterDone;
  await finished(counter, { writable: false }).catch(() => undefined);
  return { kind: 'ok' };
}

const abortable = (p: Promise<unknown>, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });

function consumed(sink: ItemSink): Promise<void> {
  if (sink.mode === 'file') return finished(sink.out, { readable: false });
  return finished(sink.out, { readable: true, writable: false });
}

export async function runItem(ctx: StreamCtx, itemId: string, sink: ItemSink, prepared?: Prepared): Promise<ItemResult> {
  const { config, log, semaphore } = ctx.deps;
  const started = Date.now();
  const item = ctx.reporter.get(itemId);
  const itemAbort = new AbortController();
  const onStreamAbort = () => itemAbort.abort(ctx.signal.reason);
  if (ctx.signal.aborted) itemAbort.abort(ctx.signal.reason);
  else ctx.signal.addEventListener('abort', onStreamAbort, { once: true });
  const signal = itemAbort.signal;

  const r: Runner = {
    ctx, itemId, sink, signal,
    progress: new ItemProgress([], 0),
    exiteds: [],
    children: new Set(),
    firstByte: false,
    bytesSent: 0,
    lastActivity: Date.now(),
    closed: false,
  };

  let slot: SlotHandle | undefined;
  let timer: ActiveTimer | undefined;
  let outcome: ItemOutcome = 'error';
  let code: ErrorCode | undefined;
  let gap: FormatGap | undefined;
  let prep = prepared;
  let queueMs = 0;
  let fallbackUsed = false;

  try {
    if (!prep) prep = await prepareItem(ctx, itemId);
    if (signal.aborted) throw signal.reason;
    if (await ctx.isCanceled()) throw 'canceled';

    const tq = Date.now();
    await ctx.reporter.transition(itemId, 'queued', { position: null });
    slot = await semaphore.acquire(`${ctx.streamId}:${itemId}`, {
      signal,
      onPosition: (position) => void ctx.reporter.transition(itemId, 'queued', { position }),
    });
    queueMs = Date.now() - tq;
    if (await ctx.isCanceled()) throw 'canceled';

    timer = new ActiveTimer({
      mode: sink.mode,
      out: sink.out,
      slotAt: slot.at,
      headAt: sink.mode === 'archive' ? sink.headAt : undefined,
      lastActivity: () => r.lastActivity,
      activeLimitMs: config.conversionTimeoutMs,
      wallLimitMs: config.conversionWallTimeoutMs,
      stallLimitMs: config.stallTimeoutMs,
      onExpire: (c: TimerCode) => itemAbort.abort(c),
      onIgnored: (c) => log.debug({ jobId: ctx.jobId, itemId, code: c }, 'timer_after_end'),
      tickMs: ctx.deps.timers?.tickMs,
      stallCheckMs: ctx.deps.timers?.stallCheckMs,
    });

    r.progress = new ItemProgress(prep.selection.procs, prep.meta.duration);
    r.lastActivity = Date.now();
    for (;;) {
      if (ctx.reporter.get(itemId).status !== 'downloading') {
        await ctx.reporter.transition(itemId, 'downloading', { phase: 'download', pct: r.progress.compute().pct });
      }
      const res = await runAttempt(r, prep);
      if (res.kind === 'ok') break;
      if (res.kind === 'error') throw new AppError(res.code);
      if (fallbackUsed) throw new AppError('UPSTREAM_FORBIDDEN');
      fallbackUsed = true;
      log.warn({ jobId: ctx.jobId, itemId, videoId: item.videoId }, 'info_json_refresh');
      let meta: Meta = prep.meta;
      let infoJson: Json | null = prep.infoJson;
      if (config.ytdlpInfoJson) {
        await ctx.deps.redis.del(`ytinfo:${item.videoId}`).catch(() => undefined);
        ({ meta, infoJson } = await ctx.deps.metadata.refresh(item.videoId));
      }
      const sel = selectFormats(meta, ctx.format, ctx.quality, { audioHlsFallback: config.audioHlsFallback });
      if (!sel.ok) throw new AppError('FORMAT_UNAVAILABLE', { cause: { reason: sel.reason } });
      prep = { meta, infoJson, selection: sel.selection };
      r.progress.restart();
      r.lastActivity = Date.now();
      if (signal.aborted) throw signal.reason;
    }

    if (sink.mode === 'archive') {
      sink.out.end();
      void ctx.reporter.transition(itemId, 'converting', { pct: 99.9, phase: 'convert', bytesSent: r.bytesSent });
    } else {
      sink.out.end();
    }
    await abortable(consumed(sink), signal);
    outcome = 'done';
  } catch (e) {
    const reason = signal.aborted ? String(signal.reason) : typeof e === 'string' ? e : undefined;
    if (reason === 'canceled') outcome = 'canceled';
    else {
      outcome = 'error';
      code = reason ? (REASON_CODES[reason] ?? 'INTERNAL') : e instanceof AppError ? e.code : 'INTERNAL';
      if (e instanceof AppError && e.code === 'FORMAT_UNAVAILABLE') gap = (e.cause as { reason?: FormatGap } | undefined)?.reason;
      if (!reason && !(e instanceof AppError)) log.error({ err: e, jobId: ctx.jobId, itemId }, 'item_failed');
    }
  } finally {
    r.closed = true;
    ctx.signal.removeEventListener('abort', onStreamAbort);
    killAll(r);
    timer?.stop();
    if (sink.mode === 'archive' && outcome !== 'done') {
      if (!sink.out.writableEnded) sink.out.end();
      if (r.firstByte) await abortable(consumed(sink), ctx.signal).catch(() => undefined);
    }
    await slot?.release();
    await Promise.allSettled(r.exiteds);

    const patch = { bytesSent: r.bytesSent };
    if (outcome === 'done') await ctx.reporter.transition(itemId, 'done', { ...patch, phase: undefined, speedBps: null, etaSec: null });
    else if (outcome === 'canceled') await ctx.reporter.transition(itemId, 'canceled', patch);
    else await ctx.reporter.fail(itemId, code ?? 'INTERNAL', patch);

    const lockLost = ctx.signal.reason === 'lock_lost';
    const line = {
      jobId: ctx.jobId,
      itemId,
      videoId: item.videoId,
      format: ctx.format,
      quality: ctx.quality,
      outcome: lockLost ? 'INTERNAL' : outcome,
      ...(code ? { code } : {}),
      ...(gap ? { format_unavailable_reason: gap } : {}),
      protocol: prep?.selection.protocol ?? null,
      attempt: ctx.reporter.get(itemId).attempt,
      ms: Date.now() - started,
      bytesSent: r.bytesSent,
      queueMs,
      usedInfoJson: config.ytdlpInfoJson && !!prep?.infoJson,
      infoJsonRefresh: fallbackUsed,
    };
    if (lockLost) log.error(line, 'lock_lost');
    log.info(line, 'item_finished');
  }
  return { outcome, ...(code ? { code } : {}), firstByte: r.firstByte };
}
