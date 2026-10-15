import { AppError } from './errors.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(o: {
  secret: string | null;
  token: string | undefined;
  remoteIp: string;
  fetch: typeof fetch;
  log?: { warn(obj: object, msg: string): void };
  timeoutMs?: number;
}): Promise<void> {
  if (!o.secret) return;
  if (!o.token) throw new AppError('CAPTCHA_REQUIRED');
  let res: Response;
  try {
    res = await o.fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: o.secret, response: o.token, remoteip: o.remoteIp }).toString(),
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
  } catch (e) {
    o.log?.warn({ err: { message: (e as Error).message } }, 'turnstile_unavailable');
    throw new AppError('CAPTCHA_UNAVAILABLE');
  }
  if (!res.ok) {
    o.log?.warn({ status: res.status }, 'turnstile_unavailable');
    throw new AppError('CAPTCHA_UNAVAILABLE');
  }
  let body: { success?: unknown };
  try {
    body = (await res.json()) as { success?: unknown };
  } catch {
    throw new AppError('CAPTCHA_UNAVAILABLE');
  }
  if (body.success !== true) throw new AppError('CAPTCHA_FAILED');
}
