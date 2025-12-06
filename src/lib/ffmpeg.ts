import ffmpeg from "fluent-ffmpeg";
import path from "path";
import { Writable } from "stream";

export type outputOptions = 'save' | 'pipe';

export type FfmpegPreset = 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
export type VideoCodec = 'libx264' | 'libx265' | 'copy';
export type AudioCodec = 'aac' | 'libmp3lame' | 'libopus' | 'copy';

export interface videoConfig {
  quality?: number;
  maxrate?: string;
  bufsize?: string;
  preset?: FfmpegPreset;
  size?: string;
  fps?: number;
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  audioBitrate?: string;
  crf?: number;
}

export interface ConfigSave extends videoConfig {
  outPath: string;
}

export interface ConfigPipe extends videoConfig {
  outputStream: Writable;
  filename: string;
  onEndCallback?: () => void;
}

export function convertAudio(stream: any, format: AudioFormats, output: 'save', config: ConfigSave): Promise<void>;
export function convertAudio(stream: any, format: AudioFormats, output: 'pipe', config: ConfigPipe): Promise<void>;
export function convertAudio(stream: any, format: AudioFormats, output: outputOptions, config: ConfigSave | ConfigPipe): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const command = ffmpeg(stream as any)
      .outputOptions(["-threads", "0"]) // Use all available threads
      .format(format);

    if (format === "mp3") {
      // SPEED OPTIMIZATION: CBR 128k + Stereo
      // -b:a 128k is faster than VBR (-q:a)
      // -ac 2 ensures stereo without complex mixing logic
      command.outputOptions([
        "-b:a", "128k",
        "-ac", "2",
        "-compression_level", "0" // Fastest compression
      ]);
    }

    command
      .on("error", (err) => reject(err))
      .on("end", () => {
        if ("outPath" in config) {
          console.log(`Convertido: ${path.basename(config.outPath)}`);
        } else {
          console.log(`Convertido: ${config.filename}`);
          config.onEndCallback?.();
        }
        resolve();
      });

    if ("outPath" in config) {
      command.save(config.outPath);
    } else {
      command.pipe(config.outputStream, { end: true });
    }
  });
}

export function convertVideo(
  stream: any,
  format: VideoFormats,
  output: outputOptions,
  config: (ConfigSave | ConfigPipe) & { audioPath?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(stream as any);

    if (config.audioPath) {
      command
        .addInput(config.audioPath)
        .outputOptions([
          "-map 0:v",
          "-map 1:a",
        ]);
    }

    command.outputOptions(["-threads", "0"]).format(format);

    const isVideoCopy = config.videoCodec === 'copy';
    const isAudioCopy = config.audioCodec === 'copy';

    if (config.videoCodec) {
      command.videoCodec(config.videoCodec);
    }
    if (config.audioCodec) {
      command.audioCodec(config.audioCodec);
    }

    if (!isVideoCopy) {
      const crf = config.crf ?? config.quality ?? 24;
      const preset = config.preset ?? 'ultrafast';

      command.outputOptions([`-crf`, `${crf}`]);
      command.outputOptions([`-preset`, preset]);

      if (config.maxrate) command.outputOptions([`-maxrate`, config.maxrate]);
      if (config.bufsize) command.outputOptions([`-bufsize`, config.bufsize]);
      if (config.size) command.size(config.size);
      if (config.fps) command.outputFPS(config.fps);
    }

    if (!isAudioCopy) {
      const audioBitrate = config.audioBitrate ?? '192k';
      command.audioBitrate(audioBitrate);
    }

    command
      .on("error", (err) => reject(err))
      .on("end", () => {
        if ("outPath" in config) {
          console.log(`Vídeo convertido: ${path.basename(config.outPath)}`);
        } else {
          console.log(`Vídeo convertido: ${(config as ConfigPipe).filename}`);
          (config as ConfigPipe).onEndCallback?.();
        }
        resolve();
      });

    if ("outPath" in config) {
      command.save(config.outPath);
    } else {
      command.outputOptions([
        "-f", format,
        "-movflags", "frag_keyframe+empty_moov"
      ]);
      command.pipe((config as ConfigPipe).outputStream, { end: true });
    }
  });
}