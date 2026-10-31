// MP4 fragmentado sintético (ftyp + moov + sidx v0 + fragmentos) para probar el índice sin binarios

export function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}

export interface FakeMp4 {
  data: Buffer;
  initEnd: number;
  sidxEnd: number;
  /** [offset, size] de cada fragmento */
  fragments: [number, number][];
}

/**
 * Archivo con `fragments` fragmentos de `fragmentSize` bytes y `duration` unidades cada uno (timescale 15360).
 * `moovBytes` agranda el moov para forzar lecturas de más de 64 KiB; `trailer` añade bytes al final (mfra).
 */
export function fakeMp4(o: { fragments?: number; fragmentSize?: number; duration?: number; moovBytes?: number; trailer?: number } = {}): FakeMp4 {
  const n = o.fragments ?? 5;
  const fragmentSize = o.fragmentSize ?? 4000;
  const duration = o.duration ?? 30720;
  const ftyp = box('ftyp', Buffer.from('iso6\0\0\0\0iso6mp41', 'latin1'));
  const moov = box('moov', Buffer.alloc(o.moovBytes ?? 700, 0xaa));
  const head = Buffer.alloc(4 + 4 + 4 + 8 + 4);
  head.writeUInt32BE(0, 0); // versión 0, flags 0
  head.writeUInt32BE(1, 4); // reference_ID
  head.writeUInt32BE(15360, 8); // timescale
  head.writeUInt32BE(0, 12); // earliest_presentation_time
  head.writeUInt32BE(0, 16); // first_offset
  head.writeUInt16BE(0, 20);
  head.writeUInt16BE(n, 22);
  const refs = Buffer.alloc(n * 12);
  for (let i = 0; i < n; i++) {
    refs.writeUInt32BE(fragmentSize, i * 12);
    refs.writeUInt32BE(duration, i * 12 + 4);
    refs.writeUInt32BE(0x90000000, i * 12 + 8);
  }
  const sidx = box('sidx', Buffer.concat([head, refs]));
  const initEnd = ftyp.length + moov.length;
  const sidxEnd = initEnd + sidx.length;
  const frags: Buffer[] = [];
  const fragments: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const b = Buffer.alloc(fragmentSize, i & 255);
    b.writeUInt32BE(fragmentSize, 0);
    b.write('moof', 4, 'latin1');
    frags.push(b);
    fragments.push([sidxEnd + i * fragmentSize, fragmentSize]);
  }
  const data = Buffer.concat([ftyp, moov, sidx, ...frags, Buffer.alloc(o.trailer ?? 0)]);
  return { data, initEnd, sidxEnd, fragments };
}
