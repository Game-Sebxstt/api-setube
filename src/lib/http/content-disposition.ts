const MAX_BASE_CODEPOINTS = 150;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function sanitizeFilename(title: string | null | undefined, fallbackId: string): string {
  let s = (title ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(s);
  if (cps.length > MAX_BASE_CODEPOINTS) s = cps.slice(0, MAX_BASE_CODEPOINTS).join('').trim();
  // Windows no admite nombres que terminan en punto o espacio
  s = s.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  if (s === '') return `setube-${fallbackId}`;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

export function asciiFallback(name: string): string {
  const out = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\%]/g, '_')
    .replace(/_+/g, '_')
    .trim();
  return out === '' ? 'setube' : out;
}

function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

export function attachmentFor(title: string | null | undefined, ext: string, fallbackId: string): { filename: string; header: string } {
  const filename = `${sanitizeFilename(title, fallbackId)}.${ext}`;
  return { filename, header: contentDisposition(filename) };
}
