import closeWithGrace from 'close-with-grace';
import { buildApp, proxyStartupWarnings } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/env.js';
import { binaryVersion, configureProc, prepareTmp, SETUBE_TMP } from './lib/media/proc.js';

const early = {
  write(level: number, obj: object, msg: string) {
    process.stderr.write(JSON.stringify({ level, time: Date.now(), ...obj, msg }) + '\n');
  },
  fatal(obj: object, msg: string) {
    this.write(60, obj, msg);
  },
  warn(obj: object, msg: string) {
    this.write(40, obj, msg);
  },
};

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env, early);
  } catch (e) {
    if (e instanceof ConfigError) early.fatal({ keys: e.keys, ...(e.details ?? {}) }, 'config_invalid');
    else early.fatal({ err: { message: (e as Error).message } }, 'config_invalid');
    process.exit(1);
  }

  try {
    await prepareTmp();
  } catch (e) {
    early.fatal({ path: SETUBE_TMP, code: (e as NodeJS.ErrnoException).code }, 'setube_tmp_failed');
    process.exit(1);
  }

  configureProc({
    ytdlpPath: config.ytdlpPath,
    ytdlpArgsPrefix: config.ytdlpArgsPrefix,
    ffmpegPath: config.ffmpegPath,
    ffmpegArgsPrefix: config.ffmpegArgsPrefix,
  });
  let ytdlpVersion: string;
  try {
    ytdlpVersion = await binaryVersion('ytdlp');
    await binaryVersion('ffmpeg');
  } catch (e) {
    early.fatal({ err: { message: (e as Error).message } }, 'binaries_unavailable');
    process.exit(1);
  }

  const app = await buildApp({ config });
  for (const w of proxyStartupWarnings(config)) app.log.warn({}, w);

  closeWithGrace({ delay: config.shutdownGraceMs, logger: app.log }, async ({ err, signal }) => {
    if (err) app.log.fatal({ err }, 'fatal_error');
    else app.log.info({ signal }, 'shutdown');
    await app.lifecycle.shutdown(app, config.shutdownGraceMs);
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      convertConcurrency: config.convertConcurrency,
      cookiesConfigured: config.cookiesConfigured,
      ytdlpVersion,
    },
    'setube_api_started',
  );
}

main().catch((e: unknown) => {
  early.fatal({ err: { message: (e as Error).message } }, 'startup_failed');
  process.exit(1);
});
