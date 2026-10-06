import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { markAdminAudited, requireAdmin } from '../context.js';
import { recordAdminAction } from '../db.js';

/**
 * Node distribution endpoints (docs/DISTRIBUTION.md):
 *
 *   GET  /install/mesh-node.js   the one-file agent bundle. Served from NODE_BUNDLE_PATH
 *                                (default apps/node-agent/dist/mesh-node.js, dev); when the file is
 *                                missing and latest.json is known, 302 to its bundleUrl (prod).
 *   GET  /install/latest.json    {version, bundleUrl, bundleSha256, tarballUrl, dmgUrl, ..., publishedAt}
 *                                proxied from UPDATE_LATEST_URL (60 s cache) or read from the static
 *                                file at UPDATE_LATEST_PATH. `mesh-node update` and the menu-bar app read it.
 *   POST /admin/release          writes that static file (admin token; audited).
 *
 * install-node.sh fetches the bundle from here first, then falls back to <web>/mesh-node.js.
 */

const SHA = z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be 64 hex characters').transform((s) => s.toLowerCase());
const HTTP_URL = z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be http(s)');

export const ReleaseBody = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .transform((v) => v.replace(/^v/, '')),
    bundleUrl: HTTP_URL,
    bundleSha256: SHA,
    tarballUrl: HTTP_URL.optional(),
    tarballSha256: SHA.optional(),
    dmgUrl: HTTP_URL.optional(),
    dmgSha256: SHA.optional(),
    notes: z.string().max(2000).optional(),
    publishedAt: z.string().datetime().optional(),
    // written by the release workflow; informational
    channel: z.string().max(32).optional(),
    minMacOS: z.string().max(32).optional(),
    arch: z.string().max(32).optional(),
  })
  .passthrough();

export type Release = z.infer<typeof ReleaseBody> & { publishedAt: string };

export const LATEST_CACHE_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));

/** Default bundle location: the node-agent workspace build next to this package (dev / monorepo deploys). */
export function bundlePath(ctx: Pick<AppContext, 'env'>): string {
  return ctx.env.NODE_BUNDLE_PATH ?? resolve(here, '../../../node-agent/dist/mesh-node.js');
}

/** Default latest.json location: next to the SQLite file so the data volume carries it. */
export function latestPath(ctx: Pick<AppContext, 'env'>): string {
  if (ctx.env.UPDATE_LATEST_PATH) return ctx.env.UPDATE_LATEST_PATH;
  const db = ctx.env.MESH_DB_PATH;
  const dir = db === ':memory:' ? './data' : dirname(db);
  return resolve(dir, 'latest.json');
}

export function readLatestFile(file: string): Release | null {
  if (!existsSync(file)) return null;
  const parsed = ReleaseBody.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return { ...parsed.data, publishedAt: parsed.data.publishedAt ?? statSync(file).mtime.toISOString() };
}

export function writeLatestFile(file: string, release: Release): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(release, null, 2) + '\n');
  renameSync(tmp, file);
}

export interface InstallOptions {
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function installRoutes(app: FastifyInstance, ctx: AppContext, opts: InstallOptions = {}) {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const guard = requireAdmin(ctx);
  let cache: { at: number; release: Release | null; error?: string } | null = null;

  async function fetchUpstream(url: string): Promise<Release> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await f(url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'mesh-gateway' } });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const parsed = ReleaseBody.safeParse(await res.json());
      if (!parsed.success) throw new Error(`${url}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      return { ...parsed.data, publishedAt: parsed.data.publishedAt ?? new Date(now()).toISOString() };
    } finally {
      clearTimeout(t);
    }
  }

  /** Current release or null; upstream errors are cached for the TTL too (one log line per minute, not per node). */
  async function latest(): Promise<{ release: Release | null; error?: string }> {
    if (cache && now() - cache.at < LATEST_CACHE_MS) return cache;
    let next: { at: number; release: Release | null; error?: string };
    try {
      const release = ctx.env.UPDATE_LATEST_URL ? await fetchUpstream(ctx.env.UPDATE_LATEST_URL) : readLatestFile(latestPath(ctx));
      next = { at: now(), release };
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'latest.json unavailable');
      next = { at: now(), release: null, error: (err as Error).message };
    }
    cache = next;
    return next;
  }

  app.get('/install/latest.json', async (_req, reply) => {
    const { release, error } = await latest();
    reply.header('cache-control', 'public, max-age=60');
    if (!release) {
      return reply.code(404).send({
        error: 'no_release',
        message: error ? `release information unavailable: ${error}` : 'no release published yet (POST /admin/release or set UPDATE_LATEST_URL)',
        statusCode: 404,
      });
    }
    return release;
  });

  app.get('/install/mesh-node.js', async (_req, reply) => {
    const file = bundlePath(ctx);
    if (existsSync(file)) {
      reply.header('content-type', 'text/javascript; charset=utf-8');
      reply.header('cache-control', 'no-cache');
      reply.header('content-disposition', 'inline; filename="mesh-node.js"');
      return reply.send(readFileSync(file));
    }
    const { release } = await latest();
    if (release) return reply.redirect(release.bundleUrl, 302);
    return reply.code(404).send({
      error: 'bundle_unavailable',
      message: `no bundle at ${file} and no release published; build it (pnpm --filter node-agent build) or set NODE_BUNDLE_PATH / UPDATE_LATEST_URL`,
      statusCode: 404,
    });
  });

  /** Publish (or correct) the current release by hand; the release workflow normally does this via latest.json on the web host. */
  app.post('/admin/release', { preHandler: guard, bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (ctx.env.UPDATE_LATEST_URL) {
      return reply.code(409).send({ error: 'upstream_configured', message: `latest.json is proxied from ${ctx.env.UPDATE_LATEST_URL}; unset UPDATE_LATEST_URL to publish from this gateway`, statusCode: 409 });
    }
    const parsed = ReleaseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const release: Release = { ...parsed.data, publishedAt: parsed.data.publishedAt ?? new Date(now()).toISOString() };
    const file = latestPath(ctx);
    writeLatestFile(file, release);
    cache = null;
    markAdminAudited(req);
    recordAdminAction(ctx.db, 'release', { version: release.version, bundleUrl: release.bundleUrl, bundleSha256: release.bundleSha256, file, requestId: req.id });
    return { ok: true, file, release };
  });

  app.get('/admin/release', { preHandler: guard }, async () => {
    const { release, error } = await latest();
    return { release, error: error ?? null, source: ctx.env.UPDATE_LATEST_URL ?? latestPath(ctx), bundle: { path: bundlePath(ctx), present: existsSync(bundlePath(ctx)) } };
  });
}
