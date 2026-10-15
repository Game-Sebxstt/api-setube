import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientIp, ipHash, normalizeIp } from '../../src/lib/ip.js';

const cfg = { clientIpHeader: 'cf-connecting-ip' };

describe('clientIp', () => {
  it('usa la cabecera configurada si trae una IP válida', () => {
    expect(clientIp({ ip: '10.0.0.1', headers: { 'cf-connecting-ip': ' 198.51.100.7 ' } }, cfg)).toBe('198.51.100.7');
    expect(clientIp({ ip: '10.0.0.1', headers: { 'cf-connecting-ip': '2001:db8::1' } }, cfg)).toBe('2001:db8::1');
  });

  it('cabecera inválida, ausente o sin configurar → req.ip', () => {
    expect(clientIp({ ip: '10.0.0.1', headers: { 'cf-connecting-ip': '1.2.3' } }, cfg)).toBe('10.0.0.1');
    expect(clientIp({ ip: '10.0.0.1', headers: {} }, cfg)).toBe('10.0.0.1');
    expect(clientIp({ ip: '10.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.7' } }, { clientIpHeader: null })).toBe('10.0.0.1');
  });

  it('cabecera repetida → primer valor', () => {
    const headers = { 'cf-connecting-ip': ['198.51.100.8', '198.51.100.9'] } as unknown as Record<string, string>;
    expect(clientIp({ ip: '10.0.0.1', headers }, cfg)).toBe('198.51.100.8');
  });
});

describe('ipHash / normalizeIp', () => {
  it('IPv4 conserva sha256(salt + ip)', () => {
    expect(ipHash('1.2.3.4', 's')).toBe(createHash('sha256').update('s1.2.3.4').digest('hex').slice(0, 16));
  });

  it('IPv6 del mismo /64 comparten hash; /64 distintos no', () => {
    expect(ipHash('2001:db8:1:2::1', 's')).toBe(ipHash('2001:0db8:0001:0002:ffff:eeee:dddd:cccc', 's'));
    expect(ipHash('2001:db8:1:2::1', 's')).not.toBe(ipHash('2001:db8:1:3::1', 's'));
    expect(normalizeIp('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
  });

  it('IPv4 mapeada en IPv6 equivale a la IPv4', () => {
    expect(ipHash('::ffff:1.2.3.4', 's')).toBe(ipHash('1.2.3.4', 's'));
  });
});
