export interface ByteRange {
  start: number;
  end: number;
  suffix: boolean;
}

const SPEC = /^\s*bytes\s*=\s*(\d{0,16})\s*-\s*(\d{0,16})\s*$/i;

// RFC 9110 §14.2: una cabecera mal formada se ignora (200 completo); solo un rango fuera del recurso es 416
export function parseRange(header: string | undefined, total: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = SPEC.exec(header);
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    return { start: Math.max(0, total - n), end: total - 1, suffix: true };
  }
  const start = Number(a);
  if (b !== '' && start > Number(b)) return null;
  if (start >= total) return 'invalid';
  const end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
  return { start, end, suffix: false };
}
