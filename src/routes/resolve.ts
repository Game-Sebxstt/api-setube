import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Static } from 'typebox';
import { ERROR_CATALOG } from '../lib/errors.js';
import { mapLimit } from '../lib/limit.js';
import { parseYouTubeUrl, thumbnailUrl, type ParsedUrl } from '../lib/youtube/url.js';
import { ErrorResponse } from '../schemas/common.js';
import { resolveBody, ResolveResponse, type ResolveResult } from '../schemas/resolve.js';

type Result = Static<typeof ResolveResult>;

const resolveRoute: FastifyPluginAsyncTypebox = async (app) => {
  const { config, yt } = app;
  const Body = resolveBody(config.maxResolveUrls);

  app.post(
    '/api/resolve',
    {
      bodyLimit: 131072,
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { body: Body, response: { 200: ResolveResponse, '4xx': ErrorResponse } },
    },
    async (req) => {
      const items = req.body.items;
      const parsed: (ParsedUrl | null)[] = items.map((it) => parseYouTubeUrl(it.url));

      const videoIds = parsed.flatMap((p) => (p?.kind === 'video' && p.videoId ? [p.videoId] : []));
      const playlistIds = [...new Set(parsed.flatMap((p) => (p?.kind === 'playlist' && p.playlistId ? [p.playlistId] : [])))];

      const [videoInfo, playlistInfo] = await Promise.all([
        yt.oembed.videos(videoIds),
        mapLimit(playlistIds, 8, async (id) => [id, await yt.oembed.playlist(id)] as const).then((e) => new Map(e)),
      ]);

      const results: Result[] = items.map((it, i) => {
        const p = parsed[i];
        const base = { id: it.id, url: it.url };
        if (!p) {
          return {
            ...base,
            kind: null,
            title: null,
            author: null,
            thumbnail: null,
            status: 'error',
            error: { code: 'INVALID_URL', message: ERROR_CATALOG.INVALID_URL.message },
          };
        }
        if (p.kind === 'playlist') {
          const info = playlistInfo.get(p.playlistId as string);
          return {
            ...base,
            kind: 'playlist',
            playlistId: p.playlistId as string,
            title: info?.title ?? null,
            author: info?.author ?? null,
            thumbnail: null,
            status: 'ok',
          };
        }
        const videoId = p.videoId as string;
        const info = videoInfo.get(videoId);
        const r: Result = {
          ...base,
          kind: 'video',
          videoId,
          ...(p.playlistId ? { playlistId: p.playlistId } : {}),
          title: info?.title ?? null,
          author: info?.author ?? null,
          thumbnail: thumbnailUrl(videoId),
          status: 'ok',
        };
        if (info?.error) {
          r.status = 'error';
          r.error = { code: 'VIDEO_UNAVAILABLE', message: ERROR_CATALOG.VIDEO_UNAVAILABLE.message };
        }
        return r;
      });
      return { results };
    },
  );
};

export default resolveRoute;
