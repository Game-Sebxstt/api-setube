import type { ErrorCode } from '../errors.js';

export type YtdlpErrorCode = Extract<
  ErrorCode,
  | 'UPSTREAM_BLOCKED'
  | 'PRIVATE_VIDEO'
  | 'AGE_RESTRICTED'
  | 'LIVE_NOT_SUPPORTED'
  | 'VIDEO_UNAVAILABLE'
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_ERROR'
>;

const RULES: [RegExp, YtdlpErrorCode][] = [
  [/Sign in to confirm you.?re not a bot|confirm you are not a robot/i, 'UPSTREAM_BLOCKED'],
  [/Private video/i, 'PRIVATE_VIDEO'],
  [/confirm your age|age-restricted|inappropriate for some users/i, 'AGE_RESTRICTED'],
  [/live event will begin|is live|Premieres in|This live stream recording is not available/i, 'LIVE_NOT_SUPPORTED'],
  // «not (made this video )?available»: cubre también «The uploader has not made this video available in your country»
  [/Video unavailable|has been removed|account .* terminated|not (made this video )?available in your country/i, 'VIDEO_UNAVAILABLE'],
  [/HTTP Error 403|HTTP Error 410|The info failed to download/i, 'UPSTREAM_FORBIDDEN'],
  [/timed out|Connection reset|HTTP Error 5\d\d|Unable to download/i, 'UPSTREAM_ERROR'],
];

export function classifyYtdlpError(stderr: string | readonly string[], exitCode: number | null = 1): YtdlpErrorCode | null {
  const text = typeof stderr === 'string' ? stderr : stderr.join('\n');
  for (const [re, code] of RULES) if (re.test(text)) return code;
  return exitCode === 0 ? null : 'UPSTREAM_ERROR';
}

export const isTransient = (code: ErrorCode) => code === 'UPSTREAM_ERROR';
