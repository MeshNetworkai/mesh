import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/log.js';
import { applyUpdate, checkForUpdate, compareVersions, installChannel, isNewer, parseLatest, runUpdateChecks, updateUrl } from '../src/update.js';
import { close, listen } from './fakes.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const BUNDLE = `#!/usr/bin/env node\nconsole.log("mesh-node 9.9.9");\n`;

interface FakeRelease {
  version: string;
  /** Hash advertised in latest.json (defaults to the real one). */
  advertisedSha?: string;
  /** Body served for the bundle (defaults to BUNDLE). */
  body?: string;
  latestStatus?: number;
  bundleStatus?: number;
}

/** Serves /latest.json and /mesh-node.js; counts hits. */
function fakeUpdateServer(rel: FakeRelease) {
  const hits = { latest: 0, bundle: 0 };
  let base = '';
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/latest.json') {
      hits.latest++;
      if (rel.latestStatus && rel.latestStatus !== 200) {
        res.writeHead(rel.latestStatus);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          version: rel.version,
          bundleUrl: `${base}/mesh-node.js`,
          bundleSha256: rel.advertisedSha ?? sha(rel.body ?? BUNDLE),
          publishedAt: '2026-10-03T00:00:00Z',
        }),
      );
    }
    if (path === '/mesh-node.js') {
      hits.bundle++;
      if (rel.bundleStatus && rel.bundleStatus !== 200) {
        res.writeHead(rel.bundleStatus);
        return res.end('<html>nope</html>');
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(rel.body ?? BUNDLE);
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    hits,
    async start() {
      base = await listen(server);
      return base;
    },
  };
}

const quietLog = () => {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
  return { log, lines };
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await close(s);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mesh-update-'));
  dirs.push(d);
  return d;
};

describe('version + document parsing', () => {
  it('compares versions semver-style', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('9.9.9', '0.1.0-dev')).toBe(false); // dev builds never nag
  });

  it('accepts bundleSha256 or sha256 and rejects malformed documents', () => {
    const ok = parseLatest({ version: 'v0.3.0', bundleUrl: 'https://x/mesh-node.js', sha256: 'A'.repeat(64) });
    expect(ok.version).toBe('0.3.0');
    expect(ok.sha256).toBe('a'.repeat(64));
    expect(parseLatest({ version: '0.3.0', bundleUrl: 'https://x/m.js', bundleSha256: 'b'.repeat(64) }).sha256).toBe('b'.repeat(64));
    expect(() => parseLatest({ bundleUrl: 'https://x/m.js', sha256: 'a'.repeat(64) })).toThrow(/version/);
    expect(() => parseLatest({ version: '1', bundleUrl: 'ftp://x', sha256: 'a'.repeat(64) })).toThrow(/bundleUrl/);
    expect(() => parseLatest({ version: '1', bundleUrl: 'https://x/m.js', sha256: 'zz' })).toThrow(/64 hex/);
    expect(() => parseLatest(null)).toThrow();
  });

  it('MESH_UPDATE_URL overrides the gateway default', () => {
    expect(updateUrl('https://gw.example/', {})).toBe('https://gw.example/install/latest.json');
    expect(updateUrl('https://gw.example', { MESH_UPDATE_URL: 'https://web.example/downloads/latest.json' })).toBe('https://web.example/downloads/latest.json');
  });

  it('detects a Homebrew install from the env or the Cellar path', () => {
    expect(installChannel({ MESH_INSTALL_CHANNEL: 'brew' }, '/x/mesh-node.js')).toBe('brew');
    expect(installChannel({}, '/opt/homebrew/Cellar/mesh-node/0.2.0/libexec/mesh-node.js')).toBe('brew');
    expect(installChannel({}, '/Users/me/.mesh/bin/mesh-node.js')).toBe('script');
  });
});

