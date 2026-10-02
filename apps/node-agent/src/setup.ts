import { mkdirSync } from 'node:fs';
import { DEFAULT_GATEWAY, DEFAULT_OLLAMA, loadConfig, saveConfig, type NodeConfig } from './config.js';
import { GatewayClient, GatewayError, type RegisterInput, type RegisterResult } from './gateway.js';
import { describeSelection, selectModels } from './models.js';
import { OllamaClient } from './ollama.js';
import { AGENT_VERSION, paths } from './paths.js';
import { hasBrew, run, spawnDetached, systemInfo, which } from './system.js';
import { c, out, table } from './ui.js';

export interface SetupOptions {
  /**
   * One-time link code from the web app (Run a node -> Link a Mac). The wallet signed there; the Mac
   * never holds a key. Required unless the gateway allows the legacy unsigned flow (`wallet`).
   */
  link?: string;
  /** Legacy: reward wallet for an unsigned registration (gateway with NODES_REQUIRE_SIGNATURE=false). */
  wallet?: string;
  gateway?: string;
  ollama?: string;
  /** Explicit model list; overrides the RAM-based default. */
  models?: string[];
  with70b?: boolean;
  /** Skip model pulls (CI / already pulled). */
  skipPull?: boolean;
}

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/** Accepts `abcd-efgh`, `ABCD EFGH`, `ABCDEFGH`; the gateway normalises the same way. */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** What to send to POST /nodes/register: a link code when we have one, else the legacy wallet. */
export function registerInput(opts: Pick<SetupOptions, 'link' | 'wallet'>, sys: { chip: string; ramGb: number }, models: string[]): RegisterInput {
  const base = { chip: sys.chip, ramGb: sys.ramGb, models, agentVersion: AGENT_VERSION };
  if (opts.link) return { ...base, linkCode: normalizeLinkCode(opts.link) };
  if (opts.wallet) return { ...base, wallet: opts.wallet };
  throw new Error('--link <code> (from the web app: Run a node -> Link a Mac) or --wallet <addr> is required');
}

/** Turns gateway refusals into one actionable line. */
export function explainRegisterError(err: unknown, webHint: string): string {
  if (!(err instanceof GatewayError)) return (err as Error).message;
  switch (err.code) {
    case 'signature_required':
      return `this gateway requires wallet-signed registration. Open ${webHint}, click "Link a Mac", then run: mesh-node setup --link <code>`;
    case 'link_code_expired':
      return 'the link code expired (15 min). Click "Link a Mac" in the web app again for a fresh code.';
    case 'link_code_used':
      return 'the link code was already used. Click "Link a Mac" in the web app again for a fresh code.';
    case 'link_code_invalid':
      return 'unknown link code; check for typos or click "Link a Mac" in the web app again.';
    case 'link_code_wallet_mismatch':
      return 'the link code belongs to a different wallet than --wallet; drop --wallet (the code already carries the wallet).';
    default:
      return err.message;
  }
}

/** Finds Ollama or installs it with Homebrew. Returns the binary path, or null when we cannot install. */
export function ensureOllamaInstalled(): string | null {
  const found = which('ollama');
  if (found) {
    out.ok(`Ollama found at ${found}`);
    return found;
  }
  const brew = hasBrew();
  if (!brew) {
    out.fail('Ollama is not installed and Homebrew is missing.');
    out.line(`   Download it from ${c.cyan(OLLAMA_DOWNLOAD_URL)}, open it once, then re-run this command.`);
    return null;
  }
  out.step('installing Ollama with Homebrew (brew install ollama)');
  try {
    run(brew, ['install', 'ollama'], { inherit: true });
  } catch (err) {
    out.fail(`brew install ollama failed: ${(err as Error).message}`);
    out.line(`   Download it from ${c.cyan(OLLAMA_DOWNLOAD_URL)} instead, then re-run.`);
    return null;
  }
  const after = which('ollama');
  if (after) out.ok(`Ollama installed at ${after}`);
  return after;
}

/** Makes sure `ollama serve` answers; launches it detached when it does not. */
export async function ensureOllamaRunning(client: OllamaClient, bin: string, waitMs = 30_000): Promise<boolean> {
  if (await client.isUp()) {
    out.ok(`Ollama is running at ${client.baseUrl}`);
    return true;
  }
  mkdirSync(paths.logsDir(), { recursive: true });
  out.step(`starting ollama serve (log: ${paths.ollamaLog()})`);
  spawnDetached(bin, ['serve'], paths.ollamaLog());
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    if (await client.isUp()) {
      out.ok('Ollama is up');
      return true;
    }
  }
  out.fail(`Ollama did not start within ${waitMs / 1000}s. Check ${paths.ollamaLog()}.`);
  return false;
}

