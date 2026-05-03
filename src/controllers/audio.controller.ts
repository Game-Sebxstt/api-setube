import archiver from "archiver";
import pLimit from "p-limit";
import { NUM_CPUS, CONCURRENCY, COOKIES_PATH } from "../config.js";
import { PassThrough } from "stream";
import { normalizeYouTubeUrl, processUrl, sanitizeFilename, sendToAllClients } from "../lib/utils.js";
import { downloadAudioStream } from "../lib/audio.js";
import { convertAudio } from "../lib/ffmpeg.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { PATH_SAVE } from "../config.js";

const CACHE_DIR = path.join(PATH_SAVE, "cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export const downloadAudio = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }
  const limit = pLimit(CONCURRENCY);
  const tasks = urls.map((url) => limit(() => processUrl(normalizeYouTubeUrl(url) || url)));
  const results = await Promise.all(tasks);
  return res.json({ cpus: NUM_CPUS, concurrency: CONCURRENCY, totalRequested: urls.length, processed: results.length, results });
}

export const convertToAudio = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  const format: any = req.body.format || "mp3";
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  if (urls.length === 1) {
    const url = normalizeYouTubeUrl(urls[0]) || urls[0];
    const { info, stream } = await downloadAudioStream(url);
    const title = sanitizeFilename(info.videoDetails.title) + "." + format;
    const cachePath = path.join(CACHE_DIR, title);

    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    const encodedTitle = encodeURIComponent(title);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedTitle}`);

    if (fs.existsSync(cachePath)) {
      console.log(`CACHE HIT: ${title}`);
      fs.createReadStream(cachePath).pipe(res);
      return;
    }

    console.log(`CACHE MISS: ${title}`);
    const pass = new PassThrough();
    pass.pipe(res);
    const cacheStream = fs.createWriteStream(cachePath);
    pass.pipe(cacheStream);

    await convertAudio(stream, format, "pipe", { outputStream: pass, filename: title });
    return;
  }

  const archive = archiver("zip", { zlib: { level: 1 } });
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  const zipName = `audios-${format}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  res.attachment(zipName);
  archive.pipe(res);

  const limit = pLimit(CONCURRENCY);
  await Promise.all(urls.map((rawUrl) => limit(async () => {
    try {
      const url = normalizeYouTubeUrl(rawUrl) || rawUrl;
      const { info, stream } = await downloadAudioStream(url);
      const filename = sanitizeFilename(info.videoDetails.title) + "." + format;
      const cachePath = path.join(CACHE_DIR, filename);

      const isCached = fs.existsSync(cachePath) && fs.statSync(cachePath).size > 500000;

      if (isCached) {
        console.log(`CACHE HIT (ZIP): ${filename}`);
        archive.file(cachePath, { name: filename });
        sendToAllClients({ type: "success", filename });
        return;
      }

      console.log(`CACHE MISS/CORRUPT (ZIP): ${filename}`);
      if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);

      const pass = new PassThrough();
      // Pipe to both ZIP and Cache
      archive.append(pass, { name: filename });
      const cacheStream = fs.createWriteStream(cachePath);
      pass.pipe(cacheStream);

      await convertAudio(stream, format, 'pipe', {
        outputStream: pass,
        filename: filename,
        onEndCallback: () => {
          sendToAllClients({ type: "success", filename });
        }
      });

    } catch (err: any) {
      console.error(`Error procesando ${rawUrl}:`, err);
      sendToAllClients({ type: "error", message: `Falló la conversión de ${rawUrl}` });
    }
  })));

  await archive.finalize();
  console.log(`ZIP finalizado: ${zipName}`);
}

export const playlistToAudio = async (req: any, res: any) => {
  const raw = req.body.url;
  if (!raw) return res.status(400).json({ message: "Falta URL" });

  try {
    const ytDlpCmd = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const args = [
        '--flat-playlist',
        '--print', 'url',
        '--print', 'title',
        '--no-warnings',
        '--quiet'
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    args.push(raw);

    const ytDlpProcess = spawn(ytDlpCmd, args);
    let output = '';
    ytDlpProcess.stdout.on('data', (data) => {
        output += data.toString();
    });

    ytDlpProcess.on('close', (code) => {
        if (code !== 0) {
            return res.status(500).json({ message: "Error al obtener playlist con yt-dlp" });
        }
        
        const lines = output.trim().split('\n');
        const items = [];
        for (let i = 0; i < lines.length; i += 2) {
            if (lines[i] && lines[i+1]) {
                items.push({ url: lines[i], title: lines[i+1] });
            }
        }
        
        const urls = items.map(item => item.url);
        return res.json({ info: { title: "Playlist" }, total: urls.length, urls, items });
    });

  } catch (err: any) {
    return res.status(500).json({ message: "Error al obtener playlist", error: err.message });
  }
}
