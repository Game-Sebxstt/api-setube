import { Type, type TSchema } from 'typebox';
import { ERROR_CODES } from '../lib/errors.js';

export const VIDEO_ID_PATTERN = '^[A-Za-z0-9_-]{11}$';
export const PLAYLIST_ID_PATTERN = '^[A-Za-z0-9_-]{2,64}$';
export const ITEM_ID_PATTERN = '^i\\d{1,3}$';
export const CLIENT_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

export const VideoId = Type.String({ pattern: VIDEO_ID_PATTERN });
export const PlaylistId = Type.String({ pattern: PLAYLIST_ID_PATTERN });
export const JobId = Type.String({ format: 'uuid' });
export const ItemId = Type.String({ pattern: ITEM_ID_PATTERN });

export const ErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union(ERROR_CODES.map((c) => Type.Literal(c))),
        message: Type.String(),
        details: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
    requestId: Type.String(),
  },
  { additionalProperties: false },
);

export const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