export async function pullModels(client: OllamaClient, models: string[]): Promise<string[]> {
  const have = new Set(await client.listModels().catch(() => [] as string[]));
  const ready: string[] = [];
  for (const m of models) {
    const tag = m.includes(':') ? m : `${m}:latest`;
    if (have.has(tag) || have.has(m)) {
      out.ok(`${m} already pulled`);
      ready.push(m);
      continue;
    }
    out.step(`pulling ${m} (this can take a while)`);
    try {
      await client.pull(m, (line) => out.progress(`${m}: ${line}`));
      out.progressEnd();
      out.ok(`${m} pulled`);
      ready.push(m);
    } catch (err) {
      out.progressEnd();
      out.warn(`${m}: ${(err as Error).message}`);
    }
  }
  return ready;
}

export async function setup(opts: SetupOptions): Promise<NodeConfig> {
  const sys = systemInfo();
  const gatewayUrl = (opts.gateway ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY).replace(/\/$/, '');
  const ollamaUrl = (opts.ollama ?? process.env.OLLAMA_HOST_URL ?? DEFAULT_OLLAMA).replace(/\/$/, '');

  if (!opts.link && !opts.wallet) throw new Error('--link <code> (from the web app: Run a node -> Link a Mac) or --wallet <addr> is required');
  const link = opts.link ? normalizeLinkCode(opts.link) : undefined;

  out.title('mesh-node setup');
  out.line(table([
    ['machine', `${sys.chip} · ${sys.ramGb} GB · ${sys.platform}/${sys.arch}`],
    link ? ['link code', `${link}  (wallet signed in the browser)`] : ['wallet', `${opts.wallet}  (legacy unsigned registration)`],
    ['gateway', gatewayUrl],
  ]));
  if (sys.platform === 'darwin' && sys.arch !== 'arm64') out.warn('Intel Mac detected: Ollama works but models run slowly without Apple Silicon.');

  out.title('1. Ollama');
  const bin = ensureOllamaInstalled();
  if (!bin) process.exit(1);
  const ollama = new OllamaClient(ollamaUrl);
  if (!(await ensureOllamaRunning(ollama, bin))) process.exit(1);

  out.title('2. Models');
  const models = opts.models?.length ? opts.models : selectModels(sys.ramGb, { with70b: opts.with70b });
  if (!opts.models?.length) for (const line of describeSelection(sys.ramGb, { with70b: opts.with70b })) out.line(`   ${line}`);
  const ready = opts.skipPull ? models : await pullModels(ollama, models);
  if (ready.length === 0) {
    out.fail('no model could be pulled; the node would have nothing to serve.');
    process.exit(1);
  }

  out.title('3. Register');
  const previous = loadConfig();
  const input = registerInput({ link, wallet: opts.wallet }, sys, ready);
  const webHint = 'the Mesh web app (Run a node page)';
  let reg: RegisterResult | null = null;
  if (previous && previous.gateway === gatewayUrl) {
    // Keep the same node identity across re-runs: re-register the stored id with its token (rotates it).
    // A refused re-claim (409) does not consume the link code, so the fresh registration below can use it.
    try {
      reg = await new GatewayClient(gatewayUrl, previous.nodeToken).register({ ...input, nodeId: previous.nodeId });
      out.step(`kept node id ${previous.nodeId}`);
    } catch (err) {
      const e = err as GatewayError;
      if (e instanceof GatewayError && e.code?.startsWith('link_code')) throw new Error(explainRegisterError(e, webHint));
      out.step(`previous node ${previous.nodeId} could not be re-claimed (${e.message}); registering a new one`);
    }
  }
  if (!reg) {
    try {
      reg = await new GatewayClient(gatewayUrl).register(input);
    } catch (err) {
      throw new Error(explainRegisterError(err, webHint));
    }
  }
  const wallet = reg.wallet ?? opts.wallet;
  if (!wallet) throw new Error('gateway did not return the reward wallet for this node; upgrade the gateway or pass --wallet');
  const cfg: NodeConfig = {
    gateway: gatewayUrl,
    nodeId: reg.nodeId,
    nodeToken: reg.nodeToken,
    wallet,
    models: ready,
    ollama: ollamaUrl,
    chip: sys.chip,
    ramGb: sys.ramGb,
    registeredAt: Math.floor(Date.now() / 1000),
  };
  saveConfig(cfg);
  out.ok(`registered as ${c.bold(reg.nodeId)} · paid to ${wallet}${reg.walletVerified ? ' (wallet verified)' : ''}`);
  out.ok(`config saved to ${paths.config()} (0600)`);

  out.title('Next');
  out.line(`   ${c.cyan('mesh-node start')}             run in this terminal`);
  out.line(`   ${c.cyan('mesh-node service install')}   run in the background and at login`);
  out.line(`   ${c.cyan('mesh-node status')}            earnings and uptime`);
  out.line();
  return cfg;
}
