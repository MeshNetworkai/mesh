import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { OLLAMA_PRIVACY_ENV } from './ollama.js';
import { LAUNCHD_LABEL, launchAgentPlist, paths } from './paths.js';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd user agent: RunAtLoad + KeepAlive, logs under ~/.mesh/logs/. */
export function renderPlist(opts: { node: string; script: string; home: string; path?: string }): string {
  const args = [opts.node, opts.script, 'start'];
  const pathVar = opts.path ?? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', dirname(opts.node)].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(opts.home)}</string>
  <key>StandardOutPath</key>
  <string>${xml(`${opts.home}/logs/node.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${opts.home}/logs/node.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathVar)}</string>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>MESH_HOME</key>
    <string>${xml(opts.home)}</string>
    <key>MESH_SERVICE</key>
    <string>1</string>
${Object.entries(OLLAMA_PRIVACY_ENV)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: (e.stderr || e.stdout || e.message || '').trim() };
  }
}

const domain = () => `gui/${userInfo().uid}`;

export function assertMac(what: string) {
  if (platform() !== 'darwin') throw new Error(`${what} uses launchd and only works on macOS. On Linux run \`mesh-node start\` under systemd or tmux.`);
}

/** Writes the plist and loads it. `script` is the mesh-node entry file to run. */
export function installService(script: string): { plist: string } {
  assertMac('mesh-node service install');
  const plistPath = launchAgentPlist();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(paths.logsDir(), { recursive: true });
  // Unload a previous copy first so edits take effect (idempotent re-install).
  if (existsSync(plistPath)) launchctl(['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
  writeFileSync(plistPath, renderPlist({ node: process.execPath, script, home: paths.home() }), { mode: 0o644 });
  // A service that was ever booted out or disabled in this login session stays disabled until it is
  // enabled again; bootstrap then fails with "Input/output error" and nothing runs. Enable first.
  launchctl(['enable', `${domain()}/${LAUNCHD_LABEL}`]);
  let res = launchctl(['bootstrap', domain(), plistPath]);
  if (!res.ok && !/already loaded|service already/i.test(res.out)) {
    // Legacy path for older macOS; do not trust its exit code — we verify with `print` below.
    res = launchctl(['load', '-w', plistPath]);
  }
  launchctl(['kickstart', '-k', `${domain()}/${LAUNCHD_LABEL}`]);
  // Verify, instead of assuming: the service must be known to launchd in the user's GUI domain.
  const check = launchctl(['print', `${domain()}/${LAUNCHD_LABEL}`]);
  if (!check.ok) {
    throw new Error(
      `launchd did not accept the service (${res.out || check.out || 'no details'}).\n` +
        `  Try:  launchctl enable ${domain()}/${LAUNCHD_LABEL} && launchctl bootstrap ${domain()} ${plistPath}\n` +
        `  Or run the node in a terminal for now:  mesh-node start`,
    );
  }
  return { plist: plistPath };
}

export function uninstallService(): { plist: string; existed: boolean } {
  assertMac('mesh-node service uninstall');
  const plistPath = launchAgentPlist();
  const existed = existsSync(plistPath);
  let res = launchctl(['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
  if (!res.ok && existed) res = launchctl(['unload', '-w', plistPath]);
  if (existed) unlinkSync(plistPath);
  return { plist: plistPath, existed };
}

export function serviceStatus(): 'running' | 'loaded' | 'not loaded' | 'not installed' {
  if (platform() !== 'darwin') return 'not installed';
  if (!existsSync(launchAgentPlist())) return 'not installed';
  const res = launchctl(['print', `${domain()}/${LAUNCHD_LABEL}`]);
  // The plist exists but launchd does not know the service: an earlier install failed half-way.
  if (!res.ok) return 'not loaded';
  return /state = running/.test(res.out) ? 'running' : 'loaded';
}
