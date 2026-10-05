/**
 * Self-update for the one-file bundle (`~/.mesh/bin/mesh-node.js`).
 *
 * Source of truth is a small JSON document ("latest.json") published by the release workflow:
 *   { version, bundleUrl, bundleSha256 | sha256, tarballUrl?, dmgUrl?, publishedAt? }
 * It is read from `MESH_UPDATE_URL` when set, otherwise `<gateway>/install/latest.json` (the gateway
 * proxies the web host's `/downloads/latest.json`, see apps/gateway/src/routes/install.ts).
 *
 * `mesh-node update` downloads the bundle to a temp file next to the target, verifies the SHA-256,
 * renames it over the old file (atomic on the same filesystem) and restarts the launchd service.
 * The `start` loop checks once a day and logs when a newer version exists; it installs only with
 * MESH_AUTO_UPDATE=1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from './log.js';
import { AGENT_VERSION, LAUNCHD_LABEL, launchAgentPlist, paths } from './paths.js';

export interface LatestRelease {
  version: string;
  bundleUrl: string;
  sha256: string;
  publishedAt?: string;
  tarballUrl?: string;
  tarballSha256?: string;
  dmgUrl?: string;
  dmgSha256?: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** `MESH_UPDATE_URL` wins; otherwise the gateway's `/install/latest.json`. */
export function updateUrl(gateway: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MESH_UPDATE_URL?.trim();
  if (explicit) return explicit;
  return `${gateway.replace(/\/$/, '')}/install/latest.json`;
}

export const SHA256_RE = /^[0-9a-f]{64}$/i;

