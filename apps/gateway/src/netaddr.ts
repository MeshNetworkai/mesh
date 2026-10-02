import { BlockList, isIP } from 'node:net';

/**
 * CIDR allowlists for ADMIN_IP_ALLOWLIST and TRUSTED_PROXY_CIDRS. Built on node's BlockList so
 * IPv4, IPv6 and IPv4-mapped IPv6 (`::ffff:10.0.0.1`, what a dual-stack listener reports) all match.
 */

/** Loopback + RFC 1918 + ULA: the reverse proxy on the same host / docker network. */
export const DEFAULT_TRUSTED_PROXY_CIDRS = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/** Split a comma/space separated env value into CIDR strings (bare addresses get /32 or /128). */
export function parseCidrList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.includes('/')) return s;
      const fam = isIP(s);
      if (fam === 4) return `${s}/32`;
      if (fam === 6) return `${s}/128`;
      throw new Error(`not an IP address or CIDR: ${s}`);
    });
}

export interface IpMatcher {
  cidrs: string[];
  /** True when `ip` is inside one of the CIDRs. Unparseable input is never a match. */
  has(ip: string | undefined | null): boolean;
}

export function cidrMatcher(cidrs: string[]): IpMatcher {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bitsRaw] = c.split('/');
    const fam = isIP(addr);
    if (!fam) throw new Error(`invalid CIDR: ${c}`);
    const bits = bitsRaw === undefined ? (fam === 4 ? 32 : 128) : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > (fam === 4 ? 32 : 128)) throw new Error(`invalid CIDR prefix: ${c}`);
    list.addSubnet(addr, bits, fam === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    cidrs,
    has(ip) {
      if (!ip) return false;
      const fam = isIP(ip);
      if (!fam) return false;
      try {
        return list.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
      } catch {
        return false;
      }
    },
  };
}
