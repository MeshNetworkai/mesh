import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { cpus, loadavg, platform, totalmem } from 'node:os';

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  chip: string;
  ramGb: number;
}

function sysctl(key: string): string | null {
  try {
    return execFileSync('sysctl', ['-n', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Chip name via `sysctl -n machdep.cpu.brand_string` on macOS; /proc/cpuinfo or os.cpus() elsewhere. */
export function detectChip(): string {
  if (platform() === 'darwin') {
    const brand = sysctl('machdep.cpu.brand_string');
    if (brand) return brand.replace(/^Apple\s+/, 'Apple ');
  }
  const model = cpus()[0]?.model?.trim();
  return model || `${process.arch} cpu`;
}

/** RAM in whole GB via `sysctl -n hw.memsize` on macOS (os.totalmem() elsewhere). */
export function detectRamGb(): number {
  let bytes = 0;
  if (platform() === 'darwin') {
    const v = sysctl('hw.memsize');
    if (v) bytes = Number(v);
  }
  if (!bytes) bytes = totalmem();
  return Math.round(bytes / 1024 ** 3);
}

export function systemInfo(): SystemInfo {
  return { platform: platform(), arch: process.arch, chip: detectChip(), ramGb: detectRamGb() };
}

export function loadAvg1m(): number {
  const [one] = loadavg();
  return Math.round((one ?? 0) * 100) / 100;
}

export function which(bin: string): string | null {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Ollama.app/Contents/Resources'];
  const dirs = [...(process.env.PATH ?? '').split(':'), ...extra];
  for (const d of dirs) {
    if (!d) continue;
    const p = `${d}/${bin}`;
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasBrew(): string | null {
  return which('brew');
}

export function run(cmd: string, args: string[], opts: { inherit?: boolean } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] }) ?? '';
}

/** Starts a detached background process whose output goes to `logFile`. */
export function spawnDetached(cmd: string, args: string[], logFile: string, env: Record<string, string> = {}): number | undefined {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
  child.unref();
  return child.pid;
}
