import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { loadConfig, requireConfig, saveConfig } from './config.js';
import { GatewayClient, GatewayError } from './gateway.js';
import { createLogger } from './log.js';
import { startLoop } from './loop.js';
import { OllamaClient } from './ollama.js';
import { AGENT_VERSION, paths } from './paths.js';
import { installService, serviceStatus, uninstallService } from './service.js';
import { setup } from './setup.js';
import { c, fmt, out, table } from './ui.js';
import { applyUpdate, checkForUpdate, installChannel, runUpdateChecks, updateUrl } from './update.js';

const HELP = `mesh-node ${AGENT_VERSION} - serve AI replies from this machine and earn for them

Usage
  mesh-node setup --link <code> [--gateway <url>] [--models a,b] [--with-70b] [--ollama <url>]
                                  <code> comes from the web app: Run a node -> "Link a Mac" (your wallet signs there;
                                  this machine never holds a key). --wallet <addr> instead only works on gateways
                                  that allow unsigned registration (NODES_REQUIRE_SIGNATURE=false).
  mesh-node start                 heartbeat, take jobs, stream replies (Ctrl-C / SIGTERM to stop)
  mesh-node status [--json]       node stats from the gateway
  mesh-node service install       run in the background via launchd (macOS), start at login
  mesh-node service uninstall     stop and remove the launchd agent
  mesh-node pause | resume        stop / resume taking jobs (keeps heartbeating)
  mesh-node logs [-n 200]         tail ~/.mesh/logs/node.log
  mesh-node update [--check]      install the latest release (sha256-verified) and restart the service;
                                  --check only reports. 'start' checks daily and logs when one exists.
  mesh-node --version | --help

Files   ~/.mesh/config.json (0600)  ~/.mesh/logs/  ~/.mesh/paused  ~/.mesh/bin/mesh-node.js
Env     GATEWAY_URL  MESH_LINK_CODE  MESH_HOME  OLLAMA_HOST_URL  NO_COLOR
        MESH_UPDATE_URL (latest.json; default <gateway>/install/latest.json)  MESH_AUTO_UPDATE=1 (install from 'start')
Privacy logs hold job ids, token counts and timings only; prompts and replies never touch disk (docs/PRIVACY.md)
`;

