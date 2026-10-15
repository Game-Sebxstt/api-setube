export type PotPing = { ok: true; version: string | null } | { ok: false; reason: 'timeout' | 'network' | 'status' | 'invalid'; status?: number };

export async function pingPotProvider(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<PotPing> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'status', status: res.status };
  }
  try {
    const body = (await res.json()) as { version?: unknown };
    return { ok: true, version: typeof body.version === 'string' ? body.version : null };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
