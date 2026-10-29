import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { cookies } from '../../src/lib/media/cookies.js';
import { readCookieDb, resolveCookieDb } from '../../src/lib/media/cookies-db.js';

const { DatabaseSync: Db } = process.getBuiltinModule('node:sqlite');
const HEX = 'a'.repeat(64);
const NOW = 1_800_000_000;
const FUTURE = 2_000_000_000;
const SECRET = 'valor-sapisid-secreto';

let tmp: string;
const open: DatabaseSync[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckdb-test-'));
  cookies.reset();
});
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  cookies.reset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type FfRow = [host: string, name: string, value: string, expiry: number, httpOnly?: number];

// Base de Firefox en modo WAL y sin checkpoint: las filas quedan solo en cookies.sqlite-wal
function firefoxDb(dir: string, rows: FfRow[], { schema = 16, keepOpen = true } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cookies.sqlite');
  const db = new Db(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`PRAGMA user_version=${schema}`);
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
    host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER)`);
  const ins = db.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, 1, ?)');
  for (const [host, name, value, expiry, httpOnly = 0] of rows) ins.run(name, value, host, '/', schema >= 16 ? expiry * 1000 : expiry, httpOnly);
  if (keepOpen) open.push(db);
  else db.close();
  return file;
}

function chromiumV10(host: string, value: string, hashPrefix: boolean): Uint8Array {
  const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = hashPrefix ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
}

const lines = (netscape: string) => netscape.trim().split('\n').slice(1).map((l) => l.split('\t'));

describe('readCookieDb', () => {
  it('Firefox: lee el WAL, filtra dominios y caducadas, convierte ms → s', () => {
    const file = firefoxDb(tmp, [
      ['.youtube.com', 'SAPISID', SECRET, FUTURE],
      ['.youtube.com', 'VIEJA', 'x', NOW - 10],
      ['accounts.google.com', 'LSID', 'g', FUTURE, 1],
      ['.example.com', 'AJENA', 'no', FUTURE],
    ]);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const snap = readCookieDb(file, NOW);
    expect(snap.kind).toBe('firefox');
    expect(snap.loggedIn).toBe(true);
    expect(snap.count).toBe(2);
    expect(lines(snap.netscape)).toEqual([
      ['.youtube.com', 'TRUE', '/', 'TRUE', String(FUTURE), 'SAPISID', SECRET],
      ['#HttpOnly_accounts.google.com', 'FALSE', '/', 'TRUE', String(FUTURE), 'LSID', 'g'],
    ]);
    expect(snap.netscape).not.toContain('example.com');
  });

  it('Firefox con esquema < 16 usa segundos', () => {
    const file = firefoxDb(tmp, [['.youtube.com', 'SID', 'v', FUTURE]], { schema: 15, keepOpen: false });
    expect(lines(readCookieDb(file, NOW).netscape)[0]?.[4]).toBe(String(FUTURE));
  });

  it('sin cookies de sesión → loggedIn false', () => {
    const file = firefoxDb(tmp, [['.youtube.com', 'PREF', 'f6=40000000', FUTURE]]);
    expect(readCookieDb(file, NOW).loggedIn).toBe(false);
  });

  it('Chromium: descifra v10 (con prefijo hash si meta.version ≥ 24), salta v11 y convierte la época', () => {
    const file = path.join(tmp, 'Cookies');
    const db = new Db(file);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24');
      CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER)`);
    const utc = BigInt(FUTURE + 11644473600) * 1_000_000n + 123_456n;
    const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
    ins.run('.youtube.com', '__Secure-3PSID', '', chromiumV10('.youtube.com', SECRET, true), '/', utc, 1);
    ins.run('.youtube.com', 'PLANA', 'abc', new Uint8Array(), '/', 0, 0);
    ins.run('.youtube.com', 'LLAVERO', '', Buffer.from('v11xxxxxxxxxxxxxxxx'), '/', utc, 0);
    ins.run('.example.com', 'AJENA', 'no', new Uint8Array(), '/', utc, 0);
    db.close();

    const snap = readCookieDb(file, NOW);
    expect(snap.kind).toBe('chromium');
    expect(snap.undecryptable).toBe(1);
    expect(snap.loggedIn).toBe(true);
    expect(lines(snap.netscape)).toEqual([
      ['#HttpOnly_.youtube.com', 'TRUE', '/', 'TRUE', String(FUTURE), '__Secure-3PSID', SECRET],
      ['.youtube.com', 'TRUE', '/', 'TRUE', '0', 'PLANA', 'abc'],
    ]);
  });

  it('archivo que no es SQLite → EFORMAT', () => {
    const file = path.join(tmp, 'cookies.sqlite');
    fs.writeFileSync(file, 'no soy sqlite');
    expect(() => readCookieDb(file)).toThrow(expect.objectContaining({ code: 'EFORMAT' }));
  });

  it('resolveCookieDb busca en el directorio de perfil', () => {
    fs.mkdirSync(path.join(tmp, 'perfil', 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'perfil', 'Default', 'Network', 'Cookies'), '');
    expect(resolveCookieDb(path.join(tmp, 'perfil'))).toBe(path.join(tmp, 'perfil', 'Default', 'Network', 'Cookies'));
    expect(() => resolveCookieDb(path.join(tmp, 'no-existe'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('YTDLP_COOKIES_DB', () => {
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'development', REDIS_URL: `redis://:${HEX}@redis:6379/0`, ...extra });
  const warns = () => {
    const calls: string[] = [];
    return { calls, warn: (_o: object, msg: string) => calls.push(msg) };
  };

  it('carga desde el directorio del perfil y relee la base en cada proceso cuando cambia', async () => {
    const dir = path.join(tmp, 'perfil');
    firefoxDb(dir, [['.youtube.com', 'SAPISID', 'v1', FUTURE]], { keepOpen: false });
    const c = loadConfig(env({ YTDLP_COOKIES_DB: dir }));
    expect(c.cookiesConfigured).toBe(true);
    expect(c.cookiesDb).toBe(dir);
    expect(cookies.status()).toEqual({ source: 'db', kind: 'firefox', count: 1, loggedIn: true });

    const work = fs.mkdtempSync(path.join(tmp, 'w-'));
    expect(fs.readFileSync(await cookies.materialize(work), 'utf8')).toContain('\tv1\n');

    // el navegador rota la cookie
    const db = new Db(path.join(dir, 'cookies.sqlite'));
    open.push(db);
    db.exec("UPDATE moz_cookies SET value = 'v2'");
    const p = await cookies.materialize(work);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, 'utf8')).toContain('\tv2\n');
  });

  it('si la relectura falla sigue con la última copia buena y avisa', async () => {
    const dir = path.join(tmp, 'perfil');
    const file = firefoxDb(dir, [['.youtube.com', 'SAPISID', 'bueno', FUTURE]], { keepOpen: false });
    const log = warns();
    loadConfig(env({ YTDLP_COOKIES_DB: file }), log);
    fs.writeFileSync(file, 'corrupta');
    const work = fs.mkdtempSync(path.join(tmp, 'w-'));
    expect(fs.readFileSync(await cookies.materialize(work), 'utf8')).toContain('\tbueno\n');
    expect(log.calls).toContain('cookies_db_refresh_failed');
  });

  it('avisa si el perfil no tiene sesión iniciada', () => {
    const dir = path.join(tmp, 'perfil');
    firefoxDb(dir, [['.youtube.com', 'PREF', 'x', FUTURE]], { keepOpen: false });
    const log = warns();
    loadConfig(env({ YTDLP_COOKIES_DB: dir }), log);
    expect(log.calls).toEqual(['cookies_db_not_logged_in']);
  });

  it('ruta inexistente o junto a otra fuente de cookies → ConfigError', () => {
    const missing = path.join(tmp, 'nada');
    expect(() => loadConfig(env({ YTDLP_COOKIES_DB: missing }))).toThrow(ConfigError);
    try {
      loadConfig(env({ YTDLP_COOKIES_DB: missing }));
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(['YTDLP_COOKIES_DB']);
      expect((e as ConfigError).details).toEqual({ path: missing, code: 'ENOENT' });
    }
    const dir = path.join(tmp, 'perfil');
    firefoxDb(dir, [['.youtube.com', 'SAPISID', 'v', FUTURE]], { keepOpen: false });
    try {
      loadConfig(env({ YTDLP_COOKIES_DB: dir, YTDLP_COOKIES_FILE: path.join(tmp, 'c.txt') }));
      throw new Error('no falló');
    } catch (e) {
      expect((e as ConfigError).details).toMatchObject({ code: 'ECONFLICT' });
    }
  });
});
