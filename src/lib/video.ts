import ytdl from "@distube/ytdl-core";
import { AgentManager } from "../managers/agent.manager.js";
import { Innertube } from 'youtubei.js';
import { normalizeYouTubeUrl } from "./utils.js";

const agentManager = AgentManager.getInstance();

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
];

const cookieCollections = [
  {
    'CONSENT': 'YES+cb.20210328-17-p0.en+FX+030',
    'VISITOR_INFO1_LIVE': 'y4VIyEZEHSw',
    'LOGIN_INFO': 'AFmmF2swRQIhAL6-VvmWsEHJL6_U8BYdVdpD7kTDjr-qZm-KBizHDuDpAiA9OYnc1lIDhcg6hb8Jb6DkDvjvuRx9MgWl2rF4midb5A:QUQ3MjNmeWo2TFBTTnNhWDBSNE5wUV9OSTVPZ2RnM1dYMnFUTzJuZVlWdXd2aDJyRG5ZMlNsR1NsWWJlX0JqOHRyZVhZS3JRYURQcnFTMVRlZXdHM1RqaElWSGUtYWNZdV9wS0NFWHJFNXZHcUlDQWRqTnJrTXJIYVNWVW9EV2tmd2JNdm5iakFKdlBvWnNfdmtGRkZDdGtCZUw5VmlybkFn',
    'PREF': 'tz=America.Mexico_City&f4=4000000&f6=40000000'
  },
  {
    'CONSENT': 'PENDING+915',
    'VISITOR_INFO1_LIVE': 'oDVSWfNmXb0',
    'LOGIN_INFO': 'AFmmF2swRQIhAPmhUT-7DKlG0cKT5k_SPDCxmGyCQRCmTWT4K4sqEQHcAiAD5GpXuzYKBOXx2pTAI9JjXR-2X5Y34ECOBKRyZ0M7vg:QUQ3MjNmeUNKS2F0T2JzU0RDcTRJVnJrYnRLTUVmMUo1UlJKVUVTN0tRU3dfZTRjTUhVYktxMjJYWTFHUFd0bFBNanpTdnRvVDRJX1FoWnRsWkZWeXRGNTFkM0czT2VsQUx0Y3lRbldNMXZkWXY3eU1TRmdpNkVfZDh2dWJiVlBIczVwZEVmbVo4UFhkRmdnQTl2UTB2VGhyejVXc0ZGMHBN',
    'PREF': 'f4=4000000&f5=30000&tz=America.Mexico_City'
  }
];

const getRotatingHeaders = (index = -1): Record<string, string> => {
  const agentIndex = index >= 0 ? index % userAgents.length : Math.floor(Math.random() * userAgents.length);
  
  return {
    'User-Agent': userAgents[agentIndex],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,es-MX;q=0.8,es;q=0.7',
    'Referer': 'https://www.youtube.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  };
};

const getRotatingCookies = (index = -1): Record<string, string> => {
  const cookieIndex = index >= 0 ? index % cookieCollections.length : Math.floor(Math.random() * cookieCollections.length);
  return cookieCollections[cookieIndex];
};

const youtubeConfigs = [
  { client_type: 'WEB', retriever: 'WEB', agent_index: 0, cookie_index: 0 },
  { client_type: 'ANDROID', retriever: 'WEB', agent_index: 1, cookie_index: 0 },
  { client_type: 'TVHTML5', retriever: 'WEB', agent_index: 2, cookie_index: 1 },
  { client_type: 'WEB', retriever: 'ANDROID', agent_index: 3, cookie_index: 1 },
  { client_type: 'ANDROID', retriever: 'ANDROID', agent_index: 4, cookie_index: 1 }
];

const isValidYouTubeID = (id: string): boolean => {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
};

const attemptToFixYouTubeUrl = (url: string): string => {
  try {
    if (url.includes('youtu.be/') && url.split('youtu.be/')[1].length < 11) {
      console.log('URL de youtu.be detectada como truncada');
      return url;
    }
    
    if ((url.includes('youtube.com/watch?v=') || url.includes('music.youtube.com/watch?v=')) && 
      url.includes('v=') && url.split('v=')[1]?.length < 11) {
      console.log('URL de youtube.com detectada como truncada');

      const baseUrl = url.split('&')[0];
      if (baseUrl !== url) {
        console.log('Intentando usar solo la URL base sin parámetros adicionales');
        return baseUrl;
      }
    }
    
    return url;
  } catch (e) {
    console.error('Error intentando reparar URL:', e);
    return url;
  }
};


const extractVideoID = (url: string): string => {
  try {
    const normalizedUrl = normalizeYouTubeUrl(url) || url;
    let videoId = '';
    
    const patterns = [
      { regex: /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/, group: 1 },
      { regex: /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/, group: 1 },
      { regex: /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/, group: 1 },
      { regex: /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/, group: 1 },
      { regex: /music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/, group: 1 }
    ];
    
    for (const pattern of patterns) {
      const match = normalizedUrl.match(pattern.regex);
      if (match && match[pattern.group]) {
        videoId = match[pattern.group];
        break;
      }
    }

    if (!videoId) {
      const urlObj = new URL(normalizedUrl);
      
      if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('music.youtube.com')) {
        videoId = urlObj.searchParams.get('v') || '';
      } else if (urlObj.hostname.includes('youtu.be')) {
        videoId = urlObj.pathname.substring(1);
      }
    }
    
    return videoId;
  } catch (e) {
    console.error('Error extrayendo ID de video:', e);
    return '';
  }
};

