import { createHash } from 'node:crypto';

export function ipHash(ip: string, salt: string): string {
  return createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);
}
