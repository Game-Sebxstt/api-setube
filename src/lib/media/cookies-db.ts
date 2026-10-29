import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Lectura de la base SQLite de cookies de un perfil de navegador (Firefox o Chromium) con sesión
// de YouTube iniciada. Se relee en cada proceso de yt-dlp si cambió, así las cookies que el
// navegador rota siguen valiendo y la sesión dura mucho más que un cookies.txt exportado.

export type CookieDbKind = 'firefox' | 'chromium';

export class CookieDbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CookieDbError';
    this.code = code;
  }
}

export interface CookieDbSnapshot {
  kind: CookieDbKind;
  netscape: string;
  count: number;
  loggedIn: boolean;
  undecryptable: number;
}

// Solo se pasan a yt-dlp las cookies de estos dominios (y sus subdominios)
const DOMAINS = ['youtube.com', 'google.com'];
// Cookies que indican una sesión de cuenta iniciada
const AUTH_NAMES = new Set(['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID']);
// Orden de búsqueda si YTDLP_COOKIES_DB apunta a un directorio de perfil
const CANDIDATES = ['cookies.sqlite', 'Network/Cookies', 'Cookies', 'Default/Network/Cookies', 'Default/Cookies'];
// Segundos entre 1601-01-01 (época de Chromium) y 1970-01-01
const CHROMIUM_EPOCH_OFFSET_SEC = 11644473600;

const clean = (s: string) => s.replace(/[\t\r\n]/g, '');

function errCode(e: unknown, fallback: string): string {
  return (e as NodeJS.ErrnoException)?.code ?? fallback;
}

function allowedHost(host: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase();
  return DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Devuelve la ruta del archivo SQLite: `p` si es archivo, o el primer candidato dentro del directorio. */
export function resolveCookieDb(p: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    throw new CookieDbError(errCode(e, 'ESTAT'), 'no se pudo acceder a la base de cookies');
  }
  if (st.isFile()) return p;
  if (!st.isDirectory()) throw new CookieDbError('EFORMAT', 'la ruta no es un archivo ni un directorio');
  for (const c of CANDIDATES) {
    const full = path.join(p, c);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* siguiente candidato */
    }
  }
  throw new CookieDbError('ENOENT', 'no hay cookies.sqlite (Firefox) ni Cookies (Chromium) en el directorio');
}

/** Huella barata (mtime y tamaño de la base y su WAL) para saber si hay que releer. */
export function cookieDbSignature(dbPath: string): string {
  const part = (f: string) => {
    try {
      const s = fs.statSync(f);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '-';
    }
  };
  return `${part(dbPath)}|${part(`${dbPath}-wal`)}`;
}

type Row = Record<string, unknown>;

interface NetscapeCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  secure: boolean;
  httpOnly: boolean;
}

function toNetscape(list: NetscapeCookie[]): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list) {
    const domain = clean(c.host);
    lines.push(
      [
        (c.httpOnly ? '#HttpOnly_' : '') + domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        clean(c.path) || '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(c.expiry),
        clean(c.name),
        clean(c.value),
      ].join('\t'),
    );
  }
  return lines.join('\n') + '\n';
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function readFirefox(db: DatabaseSync, now: number): NetscapeCookie[] {
  // Firefox 142 (esquema 16) pasó la caducidad a milisegundos
  const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version ?? 0);
  const cols = columns(db, 'moz_cookies');
  const httpOnly = cols.has('isHttpOnly') ? 'isHttpOnly' : '0';
  // Primero las cookies sin contenedor; ante duplicados gana la primera
  const order = cols.has('originAttributes') ? "ORDER BY (originAttributes <> '')" : '';
  const rows = db
    .prepare(`SELECT host, name, value, path, expiry, isSecure, ${httpOnly} AS httpOnly FROM moz_cookies ${order}`)
    .all() as Row[];
  const out: NetscapeCookie[] = [];
  for (const r of rows) {
    let expiry = Number(r.expiry ?? 0);
    if (version >= 16) expiry = expiry / 1000;
    out.push({
      host: String(r.host ?? ''),
      name: String(r.name ?? ''),
      value: String(r.value ?? ''),
      path: String(r.path ?? '/'),
      expiry: Math.floor(expiry),
      secure: Number(r.isSecure) === 1,
      httpOnly: Number(r.httpOnly) === 1,
    });
  }
  return out.filter((c) => c.expiry === 0 || c.expiry > now);
}

const V10_KEY = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
const EMPTY_KEY = pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

// Chromium en Linux sin llavero (--password-store=basic) cifra con v10 y una clave fija.
// v11 usa el llavero del sistema (GNOME/KWallet) y no se puede descifrar dentro del contenedor.
function decryptChromium(enc: Uint8Array, hashPrefix: boolean): string | null {
  const buf = Buffer.from(enc);
  if (buf.subarray(0, 3).toString('latin1') !== 'v10') return null;
  for (const key of [V10_KEY, EMPTY_KEY]) {
    try {
      const d = createDecipheriv('aes-128-cbc', key, IV);
      const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(hashPrefix ? plain.subarray(32) : plain);
      return text;
    } catch {
      /* probar la siguiente clave */
    }
  }
  return null;
}

