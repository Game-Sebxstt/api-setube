import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CookieLogger {
  warn(obj: object, msg: string): void;
}

export class CookiesError extends Error {
  readonly key: 'YTDLP_COOKIES_FILE' | 'YOUTUBE_COOKIES_JSON';
  readonly path: string | undefined;
  readonly code: string | undefined;
  constructor(key: CookiesError['key'], info: { path?: string; code?: string } = {}) {
    super(`Cookies inválidas: ${key}`);
    this.name = 'CookiesError';
    this.key = key;
    this.path = info.path;
    this.code = info.code;
  }
}

let netscape: string | null = null;

interface ExtensionCookie {
  domain?: unknown;
  hostOnly?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  expirationDate?: unknown;
  session?: unknown;
  name?: unknown;
  value?: unknown;
}

const clean = (s: string) => s.replace(/[\t\r\n]/g, '');

export function jsonToNetscape(json: string): string {
  const parsed: unknown = JSON.parse(json);
  const list = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown })?.cookies;
  if (!Array.isArray(list)) throw new Error('formato de cookies no soportado');
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list as ExtensionCookie[]) {
    if (typeof c?.name !== 'string' || typeof c.domain !== 'string') continue;
    const domain = clean(c.domain);
    const includeSub = c.hostOnly === true ? 'FALSE' : domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = typeof c.expirationDate === 'number' && c.session !== true ? Math.floor(c.expirationDate) : 0;
    lines.push(
      [
        (c.httpOnly === true ? '#HttpOnly_' : '') + domain,
        includeSub,
        typeof c.path === 'string' ? clean(c.path) : '/',
        c.secure === true ? 'TRUE' : 'FALSE',
        String(exp),
        clean(c.name),
        typeof c.value === 'string' ? clean(c.value) : '',
      ].join('\t'),
    );
  }
  return lines.join('\n') + '\n';
}

export const cookies = {
  get configured(): boolean {
    return netscape !== null;
  },

  load(opts: {
    file: string | null;
    json: string | null;
    isProd: boolean;
    env?: NodeJS.ProcessEnv;
    log?: CookieLogger | undefined;
  }): void {
    netscape = null;
    const hadJson = opts.json !== null && opts.json !== '';
    if (opts.env) delete opts.env.YOUTUBE_COOKIES_JSON;
    delete process.env.YOUTUBE_COOKIES_JSON;

    if (opts.file) {
      try {
        fs.accessSync(opts.file, fs.constants.R_OK);
        netscape = fs.readFileSync(opts.file, 'utf8');
      } catch (e) {
        throw new CookiesError('YTDLP_COOKIES_FILE', { path: opts.file, code: (e as NodeJS.ErrnoException).code ?? 'EREAD' });
      }
      return;
    }
    if (hadJson) {
      try {
        netscape = jsonToNetscape(opts.json as string);
      } catch {
        throw new CookiesError('YOUTUBE_COOKIES_JSON', { code: 'EPARSE' });
      }
      if (opts.isProd) opts.log?.warn({ hint: 'usa YTDLP_COOKIES_FILE' }, 'cookies_via_env');
    }
  },

  async materialize(workDir: string): Promise<string> {
    if (netscape === null) throw new Error('cookies no configuradas');
    const p = path.join(workDir, `ck-${randomUUID()}.txt`);
    await writeFile(p, netscape, { mode: 0o600, flag: 'wx' });
    return p;
  },

  reset(): void {
    netscape = null;
  },
};
