import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CookieDbError, cookieDbSignature, readCookieDb, resolveCookieDb, type CookieDbKind } from './cookies-db.js';

export interface CookieLogger {
  warn(obj: object, msg: string): void;
}

export class CookiesError extends Error {
  readonly key: 'YTDLP_COOKIES_FILE' | 'YOUTUBE_COOKIES_JSON' | 'YTDLP_COOKIES_DB';
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

export type CookieSource = 'none' | 'file' | 'json' | 'db';

interface DbState {
  path: string;
  kind: CookieDbKind;
  signature: string;
  count: number;
  loggedIn: boolean;
}

let source: CookieSource = 'none';
let db: DbState | null = null;
let log: CookieLogger | undefined;
let lastRefreshWarn = 0;
const REFRESH_WARN_EVERY_MS = 60_000;

// Relee la base SQLite si cambió desde la última lectura. Si falla (p. ej. el navegador la está
// reescribiendo), se sigue usando la última copia buena y se avisa como mucho una vez por minuto.
function refreshDb(): void {
  if (!db) return;
  const sig = cookieDbSignature(db.path);
  if (sig === db.signature) return;
  try {
    const snap = readCookieDb(db.path);
    const wasLoggedIn = db.loggedIn;
    netscape = snap.netscape;
    db = { ...db, kind: snap.kind, signature: sig, count: snap.count, loggedIn: snap.loggedIn };
    if (wasLoggedIn && !snap.loggedIn) log?.warn({ kind: snap.kind, count: snap.count }, 'cookies_db_logged_out');
  } catch (e) {
    const now = Date.now();
    if (now - lastRefreshWarn >= REFRESH_WARN_EVERY_MS) {
      lastRefreshWarn = now;
      log?.warn({ code: e instanceof CookieDbError ? e.code : 'EREAD' }, 'cookies_db_refresh_failed');
    }
  }
}

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

  get source(): CookieSource {
    return source;
  },

  /** Estado sin secretos, para logs de arranque. */
  status(): { source: CookieSource; kind?: CookieDbKind; count?: number; loggedIn?: boolean } {
    if (source !== 'db' || !db) return { source };
    return { source, kind: db.kind, count: db.count, loggedIn: db.loggedIn };
  },

  setLogger(l: CookieLogger | undefined): void {
    log = l;
  },

  load(opts: {
    file: string | null;
    json: string | null;
    db?: string | null;
    isProd: boolean;
    env?: NodeJS.ProcessEnv;
    log?: CookieLogger | undefined;
  }): void {
    netscape = null;
    source = 'none';
    db = null;
    log = opts.log;
    const hadJson = opts.json !== null && opts.json !== '';
    if (opts.env) delete opts.env.YOUTUBE_COOKIES_JSON;
    delete process.env.YOUTUBE_COOKIES_JSON;

    if (opts.db) {
      if (opts.file || hadJson) throw new CookiesError('YTDLP_COOKIES_DB', { path: opts.db, code: 'ECONFLICT' });
      let dbPath = opts.db;
      try {
        dbPath = resolveCookieDb(opts.db);
        const signature = cookieDbSignature(dbPath);
        const snap = readCookieDb(dbPath);
        netscape = snap.netscape;
        source = 'db';
        db = { path: dbPath, kind: snap.kind, signature, count: snap.count, loggedIn: snap.loggedIn };
        if (snap.undecryptable > 0) {
          opts.log?.warn({ kind: snap.kind, undecryptable: snap.undecryptable, hint: 'inicia Chromium con --password-store=basic' }, 'cookies_db_undecryptable');
        }
        if (!snap.loggedIn) opts.log?.warn({ kind: snap.kind, count: snap.count, hint: 'inicia sesión en YouTube con ese perfil' }, 'cookies_db_not_logged_in');
      } catch (e) {
        throw new CookiesError('YTDLP_COOKIES_DB', { path: dbPath, code: e instanceof CookieDbError ? e.code : 'EREAD' });
      }
      return;
    }

    if (opts.file) {
      try {
        fs.accessSync(opts.file, fs.constants.R_OK);
        netscape = fs.readFileSync(opts.file, 'utf8');
        source = 'file';
      } catch (e) {
        throw new CookiesError('YTDLP_COOKIES_FILE', { path: opts.file, code: (e as NodeJS.ErrnoException).code ?? 'EREAD' });
      }
      return;
    }
    if (hadJson) {
      try {
        netscape = jsonToNetscape(opts.json as string);
        source = 'json';
      } catch {
        throw new CookiesError('YOUTUBE_COOKIES_JSON', { code: 'EPARSE' });
      }
      if (opts.isProd) opts.log?.warn({ hint: 'usa YTDLP_COOKIES_FILE' }, 'cookies_via_env');
    }
  },

  async materialize(workDir: string): Promise<string> {
    if (source === 'db') refreshDb();
    if (netscape === null) throw new Error('cookies no configuradas');
    const p = path.join(workDir, `ck-${randomUUID()}.txt`);
    await writeFile(p, netscape, { mode: 0o600, flag: 'wx' });
    return p;
  },

  reset(): void {
    netscape = null;
    source = 'none';
    db = null;
    log = undefined;
    lastRefreshWarn = 0;
  },
};
