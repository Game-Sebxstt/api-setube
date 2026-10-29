import { Type } from 'typebox';
import { SEARCH_QUERY_MAX } from '../lib/youtube/search.js';
import { Nullable } from './common.js';

// Se admite algo más que el máximo: la consulta se recorta tras quitar espacios y caracteres de control
export const SearchQuery = Type.Object(
  { q: Type.String({ minLength: 1, maxLength: SEARCH_QUERY_MAX * 2 }) },
  { additionalProperties: false },
);

export const SearchResponse = Type.Object(
  {
    query: Type.String(),
    items: Type.Array(
      Type.Object(
        {
          videoId: Type.String(),
          title: Nullable(Type.String()),
          author: Nullable(Type.String()),
          duration: Nullable(Type.Integer()),
          views: Nullable(Type.Integer()),
          live: Type.Boolean(),
          thumbnail: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
