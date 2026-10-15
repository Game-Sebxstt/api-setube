import { PassThrough, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { ERROR_CATALOG } from '../errors.js';
import { sanitizeFilename } from '../http/content-disposition.js';
import { runItem, type ItemResult, type StreamCtx } from '../media/pipeline.js';
import { watchUrl } from '../youtube/url.js';
import type { ItemState } from './store.js';

export interface ArchiveOpts {
  ctx: StreamCtx;
  abort: (reason: string) => void;
  queue: ItemState[];
  excluded: ItemState[];
  dest: Writable;
  parallel: number;
  forceZip64: boolean;
  ext: string;
  guardTickMs?: number;
}

export interface ArchiveResult {
  entries: string[];
  results: Record<string, ItemResult>;
  aborted: boolean;
}

interface Entry {
  itemId: string;
  pt: PassThrough;
  name?: string;
  headAt?: number;
  appended: boolean;
}

const BOM = '\ufeff';

export function archiveName(format: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `setube-${format}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

export function uniqueName(used: Set<string>, base: string, ext: string): string {
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
  used.add(name.toLowerCase());
  return name;
}

export async function runArchive(o: ArchiveOpts): Promise<ArchiveResult> {
  const { ctx, dest } = o;
  const { config, log } = ctx.deps;
  // archiver bufferiza 1 MiB por defecto; con 64 KiB la backpressure del cliente llega antes a las entradas
  // y el uso de memoria se mantiene bajo.
  const archive = new ZipArchive({ store: true, forceZip64: o.forceZip64, highWaterMark: 64 * 1024 });
  const entries: string[] = [];
  const results: Record<string, ItemResult> = {};
  const used = new Set<string>();
  const head: Entry[] = [];

  archive.on('warning', (e) => log.warn({ err: { message: e.message, code: e.code } }, 'zip_warning'));
  archive.on('error', (e) => {
    log.error({ err: { message: e.message, code: e.code } }, 'zip_error');
    o.abort('client_closed');
  });
  archive.on('entry', (e) => {
    entries.push(e.name);
    const i = head.findIndex((x) => x.name === e.name);
    if (i >= 0) head.splice(i, 1);
    const next = head[0];
    if (next && next.headAt === undefined) next.headAt = Date.now();
  });

  dest.on('error', () => undefined);
  dest.on('close', () => {
    if (!dest.writableFinished) o.abort('client_closed');
  });
  const piping = pipeline(archive, dest).catch(() => undefined);

  const onAbort = () => {
    archive.abort();
    dest.destroy();
  };
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });

  const guard = setInterval(() => {
    const h = head[0];
    if (h?.headAt !== undefined && Date.now() - h.headAt > 2 * config.conversionWallTimeoutMs) {
      log.warn({ jobId: ctx.jobId, itemId: h.itemId }, 'zip_client_too_slow');
      o.abort('CONVERSION_TIMEOUT');
    }
  }, o.guardTickMs ?? 1000);
  guard.unref?.();

  const runOne = async (it: ItemState) => {
    const entry: Entry = {
      itemId: it.itemId,
      pt: new PassThrough({ writableHighWaterMark: config.zipItemBufferBytes, readableHighWaterMark: 64 * 1024 }),
      appended: false,
    };
    results[it.itemId] = await runItem(ctx, it.itemId, {
      mode: 'archive',
      out: entry.pt,
      headAt: () => entry.headAt,
      onFirstByte: () => {
        if (ctx.signal.aborted) return;
        const title = ctx.reporter.get(it.itemId).title;
        entry.name = uniqueName(used, sanitizeFilename(title, it.videoId), o.ext);
        entry.appended = true;
        head.push(entry);
        if (head.length === 1) entry.headAt = Date.now();
        archive.append(entry.pt, { name: entry.name, store: true });
      },
    });
  };

  let next = 0;
  const worker = async () => {
    while (next < o.queue.length && !ctx.signal.aborted) {
      const it = o.queue[next++] as ItemState;
      await runOne(it);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel, o.queue.length)) }, worker));
  clearInterval(guard);
  ctx.signal.removeEventListener('abort', onAbort);

  if (ctx.signal.aborted) {
    onAbort();
    await piping;
    return { entries, results, aborted: true };
  }

  const lines: string[] = [];
  for (const it of o.excluded) {
    lines.push(`${it.title ?? it.videoId} — ${watchUrl(it.videoId)} — ${it.error?.message ?? ERROR_CATALOG.ITEM_INVALID.message}`);
  }
  for (const it of o.queue) {
    const r = results[it.itemId];
    if (!r || r.outcome === 'done') continue;
    const st = ctx.reporter.get(it.itemId);
    const why = r.code ? ERROR_CATALOG[r.code].message : 'Cancelado.';
    lines.push(`${st.title ?? it.videoId} — ${watchUrl(it.videoId)} — ${r.firstByte ? `incompleto: ${why}` : why}`);
  }
  if (lines.length) archive.append(BOM + lines.join('\r\n') + '\r\n', { name: 'ERRORES.txt' });
  try {
    await archive.finalize();
  } catch {
    /* abortado */
  }
  await piping;
  return { entries, results, aborted: false };
}
