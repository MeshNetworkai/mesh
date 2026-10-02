import type { FastifyReply, FastifyRequest } from 'fastify';

export const GEO_BLOCKED_PREFIXES = ['/v1', '/auth'];

/** Country code from the CDN/proxy, or null when none was supplied. */
export function requestCountry(headers: Record<string, string | string[] | undefined>): string | null {
  for (const name of ['cf-ipcountry', 'x-country']) {
    const v = headers[name];
    const s = (Array.isArray(v) ? v[0] : v)?.trim().toUpperCase();
    if (s && s !== 'XX' && s !== 'T1') return s; // Cloudflare uses XX=unknown, T1=Tor
  }
  return null;
}

export function isGeoBlockedPath(url: string): boolean {
  const path = url.split('?')[0];
  return GEO_BLOCKED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * onRequest hook. Returns 451 for /v1 and /auth when the proxy-reported country is in
 * `blocked`. Only runs when `enforce` is true (production), so dev never trips over it.
 * `trustedPeer(ip)` says whether the TCP peer is a proxy we believe (TRUSTED_PROXY_CIDRS);
 * country headers from anyone else are ignored, so a direct client cannot pick its own country.
 * Omitted = trust every peer (back-compat for callers that only pass enforce/blocked).
 */
export function geoBlockHook(opts: { enforce: boolean; blocked: string[]; trustedPeer?: (ip: string | undefined) => boolean }) {
  const blocked = new Set(opts.blocked.map((c) => c.toUpperCase()));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!opts.enforce || blocked.size === 0) return;
    if (!isGeoBlockedPath(req.url)) return;
    if (opts.trustedPeer && !opts.trustedPeer(req.socket?.remoteAddress ?? undefined)) {
      req.log.debug({ peer: req.socket?.remoteAddress }, 'geo header ignored: peer is not a trusted proxy');
      return;
    }
    const country = requestCountry(req.headers);
    if (!country || !blocked.has(country)) return;
    const message = `Mesh is not available in your region (${country}). Access to the API and sign-in is blocked for legal reasons.`;
    reply.code(451);
    if (req.url.startsWith('/v1')) {
      reply.send({ error: { message, type: 'permission_error', code: 'region_blocked', param: null } });
    } else {
      reply.send({ error: 'region_blocked', message, country });
    }
    return reply;
  };
}
