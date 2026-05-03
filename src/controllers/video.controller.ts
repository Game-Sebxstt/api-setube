import { normalizeYouTubeUrl, sanitizeFilename, sendToAllClients } from "../lib/utils.js";
import { downloadVideoStream, getVideoInfo } from "../lib/video.js";
import { spawn } from 'child_process';
import path from "path";
import fs from "fs";
import { PATH_SAVE, COOKIES_PATH, CONCURRENCY } from "../config.js";
import archiver from "archiver";
import pLimit from "p-limit";
import { PassThrough } from "stream";

export const infoVideo = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  console.log(`Petición recibida - URLs: ${urls}`);

  const limit = pLimit(CONCURRENCY);
  const expandedResults = await Promise.all(urls.map(url => limit(async () => {
    try {
      const ytDlpCmd = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const args = ['--flat-playlist', '--get-id', '--print', 'url', '--no-warnings', '--quiet', url];
      if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

      const result = await new Promise<string>((resolve) => {
          const child = spawn(ytDlpCmd, args);
          let out = '';
          child.stdout.on('data', d => out += d);
          child.on('close', () => resolve(out));
      });

      const lines = result.trim().split('\n').filter(l => l.startsWith('http'));
      return lines.length > 0 ? lines : [url];
    } catch (error: any) {
      console.error(`Error expandiendo URL ${url}:`, error);
      return [url];
    }
  })));

  const expandedUrls = expandedResults.flat();
  const format = req.body.format || "mp4";
  const infoUrls: any[] = [];
  
  await Promise.all(expandedUrls.map(url => limit(async () => {
    try {
      const info = await getVideoInfo(url);
      infoUrls.push(info);
    } catch(error: any){
      console.error(`Error al obtener información para ${url}:`, error);
    }
  })));

  return res.json({ format, urls: infoUrls });
}

export const downloadVideo = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if(!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  const format: any = req.body.format ?? "mp4";
  const quality: any = req.body.quality ?? 'highest';
  const converted: { url: string, filename: string }[] = []

  const limit = pLimit(CONCURRENCY);
  try {
    await Promise.all(urls.map(urlMain => limit(async () => {
      const url = normalizeYouTubeUrl(urlMain) || urlMain;
      const { info, stream, process } = await downloadVideoStream(url, quality);
      
      const title = sanitizeFilename(info.videoDetails.title);
      let outPath = path.resolve(PATH_SAVE, `${title}.${format}`);

      let counter = 1;
      while (fs.existsSync(outPath)) {
        outPath = path.resolve(PATH_SAVE, `${title} (${counter}).${format}`);
        counter++;
      }
      const filename = path.basename(outPath);

      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);

      await new Promise<void>((resolve, reject) => {
          process.on('close', (code) => {
              if (code === 0) {
                  converted.push({ url: urlMain, filename });
                  resolve();
              } else {
                  reject(new Error(`yt-dlp exited with code ${code}`));
              }
          });
          process.on('error', reject);
      });
    })));
    res.status(200).json({ items: converted });
  } catch (err: any) {
    console.error(`Error en el proceso de descarga: ${err.message}`);
    res.status(500).json({ error: 'Ocurrió un error durante la descarga de uno o más videos.' });
  }
}

export const convertToVideo = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  const format: any = req.body.format ?? "mp4";
  const quality: any = req.body.quality ?? 'highest';

  try {
    if (urls.length === 1) {
      const url = urls[0];
      const { info, stream } = await downloadVideoStream(url, quality);
      const title = sanitizeFilename(info.videoDetails.title);
      const encodedTitle = encodeURIComponent(title);
      
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedTitle}.${format}`);
      
      stream.pipe(res);
      return;
    }
    
    const archive = archiver("zip", { zlib: { level: 1 } });
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    const zipName = `videos-${format}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    res.attachment(zipName);
    archive.pipe(res);
    
    const limit = pLimit(CONCURRENCY);
    await Promise.all(urls.map(url => limit(async () => {
        try {
            const { info, stream } = await downloadVideoStream(url, quality);
            const filename = sanitizeFilename(info.videoDetails.title) + "." + format;
            archive.append(stream as any, { name: filename });
            
            await new Promise<void>((resolve) => {
                stream.on('end', () => {
                    sendToAllClients({ type: "success", filename });
                    resolve();
                });
                stream.on('error', () => resolve()); // Continue on error
            });
        } catch (err: any) {
            console.error(`Error procesando video ${url}:`, err);
            sendToAllClients({ type: "error", message: `Falló la conversión de ${url}` });
        }
    })));
    
    await archive.finalize();
    console.log(`ZIP finalizado: ${zipName}`);
  } catch (err: any) {
    console.error(`Error en el proceso de conversión: ${err.message}`);
    if (!res.headersSent) {
        res.status(500).json({ error: `Ocurrió un error al procesar los videos: ${err.message}` });
    }
  }
};