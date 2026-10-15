import { describe, expect, it } from 'vitest';
import { classifyYtdlpError } from '../../src/lib/youtube/ytdlp-errors.js';

describe('classifyYtdlpError', () => {
  it.each([
    ["ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.", 'UPSTREAM_BLOCKED'],
    ['ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. This helps protect our community.', 'UPSTREAM_BLOCKED'],
    ['ERROR: [youtube] abc: Please confirm you are not a robot', 'UPSTREAM_BLOCKED'],
    ['ERROR: [youtube] abcdefghijk: Private video. Sign in if you\'ve been granted access to this video', 'PRIVATE_VIDEO'],
    ['ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED'],
    ['ERROR: [youtube] abcdefghijk: This video is age-restricted', 'AGE_RESTRICTED'],
    ['ERROR: [youtube] abcdefghijk: This live event will begin in 3 hours.', 'LIVE_NOT_SUPPORTED'],
    ['ERROR: [youtube] abcdefghijk: Premieres in 2 days', 'LIVE_NOT_SUPPORTED'],
    ['ERROR: [youtube] abcdefghijk: This live stream recording is not available.', 'LIVE_NOT_SUPPORTED'],
    ['ERROR: [youtube] abcdefghijk: Video unavailable', 'VIDEO_UNAVAILABLE'],
    ['ERROR: [youtube] abcdefghijk: Video unavailable. This video has been removed by the uploader', 'VIDEO_UNAVAILABLE'],
    ['ERROR: [youtube] abcdefghijk: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.', 'VIDEO_UNAVAILABLE'],
    ['ERROR: [youtube] abcdefghijk: The uploader has not made this video available in your country', 'VIDEO_UNAVAILABLE'],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'UPSTREAM_FORBIDDEN'],
    ['ERROR: unable to download video data: HTTP Error 410: Gone', 'UPSTREAM_FORBIDDEN'],
    ['WARNING: The info failed to download: HTTP Error 403; trying with URL https://…', 'UPSTREAM_FORBIDDEN'],
    ['ERROR: [youtube] abcdefghijk: Unable to download API page: <urlopen error timed out>', 'UPSTREAM_ERROR'],
    ['ERROR: [Errno 104] Connection reset by peer', 'UPSTREAM_ERROR'],
    ['ERROR: [youtube] abcdefghijk: Unable to download webpage: HTTP Error 503: Service Unavailable', 'UPSTREAM_ERROR'],
  ])('%s', (line, code) => {
    expect(classifyYtdlpError(line)).toBe(code);
  });

  it('gana la primera coincidencia del orden', () => {
    expect(classifyYtdlpError(['ERROR: Video unavailable', "Sign in to confirm you're not a bot"])).toBe('UPSTREAM_BLOCKED');
  });

  it('cualquier otro código ≠ 0 → UPSTREAM_ERROR; código 0 sin coincidencias → null', () => {
    expect(classifyYtdlpError('algo raro', 2)).toBe('UPSTREAM_ERROR');
    expect(classifyYtdlpError('', 1)).toBe('UPSTREAM_ERROR');
    expect(classifyYtdlpError('[download] 100%', 0)).toBeNull();
  });
});
