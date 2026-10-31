import { describe, expect, it } from 'vitest';
import { MAX_TRAILER, Mp4IndexError, parseMp4Index, type Mp4Index } from '../../src/lib/preview/mp4-index.js';

// Cajas sintéticas: lo justo para el parser (cabecera de caja, FullBox y referencias del sidx)

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}

function largeBox(type: string, payload: Buffer): Buffer {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1, 0);
  h.write(type, 4, 'latin1');
  h.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([h, payload]);
}

const ftyp = () => box('ftyp', Buffer.from('dash\0\0\0\0iso6mp41', 'latin1'));
const moov = (n = 92) => box('moov', Buffer.alloc(n, 0xaa));

interface Ref {
  size: number;
  duration: number;
  type?: 0 | 1;
  /** Tercera palabra de la referencia (starts_with_SAP, SAP_type, SAP_delta_time). */
  sap?: number;
}

interface SidxOpts {
  version?: number;
  timescale?: number;
  ept?: bigint;
  firstOffset?: bigint;
  refs: Ref[];
  declaredCount?: number;
}

function sidx({ version = 0, timescale = 90000, ept = 0n, firstOffset = 0n, refs, declaredCount }: SidxOpts): Buffer {
  const head = Buffer.alloc(version === 0 ? 4 + 4 + 4 + 8 + 4 : 4 + 4 + 4 + 16 + 4);
  let p = 0;
  head.writeUInt32BE(version << 24, p); // version + flags
  p += 4;
  head.writeUInt32BE(1, p); // reference_ID
  p += 4;
  head.writeUInt32BE(timescale, p);
  p += 4;
  if (version === 0) {
    head.writeUInt32BE(Number(ept), p);
    head.writeUInt32BE(Number(firstOffset), p + 4);
    p += 8;
  } else {
    head.writeBigUInt64BE(ept, p);
    head.writeBigUInt64BE(firstOffset, p + 8);
    p += 16;
  }
  head.writeUInt16BE(0, p);
  head.writeUInt16BE(declaredCount ?? refs.length, p + 2);
  const body = Buffer.alloc(refs.length * 12);
  refs.forEach((r, i) => {
    body.writeUInt32BE((((r.type ?? 0) << 31) | r.size) >>> 0, i * 12);
    body.writeUInt32BE(r.duration, i * 12 + 4);
    body.writeUInt32BE(r.sap ?? 0x90000000, i * 12 + 8); // por defecto starts_with_SAP=1, SAP_type=1
  });
  return box('sidx', Buffer.concat([head, body]));
}

const REFS: Ref[] = [
  { size: 1000, duration: 180000 },
  { size: 2500, duration: 180000 },
  { size: 700, duration: 45000 },
];

function ok(buf: Uint8Array, totalSize?: number): Mp4Index {
  const r = parseMp4Index(buf, totalSize === undefined ? {} : { totalSize });
  if (r.kind !== 'ok') throw new Error(`esperaba ok y llegó need-more ${r.needBytes}`);
  return r.index;
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Mp4IndexError);
    return (err as Mp4IndexError).reason;
  }
  throw new Error('no lanzó');
}

