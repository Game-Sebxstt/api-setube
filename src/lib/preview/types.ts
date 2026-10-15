import type { ErrorCode } from '../errors.js';

export type Outcome = 'ok' | 'error' | 'client_closed' | 'idle' | 'superseded' | 'shutdown';

export type Retry403 = 'none' | 'same' | 'original' | 'refresh' | 'failed';

export interface PreviewStats {
  formatId: string | null;
  refreshed: boolean;
  resumes: number;
  redirects: number;
  bytes: number;
  retry403: Retry403;
  failCode?: ErrorCode;
  urlIpFamily: 4 | 6 | null;
}

export interface PreviewConn {
  id: string;
  abort: AbortController;
  res: { destroy(): void; destroyed: boolean };
  outcome: Outcome | null;
}
