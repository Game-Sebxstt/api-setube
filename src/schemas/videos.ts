import { Type } from 'typebox';
import { Nullable, VideoId } from './common.js';

export const VideoParams = Type.Object({ videoId: VideoId }, { additionalProperties: false });

export const VideoResponse = Type.Object(
  {
    videoId: Type.String(),
    title: Nullable(Type.String()),
    author: Nullable(Type.String()),
    duration: Type.Integer(),
    thumbnail: Type.String(),
    description: Nullable(Type.String()),
    live: Type.Literal(false),
    audio: Type.Object(
      {
        sourceCodec: Type.String(),
        sourceAbrKbps: Nullable(Type.Number()),
        m4aNative: Type.Boolean(),
        preview: Type.Object({ aac: Type.Boolean(), opus: Type.Boolean() }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
    videoQualities: Type.Array(Type.Integer()),
    estimatedBytes: Type.Object(
      {
        mp3: Type.Object({ 128: Type.Number(), 192: Type.Number(), 320: Type.Number() }, { additionalProperties: false }),
        m4a: Nullable(Type.Number()),
        wav: Type.Number(),
        mp4: Type.Record(Type.String(), Nullable(Type.Number())),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object({ audioOk: Type.Boolean(), videoOk: Type.Boolean() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