describe('parseMp4Index: sidx versión 0 y 1', () => {
  it('v0: init, fin del sidx, timescale y fragmentos exactos', () => {
    const f = ftyp();
    const m = moov();
    const s = sidx({ refs: REFS, ept: 3000n });
    const head = Buffer.concat([f, m, s]);
    const idx = ok(head);
    const sidxEnd = f.length + m.length + s.length;
    expect(idx).toEqual({
      initEnd: f.length + m.length,
      sidxEnd,
      timescale: 90000,
      earliestPresentationTime: 3000,
      segments: [
        { offset: sidxEnd, size: 1000, start: 3000, duration: 180000, startsWithSap: true, sapType: 1 },
        { offset: sidxEnd + 1000, size: 2500, start: 183000, duration: 180000, startsWithSap: true, sapType: 1 },
        { offset: sidxEnd + 3500, size: 700, start: 363000, duration: 45000, startsWithSap: true, sapType: 1 },
      ],
    });
  });

  it('v1: earliest_presentation_time y first_offset de 64 bits', () => {
    const f = ftyp();
    const m = moov(40);
    const s = sidx({ version: 1, timescale: 44100, ept: 5_000_000_000n, firstOffset: 24n, refs: REFS.slice(0, 2) });
    const idx = ok(Buffer.concat([f, m, s]));
    const sidxEnd = f.length + m.length + s.length;
    expect(idx.timescale).toBe(44100);
    expect(idx.earliestPresentationTime).toBe(5_000_000_000);
    expect(idx.sidxEnd).toBe(sidxEnd);
    expect(idx.segments).toEqual([
      { offset: sidxEnd + 24, size: 1000, start: 5_000_000_000, duration: 180000, startsWithSap: true, sapType: 1 },
      { offset: sidxEnd + 1024, size: 2500, start: 5_000_180_000, duration: 180000, startsWithSap: true, sapType: 1 },
    ]);
  });

  it('expone starts_with_SAP y SAP_type de cada referencia', () => {
    const refs: Ref[] = [
      { size: 100, duration: 10, sap: 0xa0000000 }, // SAP tipo 2
      { size: 100, duration: 10, sap: 0x00000000 }, // sin SAP
      { size: 100, duration: 10, sap: 0x30000005 }, // tipo 3 sin starts_with_SAP y con delta
    ];
    const idx = ok(Buffer.concat([ftyp(), moov(), sidx({ refs })]));
    expect(idx.segments.map((s) => [s.startsWithSap, s.sapType])).toEqual([
      [true, 2],
      [false, 0],
      [false, 3],
    ]);
  });

  it('acepta moov con tamaño de 64 bits, cajas que se saltan y el sidx antes del moov', () => {
    const f = ftyp();
    const free = box('free', Buffer.alloc(10));
    const s = sidx({ refs: REFS, firstOffset: 120n });
    const m = largeBox('moov', Buffer.alloc(104));
    const head = Buffer.concat([f, free, s, m]);
    const idx = ok(head);
    const sidxEnd = f.length + free.length + s.length;
    expect(idx.initEnd).toBe(head.length);
    expect(idx.sidxEnd).toBe(sidxEnd);
    expect(idx.segments[0]!.offset).toBe(sidxEnd + 120);
  });

  it('funciona con una vista de Buffer que no empieza en el offset 0 de su ArrayBuffer', () => {
    const head = Buffer.concat([ftyp(), moov(), sidx({ refs: REFS })]);
    const padded = Buffer.concat([Buffer.alloc(7, 0xff), head]).subarray(7);
    expect(padded.byteOffset).toBeGreaterThan(0);
    expect(ok(padded)).toEqual(ok(head));
  });

  it('con totalSize: los fragmentos cubren el archivo, con margen para un mfra final', () => {
    const head = Buffer.concat([ftyp(), moov(), sidx({ refs: REFS })]);
    expect(ok(head, head.length + 4200).segments).toHaveLength(3);
    expect(ok(head, head.length + 4200 + 105).segments).toHaveLength(3);
    expect(ok(head, head.length + 4200 + MAX_TRAILER).segments).toHaveLength(3);
    expect(reason(() => parseMp4Index(head, { totalSize: head.length + 4199 }))).toBe('size-mismatch');
    expect(reason(() => parseMp4Index(head, { totalSize: head.length + 4200 + MAX_TRAILER + 1 }))).toBe(
      'size-mismatch',
    );
  });

  it('el segundo sidx (daisy chain) no se lee', () => {
    const head = Buffer.concat([ftyp(), moov(), sidx({ refs: REFS }), box('sidx', Buffer.alloc(3))]);
    expect(ok(head).segments).toHaveLength(3);
  });
});

describe('parseMp4Index: need-more', () => {
  const f = ftyp();
  const m = moov(300);
  const s = sidx({ refs: REFS });
  const full = Buffer.concat([f, m, s, Buffer.alloc(64)]);

  it('pide la cabecera de la primera caja', () => {
    expect(parseMp4Index(full.subarray(0, 0))).toEqual({ kind: 'need-more', needBytes: 16 });
    expect(parseMp4Index(full.subarray(0, 5))).toEqual({ kind: 'need-more', needBytes: 16 });
  });

  it('salta el moov sin leerlo y pide la cabecera de la caja siguiente', () => {
    const at = f.length + m.length;
    expect(parseMp4Index(full.subarray(0, f.length + 20))).toEqual({ kind: 'need-more', needBytes: at + 16 });
    expect(parseMp4Index(full.subarray(0, at + 3))).toEqual({ kind: 'need-more', needBytes: at + 16 });
  });

  it('cabecera largesize a medias: pide los 16 bytes de la cabecera', () => {
    const half = Buffer.alloc(12);
    half.writeUInt32BE(1, 0);
    half.write('moov', 4, 'latin1');
    expect(parseMp4Index(Buffer.concat([f, half]))).toEqual({ kind: 'need-more', needBytes: f.length + 16 });
    expect(parseMp4Index(Buffer.concat([f, half.subarray(0, 8)]))).toEqual({ kind: 'need-more', needBytes: f.length + 16 });
  });

  it('pide el sidx completo y con esos bytes ya resuelve', () => {
    const sidxEnd = f.length + m.length + s.length;
    expect(parseMp4Index(full.subarray(0, sidxEnd - 1))).toEqual({ kind: 'need-more', needBytes: sidxEnd });
    expect(ok(full.subarray(0, sidxEnd)).segments).toHaveLength(3);
    expect(ok(full).segments).toHaveLength(3);
  });

  it('con totalSize no pide más bytes de los que tiene el archivo', () => {
    const head = Buffer.concat([f, m]);
    expect(reason(() => parseMp4Index(head, { totalSize: head.length }))).toBe('no-sidx');
    expect(parseMp4Index(head, { totalSize: head.length + 10 })).toEqual({ kind: 'need-more', needBytes: head.length + 10 });
    expect(reason(() => parseMp4Index(Buffer.concat([head, Buffer.alloc(4)]), { totalSize: head.length + 4 }))).toBe(
      'bad-box',
    );
  });
});

