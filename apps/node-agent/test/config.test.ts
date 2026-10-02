import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type NodeConfig } from '../src/config.js';
import { MODEL_14B, MODEL_70B_Q4, MODEL_8B, selectModels } from '../src/models.js';
import { paths } from '../src/paths.js';
import { renderPlist } from '../src/service.js';

const sample: NodeConfig = {
  gateway: 'http://localhost:8787',
  nodeId: 'node_1',
  nodeToken: 'tok_secret',
  wallet: '9xQeKf2sVbT7mRw3Lp8nHJq4cYzA6dEuGk1oXiSNHn4k',
  models: ['llama3.1:8b'],
  ollama: 'http://127.0.0.1:11434',
  chip: 'Apple M3 Max',
  ramGb: 64,
  registeredAt: 1_700_000_000,
};

describe('config persistence', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    process.env.MESH_HOME = home;
  });
  afterEach(() => {
    delete process.env.MESH_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when nothing is saved', () => {
    expect(loadConfig()).toBeNull();
  });

  it('round-trips through ~/.mesh/config.json with 0600 perms', () => {
    saveConfig(sample);
    const file = paths.config();
    expect(file).toBe(join(home, 'config.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(sample);
    expect(loadConfig()).toEqual(sample);
  });

  it('overwrites atomically and strips trailing slashes', () => {
    saveConfig(sample);
    saveConfig({ ...sample, gateway: 'https://api.mesh.example/', nodeId: 'node_2' });
    const cfg = loadConfig()!;
    expect(cfg.nodeId).toBe('node_2');
    expect(cfg.gateway).toBe('https://api.mesh.example');
    expect(statSync(paths.config()).mode & 0o777).toBe(0o600);
  });

  it('rejects an incomplete file', () => {
    saveConfig({ ...sample, nodeToken: '' });
    expect(() => loadConfig()).toThrow(/incomplete/);
  });
});

describe('RAM -> model selection', () => {
  it('8 GB and 16 GB get the 8B model only', () => {
    expect(selectModels(8)).toEqual([MODEL_8B]);
    expect(selectModels(16)).toEqual([MODEL_8B]);
    expect(selectModels(24)).toEqual([MODEL_8B]);
  });
  it('32 GB adds the 14B model', () => {
    expect(selectModels(32)).toEqual([MODEL_8B, MODEL_14B]);
    expect(selectModels(48)).toEqual([MODEL_8B, MODEL_14B]);
  });
  it('64 GB+ adds the 70B Q4 model only when opted in', () => {
    expect(selectModels(64)).toEqual([MODEL_8B, MODEL_14B]);
    expect(selectModels(64, { with70b: true })).toEqual([MODEL_8B, MODEL_14B, MODEL_70B_Q4]);
    expect(selectModels(128, { with70b: true })).toEqual([MODEL_8B, MODEL_14B, MODEL_70B_Q4]);
    expect(selectModels(32, { with70b: true })).toEqual([MODEL_8B, MODEL_14B]);
  });
});

describe('launchd plist', () => {
  it('runs `start` at load with KeepAlive and logs under ~/.mesh/logs', () => {
    const xml = renderPlist({ node: '/usr/local/bin/node', script: '/Users/o/.mesh/bin/mesh-node.js', home: '/Users/o/.mesh' });
    expect(xml).toContain('<string>xyz.mesh.node</string>');
    expect(xml).toContain('<string>/usr/local/bin/node</string>\n    <string>/Users/o/.mesh/bin/mesh-node.js</string>\n    <string>start</string>');
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toContain('<string>/Users/o/.mesh/logs/node.log</string>');
    expect(xml).toContain('/opt/homebrew/bin');
  });
});
