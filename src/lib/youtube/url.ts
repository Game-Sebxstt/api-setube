export type UrlKind = 'video' | 'playlist';

export interface ParsedUrl {
  kind: UrlKind;
  videoId?: string;
  playlistId?: string;
  canonicalUrl: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const HOSTS = new Set(['youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com']);
const PATH_PREFIXES = ['shorts', 'live', 'embed', 'v'];

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
export const playlistUrl = (playlistId: string) => `https://www.youtube.com/playlist?list=${playlistId}`;
export const thumbnailUrl = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export const isVideoId = (s: unknown): s is string => typeof s === 'string' && VIDEO_ID.test(s);
export const isPlaylistId = (s: unknown): s is string => typeof s === 'string' && PLAYLIST_ID.test(s);

function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  else if (h.startsWith('m.')) h = h.slice(2);
  return h;
}

export function parseYouTubeUrl(input: string): ParsedUrl | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s === '' || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = normalizeHost(u.hostname);
  if (!HOSTS.has(host)) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  let videoId: string | undefined;
  if (host === 'youtu.be') {
    const id = segs[0];
    if (segs.length >= 1 && isVideoId(id)) videoId = id;
    else return null;
  } else if (segs[0] === 'watch' && segs.length === 1) {
    const v = u.searchParams.get('v');
    if (v !== null) {
      if (!isVideoId(v)) return null;
      videoId = v;
    }
  } else if (segs[0] !== undefined && PATH_PREFIXES.includes(segs[0]) && segs.length >= 2) {
    const id = segs[1];
    if (!isVideoId(id)) return null;
    videoId = id;
  } else if (!(segs[0] === 'playlist' && segs.length === 1)) {
    return null;
  }

  const list = u.searchParams.get('list');
  const playlistId = list !== null && isPlaylistId(list) ? list : undefined;

  if (videoId) {
    return playlistId
      ? { kind: 'video', videoId, playlistId, canonicalUrl: watchUrl(videoId) }
      : { kind: 'video', videoId, canonicalUrl: watchUrl(videoId) };
  }
  if (playlistId) return { kind: 'playlist', playlistId, canonicalUrl: playlistUrl(playlistId) };
  return null;
}
