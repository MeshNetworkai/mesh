import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_CACHE_MS } from '../src/routes/install.js';
import { ADMIN, testServer } from './helpers.js';

const SHA = 'a'.repeat(64);
const RELEASE = {
  version: '0.2.0',
  bundleUrl: 'https://github.com/MeshNetworkai/mesh/releases/download/v0.2.0/mesh-node.js',
  bundleSha256: SHA,
  tarballUrl: 'https://github.com/MeshNetworkai/mesh/releases/download/v0.2.0/mesh-node-0.2.0-darwin-arm64.tar.gz',
  tarballSha256: 'b'.repeat(64),
  dmgUrl: 'https://github.com/MeshNetworkai/mesh/releases/download/v0.2.0/MeshNode-0.2.0-arm64.dmg',
  dmgSha256: 'c'.repeat(64),
  publishedAt: '2026-10-03T12:00:00.000Z',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mesh-install-'));
  dirs.push(d);
  return d;
};

/** A fetch that answers one URL with JSON and counts calls. */
function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('GET /install/latest.json', () => {
  it('404 no_release when nothing is published', async () => {
    const dir = tmp();
    const { app } = await testServer({ env: { UPDATE_LATEST_PATH: join(dir, 'latest.json') } });
    const res = await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'no_release' });
    await app.close();
  });

  it('serves the static file written by POST /admin/release (audited) and clears its cache', async () => {
    const dir = tmp();
    const file = join(dir, 'latest.json');
    const { app } = await testServer({ env: { UPDATE_LATEST_PATH: file } });
    // Prime the cache with a 404 so we know the POST invalidates it.
    expect((await app.inject({ method: 'GET', url: '/install/latest.json' })).statusCode).toBe(404);

    const denied = await app.inject({ method: 'POST', url: '/admin/release', payload: RELEASE });
    expect(denied.statusCode).toBe(401);

    const bad = await app.inject({ method: 'POST', url: '/admin/release', headers: ADMIN, payload: { ...RELEASE, bundleSha256: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(existsSync(file)).toBe(false);

    const ok = await app.inject({ method: 'POST', url: '/admin/release', headers: ADMIN, payload: { ...RELEASE, version: 'v0.2.0' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, file, release: { version: '0.2.0' } });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: '0.2.0', bundleSha256: SHA });

    const res = await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.json()).toEqual({ ...RELEASE, version: '0.2.0' });

    const audit = app.ctx.db.prepare(`SELECT action FROM admin_actions WHERE action = 'release'`).all() as Array<{ action: string }>;
    expect(audit).toHaveLength(1);

    const view = await app.inject({ method: 'GET', url: '/admin/release', headers: ADMIN });
    expect(view.json()).toMatchObject({ release: { version: '0.2.0' }, source: file });
    await app.close();
  });

  it('a static file with a bad shape is a 404 with the reason, not a 500', async () => {
    const dir = tmp();
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify({ version: '1.0.0', bundleUrl: 'not a url', bundleSha256: SHA }));
    const { app } = await testServer({ env: { UPDATE_LATEST_PATH: file } });
    const res = await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/bundleUrl/);
    await app.close();
  });

  it('proxies UPDATE_LATEST_URL with a 60 s cache and refuses POST /admin/release while proxying', async () => {
    const { f, calls } = fakeFetch(RELEASE);
    let t = 1_000_000;
    const { app } = await testServer({ env: { UPDATE_LATEST_URL: 'https://web.example/downloads/latest.json' }, install: { fetchImpl: f, now: () => t } });
    const a = await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(RELEASE);
    await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(calls).toEqual(['https://web.example/downloads/latest.json']); // cached
    t += LATEST_CACHE_MS + 1;
    await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(calls).toHaveLength(2);

    const post = await app.inject({ method: 'POST', url: '/admin/release', headers: ADMIN, payload: RELEASE });
    expect(post.statusCode).toBe(409);
    expect(post.json().error).toBe('upstream_configured');
    await app.close();
  });

  it('upstream failure → 404 no_release carrying the status, cached briefly', async () => {
    const { f, calls } = fakeFetch({ error: 'down' }, 503);
    const { app } = await testServer({ env: { UPDATE_LATEST_URL: 'https://web.example/downloads/latest.json' }, install: { fetchImpl: f } });
    const res = await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/503/);
    await app.inject({ method: 'GET', url: '/install/latest.json' });
    expect(calls).toHaveLength(1);
    await app.close();
  });
});

describe('GET /install/mesh-node.js', () => {
  it('serves the bundle file when present (dev)', async () => {
    const dir = tmp();
    const bundle = join(dir, 'mesh-node.js');
    writeFileSync(bundle, '#!/usr/bin/env node\nconsole.log("hi")\n');
    const { app } = await testServer({ env: { NODE_BUNDLE_PATH: bundle } });
    const res = await app.inject({ method: 'GET', url: '/install/mesh-node.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.body.startsWith('#!/usr/bin/env node')).toBe(true);
    await app.close();
  });

  it('redirects to the released bundleUrl when the local file is missing (prod)', async () => {
    const dir = tmp();
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(RELEASE));
    const { app } = await testServer({ env: { NODE_BUNDLE_PATH: join(dir, 'missing.js'), UPDATE_LATEST_PATH: file } });
    const res = await app.inject({ method: 'GET', url: '/install/mesh-node.js' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(RELEASE.bundleUrl);
    await app.close();
  });

  it('404 bundle_unavailable with a hint when neither exists', async () => {
    const dir = tmp();
    const { app } = await testServer({ env: { NODE_BUNDLE_PATH: join(dir, 'missing.js'), UPDATE_LATEST_PATH: join(dir, 'latest.json') } });
    const res = await app.inject({ method: 'GET', url: '/install/mesh-node.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'bundle_unavailable' });
    expect(res.json().message).toContain('pnpm --filter node-agent build');
    await app.close();
  });
});