/** Validates the document shape; accepts `bundleSha256` (release.yml) or `sha256` (short form). */
export function parseLatest(raw: unknown): LatestRelease {
  if (!raw || typeof raw !== 'object') throw new Error('latest.json is not an object');
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === 'string' ? o.version.replace(/^v/, '').trim() : '';
  const bundleUrl = typeof o.bundleUrl === 'string' ? o.bundleUrl.trim() : '';
  const shaRaw = typeof o.bundleSha256 === 'string' ? o.bundleSha256 : typeof o.sha256 === 'string' ? o.sha256 : '';
  const sha256 = shaRaw.trim().toLowerCase();
  if (!version) throw new Error('latest.json: missing version');
  if (!/^https?:\/\//.test(bundleUrl)) throw new Error('latest.json: bundleUrl must be an http(s) URL');
  if (!SHA256_RE.test(sha256)) throw new Error('latest.json: bundleSha256 must be 64 hex characters');
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return {
    version,
    bundleUrl,
    sha256,
    publishedAt: str('publishedAt'),
    tarballUrl: str('tarballUrl'),
    tarballSha256: str('tarballSha256')?.toLowerCase(),
    dmgUrl: str('dmgUrl'),
    dmgSha256: str('dmgSha256')?.toLowerCase(),
  };
}

/** Semver-ish compare: numeric dotted parts, a `-pre` suffix sorts below the plain version. Returns -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function isNewer(latest: string, current: string): boolean {
  // A dev build ("0.1.0-dev") never counts as behind a release so `pnpm dev` does not nag.
  if (/-dev$/.test(current)) return false;
  return compareVersions(latest, current) > 0;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface CheckOptions {
  url: string;
  currentVersion?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface CheckResult {
  latest: LatestRelease;
  current: string;
  available: boolean;
}

export async function checkForUpdate(opts: CheckOptions): Promise<CheckResult> {
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await f(opts.url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': `mesh-node/${AGENT_VERSION}` } });
    if (!res.ok) throw new Error(`update check: ${opts.url} answered ${res.status}`);
    const latest = parseLatest(await res.json());
    const current = opts.currentVersion ?? AGENT_VERSION;
    return { latest, current, available: isNewer(latest.version, current) };
  } finally {
    clearTimeout(t);
  }
}

export const sha256Hex = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

/** Temp download path beside `target`. `.mjs` so Node runs the ESM bundle for the smoke test whatever the extension of `target`. */
export const updateTmpPath = (target: string) => `${target}.update.tmp.mjs`;

/**
 * Downloads `bundleUrl` into `<target>.update.tmp.mjs`, verifies the hash and that the body looks like
 * the bundle (shebang / JS, not an HTML error page). Returns the temp path; the caller renames it.
 */
export async function downloadVerified(latest: LatestRelease, target: string, fetchImpl: FetchLike = fetch, timeoutMs = 120_000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let body: Uint8Array;
  try {
    const res = await fetchImpl(latest.bundleUrl, { signal: ac.signal, headers: { 'user-agent': `mesh-node/${AGENT_VERSION}` } });
    if (!res.ok) throw new Error(`download failed: ${latest.bundleUrl} answered ${res.status}`);
    body = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
  const got = sha256Hex(body);
  if (got !== latest.sha256) throw new Error(`checksum mismatch for ${latest.bundleUrl}: expected ${latest.sha256}, got ${got}. Nothing was changed.`);
  const head = Buffer.from(body.subarray(0, 64)).toString('utf8');
  if (!/^(#!\/usr\/bin\/env node|\/\/|import |"use strict")/.test(head)) throw new Error('downloaded file does not look like mesh-node.js (HTML error page?). Nothing was changed.');
  mkdirSync(dirname(target), { recursive: true });
  const tmp = updateTmpPath(target);
  if (existsSync(tmp)) unlinkSync(tmp);
  writeFileSync(tmp, body, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  return tmp;
}

/** Restart the launchd agent if it is installed (so the new bundle is what runs). No-op elsewhere. */
export function restartServiceIfInstalled(): 'restarted' | 'not installed' | 'failed' {
  if (platform() !== 'darwin' || !existsSync(launchAgentPlist())) return 'not installed';
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${userInfo().uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    return 'restarted';
  } catch {
    return 'failed';
  }
}

export interface ApplyOptions {
  latest: LatestRelease;
  /** Defaults to ~/.mesh/bin/mesh-node.js. */
  target?: string;
  fetchImpl?: FetchLike;
  restart?: () => 'restarted' | 'not installed' | 'failed';
  /** Smoke test for the downloaded bundle before it replaces the live one (default: run it with --version). */
  verifyRuns?: (bundle: string, expectedVersion: string) => void;
}

export interface ApplyResult {
  target: string;
  version: string;
  service: 'restarted' | 'not installed' | 'failed';
  /** Where the previous bundle was kept (`mesh-node update --rollback` restores it). */
  backup?: string | null;
}

export const backupPath = (target: string) => `${target}.prev`;

/**
 * Runs the downloaded bundle once (`node <bundle> --version`) so a file that passes the hash check but
 * cannot start (wrong Node version, truncated by a proxy that preserved length, a bad release) is
 * caught here, while the working copy is still in place.
 */
export function verifyBundleRuns(bundle: string, expectedVersion: string, nodeBin = process.execPath): void {
  let out: string;
  try {
    out = execFileSync(nodeBin, [bundle, '--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MESH_HOME: dirname(bundle) } });
  } catch (err) {
    const e = err as Error & { stderr?: string; killed?: boolean };
    const lines = (e.stderr || e.message || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const why = e.killed ? 'it did not finish within 20s' : (lines.find((l) => /error/i.test(l) && !/^Node\.js v/.test(l)) ?? lines[lines.length - 1] ?? 'it exited with an error').slice(0, 200);
    throw new Error(`downloaded mesh-node.js does not start (${why}). Nothing was changed.`);
  }
  if (!out.includes(expectedVersion)) throw new Error(`downloaded mesh-node.js reports version "${out.trim().slice(0, 40)}", expected ${expectedVersion}. Nothing was changed.`);
}

/**
 * Download, verify (hash + smoke run), keep the old bundle as `<target>.prev`, replace atomically,
 * restart. Throws before touching the target on any download/verify error. If the service fails to
 * come back the previous bundle is put back and the error says so.
 */
export async function applyUpdate(opts: ApplyOptions): Promise<ApplyResult> {
  const target = opts.target ?? join(paths.binDir(), 'mesh-node.js');
  const tmp = await downloadVerified(opts.latest, target, opts.fetchImpl);
  try {
    (opts.verifyRuns ?? verifyBundleRuns)(tmp, opts.latest.version);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
  const backup = backupPath(target);
  let haveBackup = false;
  if (existsSync(target)) {
    copyFileSync(target, backup);
    chmodSync(backup, 0o755);
    haveBackup = true;
  }
  renameSync(tmp, target);
  const restart = opts.restart ?? restartServiceIfInstalled;
  const service = restart();
  if (service === 'failed' && haveBackup) {
    // The new bundle is in place but launchd could not bring it up: put the old one back and retry.
    copyFileSync(backup, target);
    const again = restart();
    throw new Error(`mesh-node ${opts.latest.version} was installed but the service failed to restart; the previous version was restored (service ${again}). Run \`mesh-node logs\` for details.`);
  }
  return { target, version: opts.latest.version, service, backup: haveBackup ? backup : null };
}

/** `mesh-node update --rollback`: swap `<target>.prev` back in and restart. */
export function rollbackUpdate(opts: { target?: string; restart?: () => 'restarted' | 'not installed' | 'failed' } = {}): ApplyResult {
  const target = opts.target ?? join(paths.binDir(), 'mesh-node.js');
  const backup = backupPath(target);
  if (!existsSync(backup)) throw new Error(`nothing to roll back to (${backup} does not exist)`);
  copyFileSync(backup, target);
  chmodSync(target, 0o755);
  const service = (opts.restart ?? restartServiceIfInstalled)();
  return { target, version: 'previous', service, backup };
}

/**
 * Installed through Homebrew: the bundle lives in the Cellar and `brew upgrade` owns it, so
 * `mesh-node update` must not write into ~/.mesh/bin. The brew wrapper sets MESH_INSTALL_CHANNEL=brew.
 */
export function installChannel(env: NodeJS.ProcessEnv = process.env, script = process.argv[1] ?? ''): 'brew' | 'script' {
  if (env.MESH_INSTALL_CHANNEL === 'brew') return 'brew';
  if (/\/(Cellar|homebrew)\//.test(script)) return 'brew';
  return 'script';
}

export interface UpdateLoopOptions {
  url: string;
  log: Logger;
  currentVersion?: string;
  intervalMs?: number;
  /** Delay before the first check (default 60 s; 0 in tests). */
  initialDelayMs?: number;
  autoInstall?: boolean;
  fetchImpl?: FetchLike;
  apply?: (latest: LatestRelease) => Promise<ApplyResult>;
  signal: AbortSignal;
  /** Called after each check (tests). */
  onCheck?: (result: CheckResult | Error) => void;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Daily check from the `start` loop. Logs once per newer version; with `autoInstall` it applies the
 * update (the service restart ends this process; launchd starts the new one).
 */
export async function runUpdateChecks(opts: UpdateLoopOptions): Promise<void> {
  const interval = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  let announced: string | null = null;
  await wait(opts.initialDelayMs ?? 60_000, opts.signal);
  while (!opts.signal.aborted) {
    try {
      const res = await checkForUpdate({ url: opts.url, currentVersion: opts.currentVersion, fetchImpl: opts.fetchImpl });
      opts.onCheck?.(res);
      if (res.available) {
        if (announced !== res.latest.version) {
          announced = res.latest.version;
          opts.log.info(`update available: mesh-node ${res.latest.version} (running ${res.current}). ${opts.autoInstall ? 'MESH_AUTO_UPDATE=1: installing' : 'Run `mesh-node update` to install (or set MESH_AUTO_UPDATE=1)'}`);
        }
        if (opts.autoInstall) {
          const r = await (opts.apply ?? ((l) => applyUpdate({ latest: l, fetchImpl: opts.fetchImpl })))(res.latest);
          opts.log.info(`updated ${r.target} to ${r.version}; service ${r.service}`);
        }
      }
    } catch (err) {
      opts.onCheck?.(err as Error);
      opts.log.warn(`update check failed: ${(err as Error).message}`);
    }
    await wait(interval, opts.signal);
  }
}
