export interface YtdlpNet {
  potProviderUrl: string | null;
  proxy: string | null;
}

export const POT_EXTRACTOR = 'youtubepot-bgutilhttp';
export const POT_PLAYER_CLIENTS = 'youtube:player_client=default,mweb';

export function ytdlpNetArgs(n: YtdlpNet): string[] {
  return [
    ...(n.proxy ? ['--proxy', n.proxy] : []),
    // Con provider: mweb con PO token de GVS (lo que recomienda el PO Token Guide), sumado a los
    // clientes por defecto. Sin provider el plugin probaría http://127.0.0.1:4416 en cada extracción,
    // así que se desactivan los plugins.
    ...(n.potProviderUrl
      ? ['--extractor-args', `${POT_EXTRACTOR}:base_url=${n.potProviderUrl}`, '--extractor-args', POT_PLAYER_CLIENTS]
      : ['--no-plugin-dirs']),
  ];
}

// scheme://host:port, sin usuario, contraseña, ruta ni query
export function redactUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const auth = u.username || u.password ? '[redacted]@' : '';
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return '[invalid]';
  }
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

export function scrubCredentials(line: string): string {
  return line.replace(URL_CREDENTIALS, '$1[redacted]@');
}
