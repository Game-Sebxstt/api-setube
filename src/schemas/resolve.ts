import { Type } from 'typebox';
import { CLIENT_ID_PATTERN, Nullable } from './common.js';

export const resolveBody = (maxUrls: number) =>
  Type.Object(
    {
      items: Type.Array(
        Type.Object(
          {
            id: Type.String({ pattern: CLIENT_ID_PATTERN }),
            url: Type.String({ minLength: 1, maxLength: 2048 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: maxUrls },
      ),
    },
    { additionalProperties: false },
  );

export const ResolveResult = Type.Object(
  {
    id: Type.String(),
    url: Type.String(),
    kind: Nullable(Type.Union([Type.Literal('video'), Type.Literal('playlist')])),
    videoId: Type.Optional(Type.String()),
    playlistId: Type.Optional(Type.String()),
    title: Nullable(Type.String()),
    author: Nullable(Type.String()),
    thumbnail: Nullable(Type.String()),
    status: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Union([Type.Literal('INVALID_URL'), Type.Literal('VIDEO_UNAVAILABLE'), Type.Literal('UPSTREAM_ERROR')]),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ResolveResponse = Type.Object({ results: Type.Array(ResolveResult) }, { additionalProperties: false });