describe('mesh-node update against a fake release server', () => {
  it('good hash: downloads, verifies, replaces the bundle atomically and restarts the service', async () => {
    const srv = fakeUpdateServer({ version: '9.9.9' });
    servers.push(srv.server);
    const base = await srv.start();
    const dir = tmp();
    const target = join(dir, 'bin', 'mesh-node.js');
    const res = await checkForUpdate({ url: `${base}/latest.json`, currentVersion: '0.1.0' });
    expect(res.available).toBe(true);
    expect(res.latest.version).toBe('9.9.9');
    let restarted = 0;
    const r = await applyUpdate({ latest: res.latest, target, restart: () => (restarted++, 'restarted') });
    expect(r).toEqual({ target, version: '9.9.9', service: 'restarted' });
    expect(readFileSync(target, 'utf8')).toBe(BUNDLE);
    expect(existsSync(`${target}.update.tmp`)).toBe(false);
    expect(restarted).toBe(1);
    expect(srv.hits).toEqual({ latest: 1, bundle: 1 });
  });

  it('bad hash: refuses, leaves the existing bundle untouched, does not restart', async () => {
    const srv = fakeUpdateServer({ version: '9.9.9', advertisedSha: 'f'.repeat(64) });
    servers.push(srv.server);
    const base = await srv.start();
    const dir = tmp();
    const target = join(dir, 'mesh-node.js');
    writeFileSync(target, '#!/usr/bin/env node\n// old\n');
    const res = await checkForUpdate({ url: `${base}/latest.json`, currentVersion: '0.1.0' });
    let restarted = 0;
    await expect(applyUpdate({ latest: res.latest, target, restart: () => (restarted++, 'restarted') })).rejects.toThrow(/checksum mismatch/);
    expect(readFileSync(target, 'utf8')).toBe('#!/usr/bin/env node\n// old\n');
    expect(existsSync(`${target}.update.tmp`)).toBe(false);
    expect(restarted).toBe(0);
  });

  it('an HTML error page in place of the bundle is rejected even if the hash were right', async () => {
    const html = '<html>404</html>';
    const srv = fakeUpdateServer({ version: '9.9.9', body: html });
    servers.push(srv.server);
    const base = await srv.start();
    const target = join(tmp(), 'mesh-node.js');
    const res = await checkForUpdate({ url: `${base}/latest.json`, currentVersion: '0.1.0' });
    await expect(applyUpdate({ latest: res.latest, target, restart: () => 'not installed' })).rejects.toThrow(/does not look like mesh-node.js/);
    expect(existsSync(target)).toBe(false);
  });

  it('same version: nothing to do', async () => {
    const srv = fakeUpdateServer({ version: '0.1.0' });
    servers.push(srv.server);
    const base = await srv.start();
    const res = await checkForUpdate({ url: `${base}/latest.json`, currentVersion: '0.1.0' });
    expect(res.available).toBe(false);
    expect(srv.hits.bundle).toBe(0);
  });

  it('unreachable latest.json surfaces as an error with the status', async () => {
    const srv = fakeUpdateServer({ version: '1.0.0', latestStatus: 503 });
    servers.push(srv.server);
    const base = await srv.start();
    await expect(checkForUpdate({ url: `${base}/latest.json`, currentVersion: '0.1.0' })).rejects.toThrow(/503/);
  });
});

describe('daily check inside `start`', () => {
  it('logs once per newer version and does not install without MESH_AUTO_UPDATE', async () => {
    const srv = fakeUpdateServer({ version: '2.0.0' });
    servers.push(srv.server);
    const base = await srv.start();
    const { log, lines } = quietLog();
    const ac = new AbortController();
    let checks = 0;
    const applied: string[] = [];
    const done = runUpdateChecks({
      url: `${base}/latest.json`,
      log,
      currentVersion: '1.0.0',
      intervalMs: 20,
      initialDelayMs: 0,
      signal: ac.signal,
      apply: async (l) => (applied.push(l.version), { target: 'x', version: l.version, service: 'not installed' as const }),
      onCheck: () => {
        checks++;
        if (checks >= 3) ac.abort();
      },
    });
    await done;
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => l.includes('update available: mesh-node 2.0.0'))).toHaveLength(1);
    expect(lines[0]).toContain('Run `mesh-node update`');
    expect(applied).toEqual([]);
    expect(srv.hits.bundle).toBe(0);
  });

  it('with autoInstall it applies the update once it sees a newer version', async () => {
    const srv = fakeUpdateServer({ version: '2.0.0' });
    servers.push(srv.server);
    const base = await srv.start();
    const { log, lines } = quietLog();
    const ac = new AbortController();
    const applied: string[] = [];
    await runUpdateChecks({
      url: `${base}/latest.json`,
      log,
      currentVersion: '1.0.0',
      intervalMs: 20,
      initialDelayMs: 0,
      autoInstall: true,
      signal: ac.signal,
      apply: async (l) => {
        applied.push(l.version);
        ac.abort();
        return { target: '/tmp/mesh-node.js', version: l.version, service: 'restarted' as const };
      },
    });
    expect(applied).toEqual(['2.0.0']);
    expect(lines.some((l) => l.includes('updated /tmp/mesh-node.js to 2.0.0; service restarted'))).toBe(true);
  });

  it('a failing check is logged as a warning and the loop keeps going', async () => {
    const srv = fakeUpdateServer({ version: '2.0.0', latestStatus: 500 });
    servers.push(srv.server);
    const base = await srv.start();
    const { log, lines } = quietLog();
    const ac = new AbortController();
    let checks = 0;
    await runUpdateChecks({
      url: `${base}/latest.json`,
      log,
      currentVersion: '1.0.0',
      intervalMs: 10,
      initialDelayMs: 0,
      signal: ac.signal,
      onCheck: () => {
        if (++checks >= 2) ac.abort();
      },
    });
    expect(checks).toBe(2);
    expect(lines.filter((l) => l.startsWith('warn update check failed')).length).toBe(2);
  });
});
