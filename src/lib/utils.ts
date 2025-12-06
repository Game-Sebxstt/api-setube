import { downloadAudioStream } from "./audio.js";
import path from "path";
import fs from "fs";
import { convertAudio } from "./ffmpeg.js";
import { PATH_SAVE } from "../config.js";
import { ClientsManager } from "../managers/clients.manager.js";

export function sanitizeFilename(name: string) {
  const invalidChars = /[<>:"/\\|?*]/g;
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(invalidChars, "");
}

export function normalizeYouTubeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["www.youtube.com", "youtube.com", "youtu.be", "music.youtube.com"].includes(url.hostname)) return null;
    if (url.hostname.includes("youtu.be")) return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return null;
  }
}

export function sendToAllClients(data: any) {
    const clients = ClientsManager.getInstance().getClients();
    for (const [, client] of clients) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);  
    }
}

export const processUrl = async (url: string): Promise<{ url: string; filename?: string; error?: string }> => {
  try {
    const { info, stream } = await downloadAudioStream(url);
    const safeTitle = sanitizeFilename(info.videoDetails.title);
    let outPath = path.join(PATH_SAVE, `${safeTitle}.mp3`);

    let counter = 1;
    while (fs.existsSync(outPath)) {
      outPath = path.join(PATH_SAVE, `${safeTitle} (${counter}).mp3`);
      counter++;
    }

    await convertAudio(stream, "mp3", "save", { outPath });

    return { url, filename: path.basename(outPath) };
  } catch (err: any) {
    return { url, error: err.message || "Error desconocido" };
  }
};