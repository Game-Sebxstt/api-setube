import archiver from "archiver";
import pLimit from "p-limit";
import { NUM_CPUS, CONCURRENCY } from "../config.js";
import { PassThrough } from "stream";
import { normalizeYouTubeUrl, processUrl, sanitizeFilename, sendToAllClients } from "../lib/utils.js";
import { downloadAudioStream } from "../lib/audio.js";
import ytpl from "@distube/ytpl";
import { convertAudio } from "../lib/ffmpeg.js";

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

import fs from "fs";
import path from "path";
import { PATH_SAVE } from "../config.js";

const CACHE_DIR = path.join(PATH_SAVE, "cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export const convertToAudio = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  const format: AudioFormats = req.body.format || "mp3";
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  if (urls.length === 1) {
    const url = normalizeYouTubeUrl(urls[0]) || urls[0];
    // We need info to get title for cache key. 
    // Optimization: We could cache by VideoID if we trust format is consistent.
    // But we need title for filename anyway.
    // Let's get info first.
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

  const archive = archiver("zip");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.attachment(`descarga-${format}-${Date.now()}.zip`);
  archive.pipe(res);

  const limit = pLimit(CONCURRENCY);
  const tasks = urls.map((rawUrl) => limit(async () => {
    try {
      const url = normalizeYouTubeUrl(rawUrl) || rawUrl;

      // We need title for cache check. This implies fetching info is unavoidable unless we cache by URL map.
      // For now, fetch info. It's fast with ytdl-core.
      const { info, stream } = await downloadAudioStream(url);
      const filename = sanitizeFilename(info.videoDetails.title) + "." + format;
      const cachePath = path.join(CACHE_DIR, filename);

      if (fs.existsSync(cachePath)) {
        console.log(`CACHE HIT (ZIP): ${filename}`);
        archive.file(cachePath, { name: filename });
        sendToAllClients({ type: "success", filename });
        return;
      }

      const pass = new PassThrough();
      // Pipe to cache AND archive
      pass.pipe(fs.createWriteStream(cachePath));
      archive.append(pass, { name: filename });

      await convertAudio(stream, format, 'pipe', {
        outputStream: pass,
        filename: filename,
        onEndCallback: () => sendToAllClients({ type: "success", filename })
      });

    } catch (err: any) {
      console.error(`Error procesando ${rawUrl}:`, err);
      sendToAllClients({ type: "error", message: `Falló la conversión de ${rawUrl}` });
    }
  }));

  await Promise.all(tasks);
  await archive.finalize();
  res.end();
}

export const playlistToAudio = async (req: any, res: any) => {
  const raw = req.body.url;
  if (!raw) return res.status(400).json({ message: "Falta URL" });

  try {
    const idOrUrl = await ytpl.getPlaylistID(raw);
    const playlist: playlistResponse = await ytpl(idOrUrl, { limit: Infinity }) as unknown as playlistResponse;
    const urls = playlist.items.map((item) => item.url);
    const { items, ...info } = playlist
    console.log(`info Nueva Playlist ${JSON.stringify(info)}`)
    return res.json({ info, total: urls.length, urls });
  } catch (err: any) {
    return res.status(500).json({ message: "Error al obtener playlist", error: err.message });
  }
}
