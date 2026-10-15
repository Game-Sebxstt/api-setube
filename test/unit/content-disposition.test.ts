import { describe, expect, it } from 'vitest';
import { asciiFallback, attachmentFor, contentDisposition, sanitizeFilename } from '../../src/lib/http/content-disposition.js';

describe('sanitizeFilename', () => {
  it('conserva Unicode y emojis', () => {
    expect(sanitizeFilename('Canción de ñandú 🎵', 'x')).toBe('Canción de ñandú 🎵');
  });

  it('reemplaza caracteres prohibidos /\\:*?"<>|', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a b c d e f g h i j');
  });

  it('quita caracteres de control y espacios sobrantes', () => {
    expect(sanitizeFilename('  hola\u0000\n\tmundo  ', 'x')).toBe('hola mundo');
  });

  it('nombres reservados de Windows', () => {
    expect(sanitizeFilename('CON', 'x')).toBe('_CON');
    expect(sanitizeFilename('nul', 'x')).toBe('_nul');
    expect(sanitizeFilename('com1', 'x')).toBe('_com1');
    expect(sanitizeFilename('LPT9', 'x')).toBe('_LPT9');
    expect(sanitizeFilename('Console', 'x')).toBe('Console');
  });

  it('sin puntos ni espacios al final', () => {
    expect(sanitizeFilename('final...', 'x')).toBe('final');
  });

  it('recorta 300 caracteres sin romper pares sustitutos', () => {
    const long = '😀'.repeat(300);
    const out = sanitizeFilename(long, 'x');
    expect(Array.from(out).length).toBeLessThanOrEqual(150);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(sanitizeFilename('a'.repeat(300), 'x').length).toBe(150);
  });

  it('vacío → setube-<id>', () => {
    expect(sanitizeFilename('', 'jNQXAC9IVRw')).toBe('setube-jNQXAC9IVRw');
    expect(sanitizeFilename(null, 'jNQXAC9IVRw')).toBe('setube-jNQXAC9IVRw');
    expect(sanitizeFilename(' /\\:*?"<>| ', 'abc')).toBe('setube-abc');
  });
});

describe('contentDisposition', () => {
  it('RFC 6266 + RFC 5987', () => {
    const h = contentDisposition('Canción (en vivo).mp3');
    expect(h).toBe(`attachment; filename="Cancion (en vivo).mp3"; filename*=UTF-8''Canci%C3%B3n%20%28en%20vivo%29.mp3`);
  });

  it('fallback ASCII sin comillas, barras ni %', () => {
    expect(asciiFallback('a"b\\c%d')).toBe('a_b_c_d');
    expect(asciiFallback('日本語.mp3')).toBe('_.mp3');
    expect(asciiFallback('')).toBe('setube');
  });

  it('emojis van en filename* y se sustituyen en filename', () => {
    const { filename, header } = attachmentFor('Hola 🎵', 'm4a', 'x');
    expect(filename).toBe('Hola 🎵.m4a');
    expect(header).toContain('filename="Hola _.m4a"');
    expect(header).toContain(`filename*=UTF-8''Hola%20%F0%9F%8E%B5.m4a`);
  });

  it('la cabecera es solo ASCII', () => {
    const { header } = attachmentFor('Ñ ü 中文 😀', 'mp4', 'x');
    expect(/^[\x20-\x7e]+$/.test(header)).toBe(true);
  });
});
