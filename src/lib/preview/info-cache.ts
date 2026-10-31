import type { MetadataService } from '../youtube/metadata.js';

type Json = Record<string, unknown>;

export interface InfoCacheOptions {
  /** Vida de cada entrada en memoria. */
  ttlMs?: number;
  /** Entradas como máximo; al pasarse se descarta la usada hace más tiempo. */
  max?: number;
  now?: () => number;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lo que necesita la escucha y el video en streaming: los formatos https (los únicos que se pueden abrir con Range)
 * sin la lista de `fragments`, que no se usa y es lo que más ocupa.
 */
export function slimInfo(info: Json): Json {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const slim = formats
    .filter((f): f is Json => isObj(f) && f.protocol === 'https')
    .map((f) => {
      if (!('fragments' in f)) return f;
      const { fragments: _drop, ...rest } = f;
      return rest;
    });
  return { ...info, formats: slim };
}

/**
 * Caché en memoria del info JSON ya descomprimido y parseado, por video. Cada segmento del video en streaming es una
 * petición: sin esta caché cada una leería y parsearía de Redis el info JSON completo (~1 MB). Las lecturas
 * simultáneas del mismo video comparten la misma lectura de Redis y `refresh` deja en la caché el info nuevo.
 * El objeto devuelto se comparte entre peticiones: no se debe modificar.
 */
export function createInfoCache(metadata: Pick<MetadataService, 'readInfoJson' | 'refresh'>, opts: InfoCacheOptions = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 50;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { info: Json; until: number }>();
  const reading = new Map<string, Promise<Json | null>>();
  // Sube cada vez que se olvida o se refresca algún video: una lectura de Redis empezada antes no pisa el dato nuevo
  // (como mucho, esa lectura no se guarda y la siguiente vuelve a Redis)
  let generation = 0;

  function put(videoId: string, info: Json): Json {
    entries.delete(videoId);
    entries.set(videoId, { info, until: now() + ttlMs });
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
    return info;
  }

  function hit(videoId: string): Json | null {
    const e = entries.get(videoId);
    if (!e) return null;
    if (e.until <= now()) {
      entries.delete(videoId);
      return null;
    }
    // Reinsertar la mueve al final: orden de uso para descartar la más antigua
    entries.delete(videoId);
    entries.set(videoId, e);
    return e.info;
  }

  return {
    async readInfoJson(videoId: string): Promise<Json | null> {
      const cached = hit(videoId);
      if (cached) return cached;
      const running = reading.get(videoId);
      if (running) return running;
      const g = generation;
      const p: Promise<Json | null> = metadata
        .readInfoJson(videoId)
        .then((info) => {
          if (!info) return null;
          const slim = slimInfo(info);
          return generation === g ? put(videoId, slim) : slim;
        })
        .finally(() => {
          if (reading.get(videoId) === p) reading.delete(videoId);
        });
      reading.set(videoId, p);
      return p;
    },
    async refresh(videoId: string): ReturnType<MetadataService['refresh']> {
      generation++;
      entries.delete(videoId);
      reading.delete(videoId);
      const r = await metadata.refresh(videoId);
      generation++;
      return { meta: r.meta, infoJson: put(videoId, slimInfo(r.infoJson)) };
    },
    forget(videoId: string): void {
      generation++;
      entries.delete(videoId);
      reading.delete(videoId);
    },
    get size(): number {
      return entries.size;
    },
  };
}

export type InfoCache = ReturnType<typeof createInfoCache>;

type Meta = Awaited<ReturnType<MetadataService['get']>>;

/**
 * Caché en memoria corta de la meta por video (por defecto 15 s). Cada segmento del video en streaming vuelve a mirar
 * si el video es un directo o pasa del límite de duración: sin esta caché cada uno leería y validaría la meta de Redis.
 * Las lecturas simultáneas comparten la misma promesa; los errores no se guardan (la siguiente vuelve a preguntar).
 * El objeto devuelto se comparte entre peticiones: no se debe modificar.
 */
export function createMetaCache(metadata: Pick<MetadataService, 'get'>, opts: InfoCacheOptions = {}) {
  const ttlMs = opts.ttlMs ?? 15_000;
  const max = opts.max ?? 100;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { meta: Meta; until: number }>();
  const reading = new Map<string, Promise<Meta>>();

  return {
    get(videoId: string): Promise<Meta> {
      const e = entries.get(videoId);
      if (e && e.until > now()) return Promise.resolve(e.meta);
      if (e) entries.delete(videoId);
      const running = reading.get(videoId);
      if (running) return running;
      const p = metadata.get(videoId).then((meta) => {
        entries.delete(videoId);
        entries.set(videoId, { meta, until: now() + ttlMs });
        while (entries.size > max) entries.delete(entries.keys().next().value as string);
        return meta;
      });
      const tracked = p.finally(() => {
        if (reading.get(videoId) === tracked) reading.delete(videoId);
      });
      tracked.catch(() => undefined);
      reading.set(videoId, tracked);
      return tracked;
    },
    get size(): number {
      return entries.size;
    },
  };
}

export type MetaCache = ReturnType<typeof createMetaCache>;
