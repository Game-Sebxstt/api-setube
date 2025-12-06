import { normalizeYouTubeUrl, sanitizeFilename, sendToAllClients } from "../lib/utils.js";
import ytdl from "@distube/ytdl-core";
import ytpl from "@distube/ytpl";
import { downloadVideoStream, getVideoInfo } from "../lib/video.js";
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import path from "path";
import fs from "fs";
import { PATH_SAVE } from "../config.js";
import archiver from "archiver";
import pLimit from "p-limit";
import { PassThrough } from "stream";

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es-MX;q=0.8,es;q=0.7',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'X-Youtube-Client-Name': '1',
  'X-Youtube-Client-Version': '2.20231208.00.00'
};

export const infoVideo = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  console.log(`Petición recibida - URLs: ${urls}`);

  let expandedUrls: string[] = [];
  try {
    for (const url of urls) {
      try {
        const playlistId = await ytpl.getPlaylistID(url);
        const playlist = await ytpl(playlistId, { limit: Infinity });
        expandedUrls.push(...playlist.items.map(item => item.url));
      } catch (error) {
        expandedUrls.push(url);
      }
    }
  } catch (error: any) {
    return res.status(500).json({ message: "Error al procesar las URLs", error: error.message });
  }

  const format = req.body.format || "mp4";
  const infoUrls: { url: string; title: string; description: string | null; thumbnail: { url: string, width: number, height: number }; qualities: string[] }[] = [];
  
  const response = await Promise.all(expandedUrls.map(async url => {
    const urlNoNormalize = normalizeYouTubeUrl(url);

    try {
      const info = await getVideoInfo(urlNoNormalize || url);
      infoUrls.push(info);
    }
    catch(error: any){
      console.error(`Error al obtener información para ${url}:`, error);
      return { error: "Error al obtener información" };
    }
  }));

  if(response.some((item) => item?.error)) return res.status(500).json({ error: response.filter((item) => item?.error).map((item) => item?.error)[0] });
  return res.json({ format, urls: infoUrls });
}

