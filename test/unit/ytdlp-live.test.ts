import { describe, expect, it } from 'vitest';
import { classifyLiveLine } from '../../src/lib/media/proc.js';

describe('classifyLiveLine', () => {
  it('«The info failed to download» → temprano', () => {
    expect(
      classifyLiveLine('WARNING: The info failed to download: HTTP Error 403: Forbidden; trying with URL https://www.youtube.com/watch?v=x'),
    ).toBe('UPSTREAM_FORBIDDEN');
  });

  it('HTTP Error 403 sin Retrying → temprano', () => {
    expect(classifyLiveLine('ERROR: unable to download video data: HTTP Error 403: Forbidden')).toBe('UPSTREAM_FORBIDDEN');
  });

  it('HTTP Error 410 → temprano', () => {
    expect(classifyLiveLine('ERROR: [download] abc: HTTP Error 410: Gone')).toBe('UPSTREAM_FORBIDDEN');
  });

  it('reintento de fragmento con Retrying → nada', () => {
    expect(classifyLiveLine('[download] Got error: HTTP Error 403: Forbidden. Retrying fragment 3 (1/3)...')).toBeNull();
  });

  it('líneas de progreso y otras → nada', () => {
    expect(classifyLiveLine('SETUBE_PROGRESS {"downloaded_bytes":1024,"total_bytes":4096,"status":"downloading"}')).toBeNull();
    expect(classifyLiveLine('[youtube] jNQXAC9IVRw: Downloading webpage')).toBeNull();
    expect(classifyLiveLine('HTTP Error 4030 algo')).toBeNull();
  });
});
