export const PROGRESS_PREFIX = 'SETUBE_PROGRESS ';

export interface YtdlpProgress {
  downloaded: number | null;
  total: number | null;
  totalEstimate: number | null;
  speed: number | null;
  eta: number | null;
  status: 'downloading' | 'finished' | 'error' | null;
}

const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export const isProgressLine = (line: string) => line.startsWith(PROGRESS_PREFIX);

export function parseYtdlpLine(line: string, log?: { debug(obj: object, msg: string): void }): YtdlpProgress | null {
  if (!isProgressLine(line)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PROGRESS_PREFIX.length));
  } catch {
    log?.debug({ len: line.length }, 'ytdlp_progress_invalid_json');
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const status = r.status === 'downloading' || r.status === 'finished' || r.status === 'error' ? r.status : null;
  return {
    downloaded: nonNeg(r.downloaded_bytes),
    total: pos(r.total_bytes),
    totalEstimate: pos(r.total_bytes_estimate),
    speed: nonNeg(r.speed),
    eta: nonNeg(r.eta),
    status,
  };
}

export interface FfmpegProgress {
  outTimeUs: number | null;
  speed: number | null;
  end: boolean;
}

export class FfmpegProgressParser {
  private block = new Map<string, string>();

  push(line: string): FfmpegProgress | null {
    const i = line.indexOf('=');
    if (i <= 0) return null;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key !== 'progress') {
      this.block.set(key, value);
      return null;
    }
    const us = Number(this.block.get('out_time_us') ?? 'N/A');
    const speedRaw = this.block.get('speed');
    const speed = speedRaw && /^[\d.]+x$/.test(speedRaw) ? Number(speedRaw.slice(0, -1)) : null;
    this.block = new Map();
    return {
      outTimeUs: Number.isFinite(us) && us >= 0 ? us : null,
      speed: speed !== null && Number.isFinite(speed) ? speed : null,
      end: value === 'end',
    };
  }
}

export interface ProgressProc {
  role: 'A' | 'V';
  formatId: string;
  bytes: number | null;
}

export interface ProgressSnapshot {
  pct: number;
  phase: 'download' | 'convert';
  speedBps: number | null;
  etaSec: number | null;
}

interface ProcState {
  def: ProgressProc;
  last: YtdlpProgress | null;
  exitedOk: boolean;
  exited: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class ItemProgress {
  private procs: ProcState[] = [];
  private outTimeUs: number | null = null;
  private pctPrev = 0;

  constructor(
    private readonly defs: readonly ProgressProc[],
    private readonly duration: number,
  ) {
    this.restart();
  }

  restart(): void {
    this.procs = this.defs.map((def) => ({ def, last: null, exitedOk: false, exited: false }));
    this.outTimeUs = null;
  }

  private proc(role: 'A' | 'V'): ProcState | undefined {
    return this.procs.find((p) => p.def.role === role);
  }

  ytdlp(role: 'A' | 'V', p: YtdlpProgress): void {
    const s = this.proc(role);
    if (s) s.last = p;
  }

  exited(role: 'A' | 'V', ok: boolean): void {
    const s = this.proc(role);
    if (s) {
      s.exited = true;
      s.exitedOk = ok;
    }
  }

  ffmpeg(outTimeUs: number | null): void {
    if (outTimeUs !== null) this.outTimeUs = outTimeUs;
  }

  get downloading(): boolean {
    return this.procs.some((p) => !p.exited);
  }

  get allYtdlpOk(): boolean {
    return this.procs.every((p) => p.exitedOk);
  }

  compute(): ProgressSnapshot {
    const totalP = (p: ProcState) => p.last?.total ?? p.last?.totalEstimate ?? p.def.bytes ?? null;
    const dlP = (p: ProcState) => (p.exitedOk ? totalP(p) ?? 0 : p.last?.downloaded ?? 0);

    const totals = this.procs.map(totalP);
    const dlTotal = totals.every((t) => t != null) ? totals.reduce<number>((a, t) => a + (t as number), 0) : null;
    let dlFrac: number | null = dlTotal ? clamp01(this.procs.reduce((a, p) => a + dlP(p), 0) / dlTotal) : null;
    let cvFrac: number | null =
      this.duration > 0 && this.outTimeUs != null ? clamp01(this.outTimeUs / 1e6 / this.duration) : null;
    dlFrac = dlFrac ?? cvFrac ?? 0;
    cvFrac = cvFrac ?? (this.allYtdlpOk ? dlFrac : 0);
    let pct = Math.min(99.9, 85 * dlFrac + 15 * cvFrac);
    pct = Math.max(pct, this.pctPrev);
    pct = Math.round(pct * 10) / 10;
    this.pctPrev = pct;

    const alive = this.procs.filter((p) => !p.exited);
    const speeds = alive.map((p) => p.last?.speed).filter((s): s is number => s != null);
    const etas = alive.map((p) => p.last?.eta).filter((s): s is number => s != null);
    return {
      pct,
      phase: this.downloading ? 'download' : 'convert',
      speedBps: speeds.length ? Math.round(speeds.reduce((a, s) => a + s, 0)) : null,
      etaSec: etas.length ? Math.round(Math.max(...etas)) : null,
    };
  }
}
