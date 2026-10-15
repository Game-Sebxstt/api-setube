import { Type } from 'typebox';
import { Nullable } from './common.js';

export const PlaylistBody = Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false });

export const PlaylistResponse = Type.Object(
  {
    playlistId: Type.String(),
    title: Nullable(Type.String()),
    thumbnail: Nullable(Type.String()),
    author: Nullable(Type.String()),
    count: Type.Integer(),
    truncated: Type.Boolean(),
    skipped: Type.Integer(),
    items: Type.Array(
      Type.Object(
        {
          videoId: Type.String(),
          title: Nullable(Type.String()),
          duration: Nullable(Type.Integer()),
          thumbnail: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
