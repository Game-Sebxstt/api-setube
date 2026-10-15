import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl, playlistUrl, watchUrl } from '../../src/lib/youtube/url.js';

type Case = { input: string; expected: null | { kind: 'video' | 'playlist'; videoId?: string; playlistId?: string } };

const cases = JSON.parse(readFileSync(new URL('../fixtures/url-cases.json', import.meta.url), 'utf8')) as Case[];

describe('parseYouTubeUrl (tabla compartida con el cliente)', () => {
  it('la tabla tiene unas 30 URLs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((c) => [c.input, c] as const))('%s', (_label, c) => {
    const r = parseYouTubeUrl(c.input);
    if (c.expected === null) {
      expect(r).toBeNull();
      return;
    }
    expect(r).not.toBeNull();
    expect(r?.kind).toBe(c.expected.kind);
    expect(r?.videoId).toBe(c.expected.videoId);
    expect(r?.playlistId).toBe(c.expected.playlistId);
    expect(r?.canonicalUrl).toBe(c.expected.videoId ? watchUrl(c.expected.videoId) : playlistUrl(c.expected.playlistId as string));
  });
});