export const downloadVideo = async (req: any, res: any) => {
  const urls: string[] = req.body.urls;
  if(!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ message: "Falta arreglo de URLs" });
  }

  const format: VideoFormats = req.body.format ?? "mp4";
  const quality: VideoQuality = req.body.quality ?? 'highest';
  const converted: { url: string, filename: string }[] = []

  try {
    for (const urlMain of urls) {
      const url = normalizeYouTubeUrl(urlMain) || urlMain;
      const { info, videoStream, audioStream } = await downloadVideoStream(url, quality);
      
      if (!audioStream) {
        console.warn(`No se pudo obtener el stream de audio para ${urlMain}, se omitirá.`);
        continue;
      }

      const title = sanitizeFilename(info.videoDetails.title);
      let outPath = path.resolve(PATH_SAVE, `${title}.${format}`);

      let counter = 1;
      while (fs.existsSync(outPath)) {
        outPath = path.resolve(PATH_SAVE, `${title} (${counter}).${format}`);
        counter++;
      }
      const filename = path.basename(outPath);

      await new Promise<void>((resolve, reject) => {
        const ffmpegArgs = [
            '-loglevel', 'error',
            '-i', 'pipe:3',
            '-i', 'pipe:4',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '96k',
            '-preset', 'ultrafast',
            '-f', format,
            outPath,
        ];

        const ffmpegProcess = spawn(ffmpegPath as unknown as string, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        });

        if (ffmpegProcess.stdio[3]) {
          videoStream.pipe(ffmpegProcess.stdio[3] as any);
        }
        if (ffmpegProcess.stdio[4]) {
          audioStream.pipe(ffmpegProcess.stdio[4] as any);
        }

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                converted.push({ url: urlMain, filename });
                resolve();
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        if (ffmpegProcess.stderr) {
          ffmpegProcess.stderr.on('data', (data) => {
              console.error(`FFmpeg stderr (downloadVideo): ${data}`);
          });
        }
      });
    }
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

  const format: VideoFormats = req.body.format ?? "mp4";
  const quality: string = req.body.quality ?? 'highest';
  console.log(`Petición recibida - Formato: ${format}, Calidad: ${quality}, URLs: ${urls.length}, body: ${JSON.stringify(req.body)}`);

  const processVideo = async (url: string, outputStream: NodeJS.WritableStream, filename?: string) => {
    const normalizedUrl = normalizeYouTubeUrl(url) || url;
    
    const requestOptions = {
      headers: browserHeaders
    };
    
    const ytdlOptions = {
      requestOptions: requestOptions
    };
    
    console.log(`Descargando información para ${normalizedUrl}`);
    
    const info = await ytdl.getInfo(normalizedUrl, ytdlOptions);
    const videoTitle = filename || sanitizeFilename(info.videoDetails.title);
    
    const targetVideoFormat = ytdl.chooseFormat(info.formats, { quality, filter: 'videoonly' });
    
    console.log(`Calidad de video seleccionada para ${videoTitle}: ${targetVideoFormat.qualityLabel}`);

    let audioFormat = ytdl.chooseFormat(info.formats, { filter: f => f.audioCodec === 'mp4a.40.2' });
    let useCopyForAudio = !!audioFormat;

    if (!audioFormat) {
        audioFormat = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });
    }

    if (!audioFormat) {
        throw new Error(`No se encontró un stream de audio compatible para ${videoTitle}.`);
    }
    
    const videoStream = ytdl.downloadFromInfo(info, { 
      format: targetVideoFormat,
      requestOptions: requestOptions
    });
    
    const audioStream = ytdl.downloadFromInfo(info, { 
      format: audioFormat,
      requestOptions: requestOptions
    });

    const ffmpegArgs = [
        '-loglevel', 'error',
        '-threads', '0',
        '-thread_queue_size', '4096',
        '-i', 'pipe:3',
        '-i', 'pipe:4',
        '-c:v', 'copy',
        '-preset', 'ultrafast',
        '-tune', 'fastdecode',
        '-max_muxing_queue_size', '9999'
    ];

    if (useCopyForAudio) {
        console.log(`NIVEL 2 (VÍA SEMI-RÁPIDA): Uniendo con copia directa de audio para ${videoTitle}.`);
        ffmpegArgs.push('-c:a', 'copy');
    } else {
        console.log(`NIVEL 3 (VÍA DE CALIDAD): Re-codificando audio para ${videoTitle}.`);
        ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
    }

    ffmpegArgs.push('-f', format);
    if (format === 'mp4') {
        ffmpegArgs.push('-movflags', 'frag_keyframe+empty_moov+faststart');
    }
    ffmpegArgs.push('pipe:1');

    return new Promise<void>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegPath as unknown as string, ffmpegArgs, {
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });

      if(ffmpegProcess.stdio[3]) videoStream.pipe(ffmpegProcess.stdio[3] as any);
      if(ffmpegProcess.stdio[4]) audioStream.pipe(ffmpegProcess.stdio[4] as any);
      if(ffmpegProcess.stdout) ffmpegProcess.stdout.pipe(outputStream);

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code} para ${videoTitle}`));
        }
      });

      ffmpegProcess.on('error', (err) => {
        console.error(`FFmpeg process error para ${videoTitle}:`, err);
        reject(err);
      });

      if(ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on('data', (data) => {
          console.error(`FFmpeg stderr para ${videoTitle}: ${data}`);
        });
      }
    });
  };

  try {
    if (urls.length === 1) {
      const url = urls[0];
      const info = await ytdl.getInfo(normalizeYouTubeUrl(url) || url, { requestOptions: { headers: browserHeaders } });
      const title = sanitizeFilename(info.videoDetails.title);
      const encodedTitle = encodeURIComponent(title);
      
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedTitle}.${format}`);
      
      await processVideo(url, res);
      return;
    }
    
    const archive = archiver("zip", {
      zlib: { level: 1 }
    });
    
    archive.on('error', (err) => {
      console.error('Error en el archiver:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: `Error al crear el archivo ZIP: ${err.message}` });
      }
    });
    
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Advertencia del archiver (archivo no encontrado):', err);
      } else {
        console.error('Advertencia crítica del archiver:', err);
      }
    });

    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.attachment(`videos-${format}-${Date.now()}.zip`);
    archive.pipe(res);
    
    const operationTimeout = setTimeout(() => {
      console.error('Timeout global de la operación de conversión');
      if (!res.headersSent) {
        res.status(408).json({ error: 'La operación ha tomado demasiado tiempo y ha sido cancelada' });
      }
    }, 20 * 60 * 1000);
    
    const limit = pLimit(2);
    const results: { success: boolean, url: string, filename?: string, error?: string }[] = [];
    
    try {
      for (const url of urls) {
        try {
          const normalizedUrl = normalizeYouTubeUrl(url) || url;
          console.log(`Iniciando procesamiento para ${normalizedUrl}`);
          
          const videoPromise = (async () => {
            const info = await ytdl.getInfo(normalizedUrl, { requestOptions: { headers: browserHeaders } });
            const filename = sanitizeFilename(info.videoDetails.title) + "." + format;
            const pass = new PassThrough();
            
            archive.append(pass, { name: filename });
            
            await processVideo(url, pass, filename);
            console.log(`Video procesado exitosamente: ${filename}`);
            sendToAllClients({ type: "success", filename });
            results.push({ success: true, url, filename });
          })();
          
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout procesando ${url}`)), 10 * 60 * 1000);
          });
          
          await Promise.race([videoPromise, timeoutPromise]);
          
        } catch (err: any) {
          console.error(`Error procesando video ${url}:`, err);
          sendToAllClients({ type: "error", message: `Falló la conversión de ${url}` });
          results.push({ success: false, url, error: err.message });
        }
      }
      
      console.log('Finalizando archivo ZIP...');
      await archive.finalize();
      console.log('ZIP finalizado con éxito');
      
    } catch (err: any) {
      console.error(`Error en el procesamiento general:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: `Error al procesar los videos: ${err.message}`, results });
      }
    } finally {
      clearTimeout(operationTimeout);
    }
    
  } catch (err: any) {
    console.error(`Error en el proceso de conversión: ${err.message}`);
    if (!res.headersSent) {
        res.status(500).json({
          error: `Ocurrió un error al procesar los videos: ${err.message}`
        });
    } else {
        console.error('Error ocurrido después de enviar headers, no se puede enviar respuesta JSON');
    }
  }
};