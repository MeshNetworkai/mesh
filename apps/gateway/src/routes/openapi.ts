import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import type { AppContext } from '../context.js';

/**
 * GET /openapi.json — the OpenAPI 3.1 description of this gateway, parsed once from
 * `apps/gateway/openapi.yaml` (the single source; the web app bundles the same file for /api).
 * The first `servers[]` entry is rewritten to AUTH_URI when a real domain is configured, so the
 * document a deployment serves points at itself.
 */
export function loadOpenApi(ctx: Pick<AppContext, 'env'>): Record<string, unknown> {
  const file = new URL('../../openapi.yaml', import.meta.url);
  const doc = parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { servers?: Array<{ url: string; description?: string }> };
  // AUTH_URI is derived from AUTH_DOMAIN (localhost:8787 in dev); only trust it once a real domain is configured.
  const own = ctx.env.AUTH_URI?.replace(/\/$/, '');
  if (own && !/localhost|127\.0\.0\.1/.test(own) && Array.isArray(doc.servers) && doc.servers.length) {
    doc.servers = [{ url: own, description: 'This gateway' }, ...doc.servers.slice(1)];
  }
  return doc;
}

export async function openapiRoutes(app: FastifyInstance, ctx: AppContext) {
  let cached: Record<string, unknown> | null = null;
  app.get('/openapi.json', async (_req, reply) => {
    cached ??= loadOpenApi(ctx);
    reply.header('cache-control', 'public, max-age=300');
    return cached;
  });
}
