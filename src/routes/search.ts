import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { AppError } from '../lib/errors.js';
import { ErrorResponse } from '../schemas/common.js';
import { SearchQuery, SearchResponse } from '../schemas/search.js';

const searchRoute: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/search',
    {
      config: { rateLimit: { max: app.config.searchRateLimitMax, timeWindow: 60_000 } },
      schema: { querystring: SearchQuery, response: { 200: SearchResponse, '4xx': ErrorResponse, '5xx': ErrorResponse } },
    },
    async (req, reply) => {
      if (!app.config.searchEnabled) throw new AppError('SERVICE_UNAVAILABLE');
      const result = await app.yt.search.search(req.query.q);
      reply.header('cache-control', 'public, max-age=300');
      return result;
    },
  );
};

export default searchRoute;