function readChromium(db: DatabaseSync, now: number): { list: NetscapeCookie[]; undecryptable: number } {
  // Desde meta.version 24 el valor descifrado lleva delante un SHA-256 del dominio (32 bytes)
  let metaVersion = 0;
  if (hasTable(db, 'meta')) {
    const m = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as Row | undefined;
    metaVersion = Number(m?.value ?? 0);
  }
  const cols = columns(db, 'cookies');
  const secure = cols.has('is_secure') ? 'is_secure' : 'secure';
  const httpOnly = cols.has('is_httponly') ? 'is_httponly' : cols.has('httponly') ? 'httponly' : '0';
  const rows = db
    // expires_utc está en microsegundos desde 1601 y supera Number.MAX_SAFE_INTEGER: se divide en SQL
    .prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires_sec, ${secure} AS secure, ${httpOnly} AS httpOnly FROM cookies`)
    .all() as Row[];
  const list: NetscapeCookie[] = [];
  let undecryptable = 0;
  for (const r of rows) {
    const host = String(r.host_key ?? '');
    if (!allowedHost(host)) continue;
    let value = typeof r.value === 'string' ? r.value : '';
    const enc = r.encrypted_value;
    if (value === '' && enc instanceof Uint8Array && enc.length > 0) {
      const dec = decryptChromium(enc, metaVersion >= 24);
      if (dec === null) {
        undecryptable++;
        continue;
      }
      value = dec;
    }
    const sec = Number(r.expires_sec ?? 0);
    const expiry = sec > 0 ? sec - CHROMIUM_EPOCH_OFFSET_SEC : 0;
    if (expiry !== 0 && expiry <= now) continue;
    list.push({
      host,
      name: String(r.name ?? ''),
      value,
      path: String(r.path ?? '/'),
      expiry,
      secure: Number(r.secure) === 1,
      httpOnly: Number(r.httpOnly) === 1,
    });
  }
  return { list, undecryptable };
}

function openSqlite(file: string): DatabaseSync {
  // Carga perezosa: node:sqlite solo se importa (y avisa de que es experimental) si se usa
  const sqlite = process.getBuiltinModule('node:sqlite');
  return new sqlite.DatabaseSync(file);
}

/**
 * Lee la base de cookies. Copia la base y su WAL a un directorio temporal 0700 y abre la copia:
 * así no se bloquea al navegador si está abierto, funciona con montajes de solo lectura y entran
 * las cookies recientes que aún están en el WAL (yt-dlp con --cookies-from-browser las pierde).
 */
export function readCookieDb(dbPath: string, now = Math.floor(Date.now() / 1000)): CookieDbSnapshot {
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setube-ckdb-'));
  } catch (e) {
    throw new CookieDbError(errCode(e, 'ETMP'), 'no se pudo crear el directorio temporal');
  }
  try {
    const copy = path.join(dir, 'c.sqlite');
    try {
      fs.copyFileSync(dbPath, copy);
      fs.chmodSync(copy, 0o600);
    } catch (e) {
      throw new CookieDbError(errCode(e, 'EREAD'), 'no se pudo leer la base de cookies');
    }
    try {
      fs.copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    } catch (e) {
      if (errCode(e, '') !== 'ENOENT') throw new CookieDbError(errCode(e, 'EREAD'), 'no se pudo leer el WAL de la base de cookies');
    }

    let db: DatabaseSync;
    try {
      db = openSqlite(copy);
    } catch {
      throw new CookieDbError('EFORMAT', 'no es una base SQLite válida');
    }
    try {
      let kind: CookieDbKind;
      let list: NetscapeCookie[];
      let undecryptable = 0;
      try {
        if (hasTable(db, 'moz_cookies')) {
          kind = 'firefox';
          list = readFirefox(db, now).filter((c) => allowedHost(c.host));
        } else if (hasTable(db, 'cookies')) {
          kind = 'chromium';
          ({ list, undecryptable } = readChromium(db, now));
        } else {
          throw new CookieDbError('EFORMAT', 'la base no tiene tablas de cookies de Firefox ni de Chromium');
        }
      } catch (e) {
        if (e instanceof CookieDbError) throw e;
        throw new CookieDbError('EFORMAT', 'no se pudo consultar la base de cookies');
      }
      const seen = new Set<string>();
      const unique = list.filter((c) => {
        const k = `${c.host}\t${c.path}\t${c.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const loggedIn = unique.some((c) => AUTH_NAMES.has(c.name) && c.host.replace(/^\./, '').endsWith('youtube.com'));
      return { kind, netscape: toNetscape(unique), count: unique.length, loggedIn, undecryptable };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
