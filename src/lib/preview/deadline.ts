import { AppError } from '../errors.js';

export interface Deadline {
  signal: AbortSignal;
  timedOut(): boolean;
  clear(): void;
}

export function createDeadline(ms: number): Deadline {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  t.unref?.();
  return {
    signal: ac.signal,
    timedOut: () => ac.signal.aborted,
    clear: () => clearTimeout(t),
  };
}

// Carrera contra el plazo y la conexión; la operación perdedora sigue en segundo plano sin rechazos sueltos
export function withDeadline<T>(p: Promise<T>, deadline: Deadline, sessionSignal: AbortSignal): Promise<T> {
  p.catch(() => undefined);
  if (sessionSignal.aborted) return Promise.reject(new AppError('DOWNLOAD_INTERRUPTED'));
  if (deadline.timedOut()) return Promise.reject(new AppError('UPSTREAM_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const onDeadline = () => done(() => reject(new AppError('UPSTREAM_TIMEOUT')));
    const onSession = () => done(() => reject(new AppError('DOWNLOAD_INTERRUPTED')));
    const done = (fn: () => void) => {
      deadline.signal.removeEventListener('abort', onDeadline);
      sessionSignal.removeEventListener('abort', onSession);
      fn();
    };
    deadline.signal.addEventListener('abort', onDeadline, { once: true });
    sessionSignal.addEventListener('abort', onSession, { once: true });
    p.then(
      (v) => done(() => resolve(v)),
      (e: unknown) => done(() => reject(e)),
    );
  });
}
