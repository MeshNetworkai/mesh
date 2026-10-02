import { homedir } from 'node:os';
import { join } from 'node:path';

/** All state lives under ~/.mesh (override with MESH_HOME, used by tests and the install script). */
export function meshHome(): string {
  return process.env.MESH_HOME || join(homedir(), '.mesh');
}

export const paths = {
  home: () => meshHome(),
  config: () => join(meshHome(), 'config.json'),
  pauseFlag: () => join(meshHome(), 'paused'),
  logsDir: () => join(meshHome(), 'logs'),
  nodeLog: () => join(meshHome(), 'logs', 'node.log'),
  ollamaLog: () => join(meshHome(), 'logs', 'ollama.log'),
  binDir: () => join(meshHome(), 'bin'),
};

export const LAUNCHD_LABEL = 'xyz.mesh.node';
export const launchAgentPlist = () => join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

declare const __MESH_VERSION__: string | undefined;
export const AGENT_VERSION: string = typeof __MESH_VERSION__ === 'string' ? __MESH_VERSION__ : '0.1.0-dev';
