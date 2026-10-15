import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';

export function proxyDispatcher(proxy: string): Dispatcher {
  return new URL(proxy).protocol === 'socks5:' ? new Socks5ProxyAgent(proxy) : new ProxyAgent(proxy);
}

export type FetchImpl = (input: string, init: Record<string, unknown>) => Promise<Response>;

// Mismo paquete undici para fetch y dispatcher: mezclar el fetch global de Node con un agente
// de otra versión de undici no está soportado
export function proxiedFetch(dispatcher: Dispatcher, impl: FetchImpl = undiciFetch as unknown as FetchImpl): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    impl(String(input), { ...(init as Record<string, unknown> | undefined), dispatcher })) as typeof fetch;
}
