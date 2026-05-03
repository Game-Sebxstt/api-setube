import retry from "async-retry";
import { spawn } from "child_process";
import fs from "fs";
import { COOKIES_PATH } from "../config.js";
import { getVideoInfo } from "./video.js";

export async function downloadAudioStream(url: string): Promise<{
    info: any;
    stream: NodeJS.ReadableStream
}> {
    return await retry(async (bail) => {
        try {
            const robustInfo = await getVideoInfo(url).catch(() => null);
            const info = {
                videoDetails: {
                    title: robustInfo?.title || 'Audio',
                    videoId: url.split('v=')[1]?.split('&')[0] || ''
                }
            };

            console.log(`Descargando (yt-dlp): ${info.videoDetails.title}`);

            const ytDlpCmd = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
            const args = [
                '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
                '--no-playlist',
                '--no-warnings',
                '--quiet',
                '--no-check-certificates',
                '--buffer-size', '1M',
                '--concurrent-fragments', '8',
                '-o', '-',
                url
            ];

            if (fs.existsSync(COOKIES_PATH)) {
                args.push('--cookies', COOKIES_PATH);
            }

            const ytDlpProcess = spawn(ytDlpCmd, args, {
                shell: false // Prefer shell: false in Docker
            });

            const stream = ytDlpProcess.stdout as NodeJS.ReadableStream;

            ytDlpProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('ERROR')) console.error('yt-dlp ERROR:', msg);
            });

            ytDlpProcess.on('error', (err: any) => {
                console.error('Error al ejecutar yt-dlp:', err);
                if (err.code === 'ENOENT') {
                    console.error('yt-dlp no encontrado.');
                }
            });

            return { info, stream };

        } catch (error: any) {
            if (error.statusCode === 403 || error.message.includes('403')) {
                bail(new Error('Error 403 en YouTube'));
                return { info: null as any, stream: null as any };
            }
            throw error;
        }
    }, {
        retries: 2,
        minTimeout: 1000,
        maxTimeout: 3000
    });
}