export const getVideoInfo = async (url: string): Promise<any> => {
  try {
    const fixedUrl = attemptToFixYouTubeUrl(url);
    let videoId = extractVideoID(fixedUrl);
    
    if (!videoId || !isValidYouTubeID(videoId)) {
      console.error(`ID inválido o no extraído: "${videoId}", longitud: ${videoId?.length || 0}`);
      throw new Error(`ID de video inválido o URL malformada: ${url}`);
    }

    console.log(`Intentando obtener información para video ID: ${videoId} de URL: ${fixedUrl}`);
    
    let lastError = null;
    let videoInfo = null;
    
    for (const config of youtubeConfigs) {
      try {
        console.log(`Intento con configuración: ${JSON.stringify(config)}`);
        
        const headers = getRotatingHeaders(config.agent_index);
        const cookies = getRotatingCookies(config.cookie_index);
        
        const youtube = await Innertube.create({
          client_type: config.client_type as any,
          generate_session_locally: true
        });
        
        if (youtube.session && (youtube.session as any).cookies) {
          try {

            Object.entries(cookies).forEach(([key, value]) => {
              (youtube.session as any).cookies.set(key, value);
            });
            console.log('Cookies aplicadas correctamente');
          } catch (cookieError) {
            console.warn('No se pudieron aplicar cookies:', cookieError);
          }
        }

        let video;
        
        if (config.retriever === 'WEB') {
          video = await youtube.getBasicInfo(videoId);
        } else {

          video = await youtube.getInfo(videoId);
        }
        
        if (!video || !video.basic_info) {
          throw new Error('Respuesta incompleta de youtubei.js');
        }
        
        videoInfo = video;
        console.log(`Información obtenida exitosamente con configuración: ${JSON.stringify(config)}`);
        break;
      } catch (err: any) {
        lastError = err;
        console.error(`Intento fallido con configuración ${JSON.stringify(config)}: ${err.message || 'Error desconocido'}`);
      }
    }
    
    if (!videoInfo || !videoInfo.basic_info || !videoInfo.basic_info.title) {
      throw new Error(`No se pudo obtener información del video después de múltiples intentos: ${lastError instanceof Error ? lastError.message : 'Error desconocido'}`);
    }

    const { basic_info, streaming_data } = videoInfo;
    const { title, short_description, thumbnail } = basic_info;
    
    const formats = [
      ...new Set(streaming_data?.formats?.map(f => f.quality_label) || []), 
      ...new Set(streaming_data?.adaptive_formats?.map(f => f.quality_label) || [])
    ].filter((f) => f !== undefined && f !== null).sort((a, b) => {
      const numA = parseInt(a.replace(/[^0-9]/g, ''));
      const numB = parseInt(b.replace(/[^0-9]/g, ''));
      return numB - numA;
    });
    
    const thumbnailCurrent = thumbnail?.sort((a, b) => b.width - a.width)[0];

    const payload = {
      url,
      title,
      description: short_description || null,
      thumbnail: thumbnailCurrent,
      qualities: formats.length > 0 ? formats : ['720p', '480p', '360p']
    };

    return payload;
  } catch (error: any) {
    console.error(`Error al obtener información del video con youtubei.js: ${error.message}`);
    
    try {
      console.log(`Intentando método fallback con ytdl-core para URL: ${url}`);

      let ytdlError;
      let videoDetails, formats;
      
      for (let i = 0; i < userAgents.length; i++) {
        try {
          const headers = getRotatingHeaders(i);
          console.log(`Intento ytdl-core ${i+1}/${userAgents.length} con User-Agent: ${headers['User-Agent'].substring(0, 20)}...`);

          const cookies = getRotatingCookies(i % cookieCollections.length);
          const cookieString = Object.entries(cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
          
          headers['Cookie'] = cookieString;

          const result = await ytdl.getInfo(url, { 
            requestOptions: { headers }, 
            agent: agentManager.getAgent() 
          });
          
          videoDetails = result.videoDetails;
          formats = result.formats;
          
          console.log(`Éxito con ytdl-core en el intento ${i+1}`);
          break;
        } catch (err: unknown) {
          ytdlError = err;
          console.error(`Intento ${i+1} fallido con ytdl-core: ${err instanceof Error ? err.message : 'Error desconocido'}`);
        }
      }

      if (!videoDetails || !formats) {
        throw new Error(`Todos los intentos con ytdl-core fallaron: ${ytdlError instanceof Error ? ytdlError.message : 'Error desconocido'}`);
      }
      
      const { title, description, thumbnails } = videoDetails;
      const qualities = [...new Set(formats
        .filter(f => f.qualityLabel && f.container === 'mp4' && !f.hasAudio)
        .map(f => f.qualityLabel)
        .sort((a, b) => parseInt(b) - parseInt(a))
      )];
  
      const bestThumbnail = thumbnails[thumbnails.length - 1];
      return { 
        url, 
        title, 
        description, 
        thumbnail: bestThumbnail, 
        qualities,
        source: 'ytdl-fallback' 
      };
    } catch (ytdlError: any) {
      console.error(`También falló el fallback con ytdl-core: ${ytdlError.message || 'Error desconocido'}`);
      throw new Error(`No se pudo obtener la información del video: ${error.message || 'Error desconocido'}`);
    }
  }
};

export const downloadVideoStream = async (url: string, quality: VideoQuality = 'highest') => {
  try {
    const info = await ytdl.getInfo(url, { agent: agentManager.getAgent() });

    const videoFormat = ytdl.chooseFormat(info.formats, {
      quality: quality === 'highest' ? 'highestvideo' : undefined,
      filter: (format) => {
        const qualityMatch = quality === 'highest' ? true : format.qualityLabel?.startsWith(quality);
        return !!(format.container === "mp4" && !format.hasAudio && qualityMatch);
      },
    });

    if (!videoFormat) {
      throw new Error(`No se encontró un formato de video MP4 para la calidad '${quality}'.`);
    }

    const audioFormat = ytdl.chooseFormat(info.formats, {
      quality: "highestaudio",
      filter: "audioonly",
    });

    if (!audioFormat) {
      throw new Error("No se encontró un formato de audio adecuado.");
    }

    const videoStream = ytdl(url, { format: videoFormat, agent: agentManager.getAgent() });
    const audioStream = ytdl(url, { format: audioFormat, agent: agentManager.getAgent() });

    return { info, videoStream, audioStream };
  } catch (error: any) {
    throw new Error(`Error al descargar el video: ${error.message}`);
  }
};