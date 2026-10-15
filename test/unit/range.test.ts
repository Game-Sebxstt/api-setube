import { describe, expect, it } from 'vitest';
import { parseRange } from '../../src/lib/http/range.js';

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', { start: 0, end: 99, suffix: false }],
    ['bytes=0-0', { start: 0, end: 0, suffix: false }],
    ['bytes=500-', { start: 500, end: 999, suffix: false }],
    ['bytes=900-5000', { start: 900, end: 999, suffix: false }],
    ['bytes=-1', { start: 999, end: 999, suffix: true }],
    ['bytes=-100', { start: 900, end: 999, suffix: true }],
    ['bytes=-5000', { start: 0, end: 999, suffix: true }],
    [' bytes = 10 - 20 ', { start: 10, end: 20, suffix: false }],
  ])('%s', (h, want) => {
    expect(parseRange(h, 1000)).toEqual(want);
  });

  it.each([
    [undefined],
    [''],
    ['items=0-1'],
    ['bytes=0-1,5-6'],
    ['bytes=20-10'],
    ['bytes=-'],
    ['bytes=abc'],
    ['bytes=12345678901234567-'],
  ])('%s → null (200 completo)', (h) => {
    expect(parseRange(h, 1000)).toBeNull();
  });

  it.each([['bytes=1000-'], ['bytes=1000-2000'], ['bytes=-0']])('%s → invalid (416)', (h) => {
    expect(parseRange(h, 1000)).toBe('invalid');
  });
});
