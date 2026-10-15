import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let dir = null;
if (argv[0] === '--scenario') {
  dir = argv[1];
  argv.splice(0, 2);
}
const cwd = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => {
  if (dir) fs.appendFileSync(path.join(dir, 'ytdlp.log'), JSON.stringify({ pid: process.pid, cwd, ...obj }) + '\n');
};
const scenario = (videoId) => {
  if (!dir || !videoId) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${videoId}.json`), 'utf8'));
  } catch {
    return {};
  }
};
const fail = (code, msg) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};

process.stderr.write(`FAKE cwd=${cwd}\n`);

if (argv.includes('--version')) {
  process.stdout.write('2026.08.19\n');
  process.exit(0);
}

const ci = argv.indexOf('--cookies');
const cookiesPath = ci >= 0 ? argv[ci + 1] : null;
const cookies = cookiesPath
  ? { path: cookiesPath, inCwd: path.dirname(cookiesPath) === cwd, exists: fs.existsSync(cookiesPath), name: path.basename(cookiesPath) }
  : null;

function buildInfo(videoId, sc) {
  const bytes = sc.bytes ?? 200000;
  const url = (itag) => `https://rr1---sn-fake.googlevideo.com/videoplayback?itag=${itag}&id=${videoId}`;
  return {
    id: videoId,
    title: sc.title ?? `Título ${videoId}`,
    channel: 'Canal falso',
    duration: sc.duration ?? 20,
    live_status: sc.live ? 'is_live' : 'not_live',
    webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
    original_url: `https://www.youtube.com/watch?v=${videoId}`,
    description: 'descripción',
    formats: [
      { format_id: 'sb0', format_note: 'storyboard', ext: 'mhtml', protocol: 'mhtml', url: url('sb0') },
      { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 130, protocol: 'https', filesize: bytes, url: url(251) },
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, protocol: 'https', filesize: bytes, url: url(140) },
      { format_id: '134', ext: 'mp4', acodec: 'none', vcodec: 'avc1.4d401e', height: 360, tbr: 300, protocol: 'https', filesize: bytes, url: url(134) },
      { format_id: '136', ext: 'mp4', acodec: 'none', vcodec: 'avc1.4d401f', height: 720, tbr: 900, protocol: 'https', filesize: bytes, url: url(136) },
    ],
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const progress = (o) => process.stderr.write(`SETUBE_PROGRESS ${JSON.stringify(o)}\n`);

async function writeBytes(total, fill, chunk, delayMs) {
  let sent = 0;
  while (sent < total) {
    const n = Math.min(chunk, total - sent);
    process.stdout.write(Buffer.alloc(n, fill));
    sent += n;
    progress({ downloaded_bytes: sent, total_bytes: total, speed: 100000, eta: 1, status: 'downloading' });
    if (delayMs) await sleep(delayMs);
  }
}

async function main() {
  if (argv.includes('-J')) {
    const url = argv[argv.indexOf('--') + 1] ?? '';
    const videoId = new URL(url).searchParams.get('v');
    const sc = scenario(videoId);
    log({ kind: 'info', videoId, argv, cookies });
    if (sc.info?.error) fail(1, `ERROR: [youtube] ${videoId}: ${sc.info.error}`);
    if (sc.info?.delayMs) await sleep(sc.info.delayMs);
    process.stdout.write(JSON.stringify(buildInfo(videoId, sc)));
    process.exit(0);
  }

  const formatId = argv[argv.indexOf('-f') + 1];
  const li = argv.indexOf('--load-info-json');
  if (li < 0 || argv[li + 1] !== '-') fail(2, 'FAKE: falta --load-info-json -');
  let info;
  try {
    info = JSON.parse(await readStdin());
  } catch {
    fail(2, 'FAKE: stdin sin JSON');
  }
  if ('webpage_url' in info) fail(2, 'FAKE: webpage_url presente en el info JSON');
  const videoId = info.id;

  const frag = path.join(cwd, '--Frag1');
  if (fs.existsSync(frag)) fail(3, 'FAKE: --Frag1 ajeno en el cwd');
  fs.writeFileSync(frag, 'x');

  const sc = scenario(videoId);
  const prev = dir && fs.existsSync(path.join(dir, 'ytdlp.log'))
    ? fs.readFileSync(path.join(dir, 'ytdlp.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.kind === 'download' && l.videoId === videoId && l.formatId === formatId).length
    : 0;
  const list = sc.downloads?.[formatId] ?? sc.downloads?.['*'] ?? [{ mode: 'ok' }];
  const m = list[Math.min(prev, list.length - 1)] ?? { mode: 'ok' };
  log({ kind: 'download', videoId, formatId, idx: prev, mode: m.mode, argv, cookies });

  const bytes = m.bytes ?? sc.bytes ?? 200000;
  const chunk = m.chunk ?? 16384;
  const delayMs = m.delayMs ?? 2;
  switch (m.mode) {
    case 'ok':
      await writeBytes(bytes, 0x41, chunk, delayMs);
      progress({ downloaded_bytes: bytes, total_bytes: bytes, speed: 100000, eta: 0, status: 'finished' });
      process.exit(0);
      break;
    case 'infoFailed':
      process.stderr.write(`WARNING: [youtube] ${videoId}: The info failed to download: HTTP Error 403; trying with URL\n`);
      await sleep(m.waitMs ?? 400);
      await writeBytes(bytes, 0x42, chunk, delayMs);
      process.exit(0);
      break;
    case 'fail403':
      fail(1, 'ERROR: unable to download video data: HTTP Error 403: Forbidden');
      break;
    case 'fail':
      fail(1, `ERROR: [youtube] ${videoId}: ${m.message ?? 'Video unavailable'}`);
      break;
    case 'exit1AfterBytes':
      await writeBytes(bytes, 0x41, chunk, delayMs);
      fail(1, 'ERROR: unable to download video data: Connection reset by peer');
      break;
    case 'hang':
      setInterval(() => undefined, 1 << 30);
      break;
    default:
      fail(4, `FAKE: modo desconocido ${m.mode}`);
  }
}

main();