describe('parseMp4Index: entradas rechazadas', () => {
  const f = ftyp();
  const m = moov();

  it.each<[string, () => Buffer, string]>([
    ['la primera caja no es ftyp', () => Buffer.concat([m, f]), 'not-mp4'],
    ['WebM (EBML)', () => Buffer.from('1a45dfa3a3428681010000000000000000', 'hex'), 'bad-box'],
    ['tipo de caja ilegible', () => Buffer.concat([f, Buffer.from([0, 0, 0, 16, 0, 1, 2, 3]), Buffer.alloc(8)]), 'bad-box'],
    ['caja con tamaño < 8', () => Buffer.concat([f, Buffer.from([0, 0, 0, 4]), Buffer.from('moov', 'latin1')]), 'bad-box'],
    ['caja con tamaño 0 antes del índice', () => Buffer.concat([f, Buffer.from('\0\0\0\0moov', 'latin1')]), 'bad-box'],
    ['largesize < 16', () => {
      const b = Buffer.alloc(16);
      b.writeUInt32BE(1, 0);
      b.write('moov', 4, 'latin1');
      b.writeBigUInt64BE(12n, 8);
      return Buffer.concat([f, b]);
    }, 'bad-box'],
    ['largesize fuera de Number.MAX_SAFE_INTEGER', () => {
      const b = Buffer.alloc(16);
      b.writeUInt32BE(1, 0);
      b.write('moov', 4, 'latin1');
      b.writeBigUInt64BE(2n ** 60n, 8);
      return Buffer.concat([f, b]);
    }, 'bad-box'],
    ['moov repetido', () => Buffer.concat([f, m, m, sidx({ refs: REFS })]), 'bad-box'],
    ['ftyp repetido', () => Buffer.concat([f, f, m, sidx({ refs: REFS })]), 'bad-box'],
    ['moof antes del sidx', () => Buffer.concat([f, m, box('moof', Buffer.alloc(8))]), 'no-sidx'],
    ['mdat antes del moov', () => Buffer.concat([f, box('mdat', Buffer.alloc(8))]), 'no-moov'],
    ['referencia jerárquica', () => Buffer.concat([f, m, sidx({ refs: [{ size: 500, duration: 1, type: 1 }] })]), 'hierarchical-sidx'],
    ['sidx versión 2', () => Buffer.concat([f, m, sidx({ version: 2, refs: REFS })]), 'bad-sidx'],
    ['timescale 0', () => Buffer.concat([f, m, sidx({ timescale: 0, refs: REFS })]), 'bad-sidx'],
    ['sidx sin referencias', () => Buffer.concat([f, m, sidx({ refs: [] })]), 'bad-sidx'],
    ['más referencias declaradas de las que caben', () => Buffer.concat([f, m, sidx({ refs: REFS, declaredCount: 4 })]), 'bad-sidx'],
    ['sidx más corto que su parte fija', () => Buffer.concat([f, m, box('sidx', Buffer.alloc(10))]), 'bad-sidx'],
    ['referencia de tamaño 0', () => Buffer.concat([f, m, sidx({ refs: [{ size: 0, duration: 90000 }] })]), 'bad-sidx'],
    ['referencia de duración 0', () => Buffer.concat([f, m, sidx({ refs: [{ size: 10, duration: 0 }] })]), 'bad-sidx'],
    ['first_offset v1 fuera de Number.MAX_SAFE_INTEGER', () => Buffer.concat([f, m, sidx({ version: 1, firstOffset: 2n ** 60n, refs: REFS })]), 'bad-sidx'],
    ['earliest_presentation_time v1 fuera de Number.MAX_SAFE_INTEGER', () => Buffer.concat([f, m, sidx({ version: 1, ept: 2n ** 60n, refs: REFS })]), 'bad-sidx'],
    ['tiempos acumulados fuera de rango', () => Buffer.concat([f, m, sidx({ version: 1, ept: BigInt(Number.MAX_SAFE_INTEGER) - 10n, refs: REFS })]), 'bad-sidx'],
    ['fragmentos dentro del segmento de inicialización', () => {
      const s = sidx({ refs: REFS });
      return Buffer.concat([f, s, moov(200)]);
    }, 'bad-sidx'],
  ])('%s', (_name, make, want) => {
    expect(reason(() => parseMp4Index(make()))).toBe(want);
  });

  it('caja que se sale del archivo con totalSize', () => {
    const head = Buffer.concat([f, m]);
    expect(reason(() => parseMp4Index(head, { totalSize: head.length - 1 }))).toBe('bad-box');
  });
});