interface Args {
  cmd: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-n' && i + 1 < argv.length) {
      flags.n = argv[++i];
    } else if (a === '-h') {
      flags.help = true;
    } else if (a === '-v') {
      flags.version = true;
    } else cmd.push(a);
  }
  return { cmd, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function cmdSetup(flags: Args['flags']) {
  const link = str(flags.link) ?? process.env.MESH_LINK_CODE;
  const wallet = str(flags.wallet) ?? process.env.NODE_WALLET;
  if (!link && !wallet) {
    throw new Error('--link <code> is required: open the Mesh app, Run a node -> "Link a Mac", and paste the code (or --wallet <addr> on a gateway that allows unsigned registration)');
  }
  await setup({
    link,
    wallet,
    gateway: str(flags.gateway),
    ollama: str(flags.ollama),
    models: str(flags.models)?.split(',').map((s) => s.trim()).filter(Boolean),
    with70b: flags['with-70b'] === true,
    skipPull: flags['skip-pull'] === true,
  });
}

async function cmdStart() {
  const cfg = requireConfig();
  const underService = process.env.MESH_SERVICE === '1';
  // launchd already redirects stdout to node.log; in a terminal we mirror lines there ourselves.
  const log = createLogger(underService ? undefined : paths.nodeLog());
  mkdirSync(paths.logsDir(), { recursive: true });
  log.info(`mesh-node ${AGENT_VERSION} starting: node=${cfg.nodeId} gateway=${cfg.gateway} models=${cfg.models.join(',')}`);

  const ollama = new OllamaClient(cfg.ollama);
  if (!(await ollama.isUp())) log.warn(`Ollama is not answering at ${cfg.ollama}; jobs will fail until it is up (run \`ollama serve\`)`);
  else {
    const have = await ollama.listModels().catch(() => [] as string[]);
    const missing = cfg.models.filter((m) => !have.includes(m) && !have.includes(`${m}:latest`));
    if (missing.length) log.warn(`models advertised but not pulled: ${missing.join(', ')} (ollama pull <model>)`);
  }
  if (existsSync(paths.pauseFlag())) log.info('pause flag present; heartbeating as busy until `mesh-node resume`');

  const handle = startLoop({
    config: cfg,
    log,
    onReregister: (next) => saveConfig(next),
  });
  // Daily update check (logs only; MESH_AUTO_UPDATE=1 installs). Brew installs are upgraded by brew.
  const updateAc = new AbortController();
  if (process.env.MESH_UPDATE_CHECK !== '0') {
    const brew = installChannel() === 'brew';
    void runUpdateChecks({
      url: updateUrl(cfg.gateway),
      log,
      autoInstall: process.env.MESH_AUTO_UPDATE === '1' && !brew,
      signal: updateAc.signal,
    });
  }
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${sig}`);
    updateAc.abort();
    void handle.stop().then(() => {
      const s = handle.stats();
      log.info(`stopped after ${s.jobs} job(s), ${s.failed} failed`);
      process.exit(0);
    });
    // Hard exit if a job refuses to end.
    setTimeout(() => process.exit(0), 30_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await handle.done;
}

async function cmdUpdate(flags: Args['flags']) {
  const cfg = loadConfig();
  const url = process.env.MESH_UPDATE_URL?.trim() || (cfg ? updateUrl(cfg.gateway) : null);
  if (!url) throw new Error('no node configured and MESH_UPDATE_URL unset; run `mesh-node setup` first or set MESH_UPDATE_URL=https://<web-host>/downloads/latest.json');
  out.step(`checking ${url}`);
  const res = await checkForUpdate({ url });
  if (!res.available) {
    out.ok(`mesh-node ${res.current} is up to date (latest ${res.latest.version})`);
    return;
  }
  out.line(`   latest ${c.bold(res.latest.version)}${res.latest.publishedAt ? c.dim(`  published ${res.latest.publishedAt.slice(0, 10)}`) : ''}, running ${res.current}`);
  if (flags.check) {
    out.warn(`update available: run \`mesh-node update\` to install`);
    process.exitCode = 2;
    return;
  }
  if (installChannel() === 'brew') {
    out.warn('this copy was installed with Homebrew; upgrade it with: brew upgrade mesh-network/tap/mesh-node');
    process.exitCode = 2;
    return;
  }
  out.step(`downloading ${res.latest.bundleUrl}`);
  const r = await applyUpdate({ latest: res.latest });
  out.ok(`installed mesh-node ${r.version} at ${r.target} (sha256 verified)`);
  out.line(`   service: ${r.service === 'restarted' ? 'restarted' : r.service === 'failed' ? 'could not restart; run `mesh-node service install`' : 'not installed; restart `mesh-node start` yourself'}`);
}

