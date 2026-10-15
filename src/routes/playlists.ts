import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { AppError } from '../lib/errors.js';
import { parseYouTubeUrl } from '../lib/youtube/url.js';
import { ErrorResponse } from '../schemas/common.js';
import { PlaylistBody, PlaylistResponse } from '../schemas/playlists.js';

const playlistsRoute: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/api/playlists/resolve',
    {
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { body: PlaylistBody, response: { 200: PlaylistResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req) => {
      const parsed = parseYouTubeUrl(req.body.url);
      if (!parsed?.playlistId) throw new AppError('INVALID_URL');
      return app.yt.playlists.resolve(parsed.playlistId);
    },
  );
};

export default playlistsRoute;
