import { afterEach, describe, expect, it } from 'vitest';
import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import { proxiedFetch, proxyDispatcher, type FetchImpl } from '../../src/lib/http/proxy-fetch.js';
import { ytdlpDownloadArgs, ytdlpInfoArgs, ytdlpPlaylistArgs } from '../../src/lib/media/args.js';
import { redactUrl, scrubCredentials, ytdlpNetArgs } from '../../src/lib/media/net.js';
import { configureProc, RingBuffer, ytdlpArgv } from '../../src/lib/media/proc.js';
import { pingPotProvider } from '../../src/lib/youtube/pot.js';

const ID = 'jNQXAC9IVRw';
const POT = 'http://pot:4416';
const PROXY = 'http://usuario:clave-secreta@proxy.example:8080';
const POT_ARGS = ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://pot:4416', '--extractor-args', 'youtube:player_client=default,mweb'];

const builders = {
  metadata: ytdlpInfoArgs(ID),
  playlist: ytdlpPlaylistArgs('PLxxxxxxxxxxxxxxxx', 50),
  descarga: ytdlpDownloadArgs({ videoId: ID, formatId: '140', infoJson: true, hls: false }),
  'descarga sin info JSON': ytdlpDownloadArgs({ videoId: ID, formatId: '140', infoJson: false, hls: false }),
};

afterEach(() => configureProc({ ytdlpArgsPrefix: [], ytdlpNet: { potProviderUrl: null, proxy: null } }));

describe('ytdlpNetArgs', () => {
  it('sin provider ni proxy: plugins desactivados', () => {
    expect(ytdlpNetArgs({ potProviderUrl: null, proxy: null })).toEqual(['--no-plugin-dirs']);
  });

  it('con provider: base_url y cliente mweb', () => {
    expect(ytdlpNetArgs({ potProviderUrl: POT, proxy: null })).toEqual(POT_ARGS);
  });

  it('con proxy y provider', () => {
    expect(ytdlpNetArgs({ potProviderUrl: POT, proxy: PROXY })).toEqual(['--proxy', PROXY, ...POT_ARGS]);
  });

  it('con proxy sin provider', () => {
    expect(ytdlpNetArgs({ potProviderUrl: null, proxy: 'socks5://proxy.example:1080' })).toEqual([
      '--proxy', 'socks5://proxy.example:1080', '--no-plugin-dirs',
    ]);
  });
});

describe.each(Object.entries(builders))('argv final de yt-dlp: %s', (_name, build) => {
  const own = build(null);

  it('sin POT_PROVIDER_URL ni YTDLP_PROXY', () => {
    const argv = ytdlpArgv(build, null);
    expect(argv).toEqual(['--no-plugin-dirs', ...own]);
    expect(argv).not.toContain('--proxy');
    expect(argv.join(' ')).not.toContain('youtubepot');
  });

  it('con POT_PROVIDER_URL', () => {
    configureProc({ ytdlpNet: { potProviderUrl: POT, proxy: null } });
    expect(ytdlpArgv(build, null)).toEqual([...POT_ARGS, ...own]);
  });

  it('con YTDLP_PROXY', () => {
    configureProc({ ytdlpNet: { potProviderUrl: null, proxy: PROXY } });
    expect(ytdlpArgv(build, null)).toEqual(['--proxy', PROXY, '--no-plugin-dirs', ...own]);
  });

  it('con ambos, después de YTDLP_ARGS_PREFIX y antes de `--`', () => {
    configureProc({ ytdlpArgsPrefix: ['fake.mjs'], ytdlpNet: { potProviderUrl: POT, proxy: PROXY } });
    const argv = ytdlpArgv(build, '/tmp/setube/w-1/ck.txt');
    expect(argv.slice(0, 1 + 2 + POT_ARGS.length)).toEqual(['fake.mjs', '--proxy', PROXY, ...POT_ARGS]);
    expect(argv).toContain('--cookies');
    const sep = argv.indexOf('--');
    if (sep >= 0) expect(argv.indexOf('--proxy')).toBeLessThan(sep);
  });
});

describe('redacción de credenciales', () => {
  it('redactUrl deja esquema, host y puerto', () => {
    expect(redactUrl(PROXY)).toBe('http://[redacted]@proxy.example:8080');
    expect(redactUrl('socks5://u:p@10.0.0.1:1080')).toBe('socks5://[redacted]@10.0.0.1:1080');
    expect(redactUrl('http://pot:4416')).toBe('http://pot:4416');
    expect(redactUrl(null)).toBeNull();
    expect(redactUrl(PROXY)).not.toContain('clave-secreta');
  });

  it('scrubCredentials y RingBuffer limpian usuario:clave de las líneas de stderr', () => {
    const line = `ERROR: Unable to connect to proxy ${PROXY}/ (caused by ProxyError)`;
    expect(scrubCredentials(line)).toBe('ERROR: Unable to connect to proxy http://[redacted]@proxy.example:8080/ (caused by ProxyError)');
    const ring = new RingBuffer(5);
    ring.push(line);
    expect(ring.text()).not.toContain('clave-secreta');
    expect(scrubCredentials('https://rr1---sn-x.googlevideo.com/videoplayback?a=1')).toBe('https://rr1---sn-x.googlevideo.com/videoplayback?a=1');
  });
});

describe('fetch por proxy', () => {
  it('proxyDispatcher elige el agente según el esquema', async () => {
    const http = proxyDispatcher(PROXY);
    const socks = proxyDispatcher('socks5://u:p@proxy.example:1080');
    expect(http).toBeInstanceOf(ProxyAgent);
    expect(socks).toBeInstanceOf(Socks5ProxyAgent);
    await Promise.all([http.close(), socks.close()]);
  });

  it('proxiedFetch añade el dispatcher y conserva el init', async () => {
    const dispatcher = proxyDispatcher(PROXY);
    const seen: { url: string; init: Record<string, unknown> }[] = [];
    const impl: FetchImpl = async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status: 204 });
    };
    const f = proxiedFetch(dispatcher, impl);
    const ctrl = new AbortController();
    await f('https://rr1---sn-x.googlevideo.com/videoplayback', { headers: { Range: 'bytes=0-1' }, redirect: 'manual', signal: ctrl.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init).toMatchObject({ dispatcher, redirect: 'manual', headers: { Range: 'bytes=0-1' }, signal: ctrl.signal });
    await dispatcher.close();
  });
});

describe('pingPotProvider', () => {
  it('ok con versión', async () => {
    const f = (async () => Response.json({ server_uptime: 1, version: '2.0.2' })) as typeof fetch;
    await expect(pingPotProvider(POT, f)).resolves.toEqual({ ok: true, version: '2.0.2' });
  });

  it('error de red, estado y timeout', async () => {
    const net = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(pingPotProvider(POT, net)).resolves.toEqual({ ok: false, reason: 'network' });
    const st = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await expect(pingPotProvider(POT, st)).resolves.toEqual({ ok: false, reason: 'status', status: 500 });
    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as typeof fetch;
    await expect(pingPotProvider(POT, slow, 20)).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
