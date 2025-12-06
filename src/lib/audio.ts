import ytdl from "@distube/ytdl-core";
import retry from "async-retry";
import { spawn } from "child_process";

export async function downloadAudioStream(url: string): Promise<{
    info: ytdl.videoInfo;
    stream: NodeJS.ReadableStream
}> {
    return await retry(async (bail) => {
        try {
            const info = await ytdl.getInfo(url).catch(() => ({
                videoDetails: {
                    videoId: url.split('v=')[1]?.split('&')[0] || '',
                    title: 'Audio',
                    lengthSeconds: '0',
                    author: { name: 'Unknown' }
                },
                formats: [] // Ensure formats array exists for type safety, though downloadFromInfo checks it
            } as unknown as ytdl.videoInfo));

            console.log(`Descargando: ${info.videoDetails.title}`);

            // Reverting to yt-dlp as primary due to stability issues with ytdl-core (incomplete downloads)
            const ytDlpCmd = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

            const ytDlpProcess = spawn(ytDlpCmd, [
                '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
                '--no-playlist',
                '--no-warnings',
                '--quiet',
                '--no-check-certificates',
                '--buffer-size', '1M',
                '--concurrent-fragments', '8',
                '-o', '-',
                url
            ], {
                shell: true
            });

            const stream = ytDlpProcess.stdout as NodeJS.ReadableStream;

            ytDlpProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('ERROR')) console.error('yt-dlp:', msg);
            });

            ytDlpProcess.on('error', (err: any) => {
                if (err.code === 'ENOENT') {
                    console.error('yt-dlp no encontrado. Instala con: winget install yt-dlp');
                }
            });

            return { info, stream };

        } catch (error: any) {
            if (error.statusCode === 403 || error.message.includes('403')) {
                bail(new Error('Error 403'));
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