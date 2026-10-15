import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { AppError, type ErrorCode } from '../errors.js';
import { cookies } from './cookies.js';
import { scrubCredentials, ytdlpNetArgs, type YtdlpNet } from './net.js';

export const SETUBE_TMP = path.join(os.tmpdir(), 'setube');

export const minimalEnv: NodeJS.ProcessEnv = Object.freeze({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
});

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export interface ProcLogger {
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

interface ProcSettings {
  ytdlpPath: string;
  ytdlpArgsPrefix: string[];
  ytdlpNet: YtdlpNet;
  ffmpegPath: string;
  ffmpegArgsPrefix: string[];
  log: ProcLogger | undefined;
}

const settings: ProcSettings = {
  ytdlpPath: 'yt-dlp',
  ytdlpArgsPrefix: [],
  ytdlpNet: { potProviderUrl: null, proxy: null },
  ffmpegPath: 'ffmpeg',
  ffmpegArgsPrefix: [],
  log: undefined,
};

export function configureProc(s: Partial<ProcSettings>): void {
  Object.assign(settings, s);
}

// Proxy y PO token van en todas las invocaciones, antes de las opciones propias y del `--`
export function ytdlpArgv(args: (cookiesPath: string | null) => string[], cookiesPath: string | null): string[] {
  return [...settings.ytdlpArgsPrefix, ...ytdlpNetArgs(settings.ytdlpNet), ...args(cookiesPath)];
}

export interface SpawnOpts {
  stdio: StdioOptions;
}

export async function prepareTmp(dir = SETUBE_TMP): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

export function waitClose(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: Exit) => {
      if (done) return;
      done = true;
      resolve(e);
    };
    child.once('close', (code, signal) => finish({ code, signal }));
    child.once('error', () => {
      if (child.pid === undefined) finish({ code: null, signal: null });
    });
  });
}

const rmWorkDir = (d: string) =>
  fs.rm(d, { recursive: true, force: true }).catch((e: NodeJS.ErrnoException) => {
    settings.log?.warn({ code: e.code }, 'workdir_rm_failed');
  });

export async function spawnYtdlp(
  args: (cookiesPath: string | null) => string[],
  opts: SpawnOpts,
): Promise<{ child: ChildProcess; workDir: string; exited: Promise<Exit> }> {
  let workDir: string | undefined;
  let child: ChildProcess;
  try {
    workDir = await fs.mkdtemp(path.join(SETUBE_TMP, 'w-'));
    const cookiesPath = cookies.configured ? await cookies.materialize(workDir) : null;
    child = spawn(settings.ytdlpPath, ytdlpArgv(args, cookiesPath), {
      shell: false,
      cwd: workDir,
      stdio: opts.stdio,
      env: minimalEnv,
    });
  } catch (e) {
    if (workDir) await rmWorkDir(workDir);
    throw new AppError('INTERNAL', { cause: e });
  }
  const dir = workDir;
  const exited = waitClose(child).finally(() => rmWorkDir(dir));
  return { child, workDir: dir, exited };
}

export function spawnFfmpeg(args: string[], opts: SpawnOpts): { child: ChildProcess; exited: Promise<Exit> } {
  let child: ChildProcess;
  try {
    child = spawn(settings.ffmpegPath, [...settings.ffmpegArgsPrefix, ...args], {
      shell: false,
      cwd: SETUBE_TMP,
      stdio: opts.stdio,
      env: minimalEnv,
    });
  } catch (e) {
    throw new AppError('INTERNAL', { cause: e });
  }
  return { child, exited: waitClose(child) };
}

export function kill(child: ChildProcess | undefined | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* ya muerto */
  }
}

export class RingBuffer {
  private readonly buf: string[] = [];
  constructor(private readonly size = 50) {}
  push(line: string): void {
    this.buf.push(scrubCredentials(line));
    if (this.buf.length > this.size) this.buf.shift();
  }
  lines(): string[] {
    return [...this.buf];
  }
  text(): string {
    return this.buf.join('\n');
  }
}

export function classifyLiveLine(line: string): Extract<ErrorCode, 'UPSTREAM_FORBIDDEN'> | null {
  if (/The info failed to download/i.test(line)) return 'UPSTREAM_FORBIDDEN';
  if (/HTTP Error 4(03|10)\b/i.test(line) && !/Retrying/i.test(line)) return 'UPSTREAM_FORBIDDEN';
  return null;
}

export function readLines(stream: Readable, onLine: (line: string) => void): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    rest += chunk;
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop() ?? '';
    for (const p of parts) if (p !== '') onLine(p);
    if (rest.length > 64 * 1024) {
      onLine(rest);
      rest = '';
    }
  });
  stream.on('end', () => {
    if (rest !== '') onLine(rest);
    rest = '';
  });
}

export class Gate extends Transform {
  private isClosed = false;
  get shut(): boolean {
    return this.isClosed;
  }
  close(): void {
    this.isClosed = true;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.isClosed) return cb();
    cb(null, chunk);
  }
}

export interface CollectResult {
  stdout: Buffer;
  exit: Exit;
  timedOut: boolean;
  overflow: boolean;
  stderr: RingBuffer;
}

export function collect(
  child: ChildProcess,
  exited: Promise<Exit>,
  opts: { timeoutMs: number; maxBytes: number; isProgress?: (line: string) => boolean },
): Promise<CollectResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let timedOut = false;
  const ring = new RingBuffer(50);
  child.stdout?.on('data', (c: Buffer) => {
    if (overflow) return;
    size += c.length;
    if (size > opts.maxBytes) {
      overflow = true;
      chunks.length = 0;
      kill(child);
      return;
    }
    chunks.push(c);
  });
  if (child.stderr) {
    readLines(child.stderr, (line) => {
      if (!opts.isProgress?.(line)) ring.push(line);
    });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    kill(child);
  }, opts.timeoutMs);
  return exited.then((exit) => {
    clearTimeout(timer);
    return { stdout: Buffer.concat(chunks), exit, timedOut, overflow, stderr: ring };
  });
}

export async function binaryVersion(kind: 'ytdlp' | 'ffmpeg'): Promise<string> {
  const proc =
    kind === 'ytdlp'
      ? await spawnYtdlp(() => ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnFfmpeg(['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const r = await collect(proc.child, proc.exited, { timeoutMs: 15000, maxBytes: 1024 * 1024 });
  if (r.exit.code !== 0) throw new AppError('INTERNAL', { message: `${kind} no disponible`, details: { code: r.exit.code } });
  return r.stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
}
