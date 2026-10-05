import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_SETTERS, MAX_PARALLEL_LIMIT, loadConfig, parseMaxParallel, saveConfig, type NodeConfig } from '../src/config.js';
import { explainStatusError, parseArgs } from '../src/cli.js';
import { GatewayError } from '../src/gateway.js';
import { ollamaServeEnv } from '../src/ollama.js';
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
  maxParallel: 1,
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

  it('a hand-edited file that is not JSON gets a plain message, not a SyntaxError', () => {
    saveConfig(sample);
    writeFileSync(paths.config(), '{ oops');
    expect(() => loadConfig()).toThrow(/not valid JSON.*mesh-node setup/);
  });

  it('repairs permissions wider than 0600 on load (the file holds the node token)', () => {
    saveConfig(sample);
    chmodSync(paths.config(), 0o644);
    expect(statSync(paths.config()).mode & 0o777).toBe(0o644);
    loadConfig();
    expect(statSync(paths.config()).mode & 0o777).toBe(0o600);
  });

  it('maxParallel: absent -> 1, valid -> kept, out of range in the file -> 1 (never refuses to start)', () => {
    saveConfig(sample);
    expect(loadConfig()!.maxParallel).toBe(1);
    saveConfig({ ...sample, maxParallel: 3 });
    expect(loadConfig()!.maxParallel).toBe(3);
    writeFileSync(paths.config(), JSON.stringify({ ...sample, maxParallel: 99 }));
    expect(loadConfig()!.maxParallel).toBe(1);
    writeFileSync(paths.config(), JSON.stringify({ ...sample, maxParallel: 'two' }));
    expect(loadConfig()!.maxParallel).toBe(1);
  });

  it('`config set maxParallel 2` parses strictly and the serve env mirrors it', () => {
    expect(parseMaxParallel('2')).toBe(2);
    expect(parseMaxParallel(4)).toBe(4);
    for (const bad of ['0', '-1', '1.5', 'two', '', String(MAX_PARALLEL_LIMIT + 1)]) expect(() => parseMaxParallel(bad)).toThrow(/whole number from 1 to/);
    expect(CONFIG_SETTERS.maxParallel.parse('2')).toEqual({ maxParallel: 2 });
    expect(CONFIG_SETTERS.models.parse('a, b,,')).toEqual({ models: ['a', 'b'] });
    expect(() => CONFIG_SETTERS.ollama.parse('localhost:11434')).toThrow(/http/);
    expect(ollamaServeEnv(2)).toEqual({ OLLAMA_NOHISTORY: '1', OLLAMA_DEBUG: '0', OLLAMA_NUM_PARALLEL: '2' });
    expect(ollamaServeEnv()).toMatchObject({ OLLAMA_NUM_PARALLEL: '1' });
    expect(parseArgs(['config', 'set', 'maxParallel', '2'])).toEqual({ cmd: ['config', 'set', 'maxParallel', '2'], flags: {} });
    expect(parseArgs(['setup', '--link', 'abcd-efgh', '--max-parallel', '2'])).toEqual({ cmd: ['setup'], flags: { link: 'abcd-efgh', 'max-parallel': '2' } });
  });
});

describe('status when offline', () => {
  it('explains an unreachable gateway in plain words and tells the user the node keeps retrying', () => {
    const msg = explainStatusError(new GatewayError(0, 'could not reach gateway at http://gw: ECONNREFUSED', 'network'), 'http://gw');
    expect(msg).toMatch(/cannot reach the gateway at http:\/\/gw \(ECONNREFUSED\)/);
    expect(msg).toMatch(/internet connection/);
    expect(msg).toMatch(/keeps retrying/);
    expect(explainStatusError(new GatewayError(503, 'GET /nodes/x -> 503'), 'http://gw')).toMatch(/having trouble/);
    expect(explainStatusError(new GatewayError(401, 'nope'), 'http://gw')).toMatch(/no longer recognises.*setup --link/);
    expect(explainStatusError(new Error('weird'), 'http://gw')).toBe('could not fetch live stats: weird');
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