async function cmdStatus(flags: Args['flags']) {
  const cfg = requireConfig();
  const gateway = new GatewayClient(cfg.gateway, cfg.nodeToken);
  const paused = existsSync(paths.pauseFlag());
  let stats: Awaited<ReturnType<GatewayClient['stats']>> | null = null;
  let error: string | null = null;
  try {
    stats = await gateway.stats(cfg.nodeId);
  } catch (err) {
    error = (err as Error).message;
  }
  if (flags.json) {
    out.line(
      JSON.stringify(
        {
          nodeId: cfg.nodeId,
          wallet: cfg.wallet,
          gateway: cfg.gateway,
          chip: cfg.chip,
          ramGb: cfg.ramGb,
          models: cfg.models,
          paused,
          service: serviceStatus(),
          agentVersion: AGENT_VERSION,
          stats,
          error,
        },
        null,
        2,
      ),
    );
    if (error) process.exitCode = 1;
    return;
  }
  const status = stats?.status ?? (error ? 'unknown' : 'offline');
  const statusText = status === 'online' || status === 'idle' ? c.green(status) : status === 'busy' ? c.cyan('busy') : status === 'offline' ? c.red('offline') : c.yellow(status);
  out.title(`mesh-node ${cfg.nodeId}`);
  out.line(
    table([
      ['status', `${statusText}${paused ? c.yellow('  (paused)') : ''}`],
      ['service', serviceStatus()],
      ['uptime 24h', fmt.pct(stats?.uptimePct24h)],
      ['jobs 24h', fmt.int(stats?.jobs24h)],
      ['tokens 24h', fmt.int(stats?.tokens24h)],
      ['earned 24h', `${fmt.usd(stats?.earnedUsd24h, 4)} credits`],
      ['earned total', `${fmt.usd(stats?.earnedUsdTotal, 4)} credits`],
      ['last seen', fmt.ago(stats?.lastSeen)],
      ['models', cfg.models.join(', ') || '-'],
      ['machine', `${cfg.chip} · ${cfg.ramGb} GB`],
      ['wallet', cfg.wallet],
      ['gateway', cfg.gateway],
      ['privacy', 'counts only; no prompts or replies are kept on this machine'],
    ]),
  );
  if (error) {
    out.line();
    out.warn(`could not fetch live stats: ${error}`);
    process.exitCode = 1;
  }
  out.line();
}

function cmdService(sub: string | undefined) {
  const script = realpathSync(process.argv[1]);
  if (sub === 'install') {
    requireConfig();
    const { plist } = installService(script);
    out.ok(`launchd agent installed: ${plist}`);
    out.line(`   logs: ${paths.nodeLog()}   (mesh-node logs)`);
    out.line(`   it starts at login and restarts if it crashes.`);
  } else if (sub === 'uninstall') {
    const { plist, existed } = uninstallService();
    out.ok(existed ? `launchd agent removed: ${plist}` : 'no launchd agent was installed');
  } else if (sub === 'status') {
    out.line(serviceStatus());
  } else {
    throw new Error('usage: mesh-node service install|uninstall|status');
  }
}

function cmdPause(pause: boolean) {
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
  const flag = paths.pauseFlag();
  if (pause) {
    writeFileSync(flag, `${new Date().toISOString()}\n`);
    out.ok('paused: the node stops taking new jobs after the current one and heartbeats as busy');
  } else {
    if (existsSync(flag)) unlinkSync(flag);
    out.ok('resumed: the node takes jobs again');
  }
}

function cmdLogs(flags: Args['flags']) {
  const file = paths.nodeLog();
  if (!existsSync(file)) {
    out.warn(`no log yet at ${file}. Start the node with \`mesh-node start\` or \`mesh-node service install\`.`);
    return;
  }
  const n = str(flags.n) ?? '100';
  const args = flags.follow === false || flags['no-follow'] ? ['-n', n, file] : ['-n', n, '-f', file];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { cmd, flags } = parseArgs(argv);
  if (flags.version) {
    out.line(AGENT_VERSION);
    return;
  }
  if (flags.help || cmd.length === 0) {
    out.line(HELP);
    return;
  }
  switch (cmd[0]) {
    case 'setup':
      return cmdSetup(flags);
    case 'start':
    case 'run':
      return cmdStart();
    case 'status':
      return cmdStatus(flags);
    case 'service':
      return cmdService(cmd[1]);
    case 'pause':
      return cmdPause(true);
    case 'resume':
      return cmdPause(false);
    case 'logs':
      return cmdLogs(flags);
    case 'update':
      return cmdUpdate(flags);
    case 'config':
      out.line(JSON.stringify({ ...loadConfig(), nodeToken: '<redacted>' }, null, 2));
      return;
    default:
      throw new Error(`unknown command "${cmd[0]}"\n\n${HELP}`);
  }
}

export function runCli(): void {
  main().catch((err) => {
    const e = err as Error;
    out.fail(e instanceof GatewayError ? `gateway: ${e.message}` : e.message);
    process.exit(1);
  });
}
