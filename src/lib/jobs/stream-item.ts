import type { ServerResponse } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { attachmentFor } from '../http/content-disposition.js';
import { runItem, type ItemResult, type Prepared, type StreamCtx } from '../media/pipeline.js';

export function binaryHeaders(base: OutgoingHttpHeaders, contentType: string, disposition: string): OutgoingHttpHeaders {
  const h: OutgoingHttpHeaders = { ...base };
  delete h['content-length'];
  delete h['content-type'];
  return {
    ...h,
    'Content-Type': contentType,
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  };
}

export async function serveFile(o: {
  ctx: StreamCtx;
  abort: (reason: string) => void;
  itemId: string;
  prepared: Prepared;
  res: ServerResponse;
  baseHeaders: OutgoingHttpHeaders;
}): Promise<ItemResult> {
  const { ctx, res, prepared, itemId } = o;
  const { videoId, title } = ctx.reporter.get(itemId);
  const cd = attachmentFor(prepared.meta.title ?? title, prepared.selection.ext, videoId).header;
  res.on('error', () => undefined);
  res.on('close', () => {
    if (!res.writableFinished) o.abort('client_closed');
  });
  res.writeHead(200, binaryHeaders(o.baseHeaders, prepared.selection.contentType, cd));
  // Sin flush, Node retiene las cabeceras hasta el primer byte: tienen que salir antes de esperar turno
  res.flushHeaders();
  const result = await runItem(ctx, itemId, { mode: 'file', out: res }, prepared);
  if (result.outcome !== 'done' && !res.destroyed) res.destroy();
  return result;
}
