import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let dir = null;
if (argv[0] === '--scenario') {
  dir = argv[1];
  argv.splice(0, 2);
}
const log = (obj) => {
  if (dir) fs.appendFileSync(path.join(dir, 'ffmpeg.log'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...obj }) + '\n');
};

if (argv.includes('-version')) {
  process.stdout.write('ffmpeg version 8.1.2-fake\n');
  process.exit(0);
}

log({ kind: 'start', argv });
const pi = argv.indexOf('-progress');
const progressFd = pi >= 0 ? Number(String(argv[pi + 1]).replace('pipe:', '')) : null;
const inputs = argv.flatMap((a, i) => (argv[i - 1] === '-i' ? [Number(String(a).replace('pipe:', ''))] : []));

let total = 0;
let sawB = false;
const writeProgress = (end) => {
  if (progressFd === null) return;
  try {
    fs.writeSync(progressFd, `out_time_us=${Math.round((total / 10000) * 1e6)}\nspeed=1.0x\nprogress=${end ? 'end' : 'continue'}\n`);
  } catch {
    /* el padre cerró el fd */
  }
};

let open = inputs.length;
for (const fd of inputs) {
  const s = fd === 0 ? process.stdin : fs.createReadStream(null, { fd });
  s.on('data', (c) => {
    total += c.length;
    if (!sawB && c.includes(0x42)) {
      sawB = true;
      log({ kind: 'sawB' });
    }
    process.stdout.write(c);
    writeProgress(false);
  });
  s.on('error', () => undefined);
  s.on('end', () => {
    if (--open === 0) {
      writeProgress(true);
      process.exit(0);
    }
  });
}
