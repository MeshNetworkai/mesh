import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { CONFIG_SETTERS, loadConfig, requireConfig, saveConfig } from './config.js';
import { GatewayClient, GatewayError } from './gateway.js';
import { createLogger } from './log.js';
import { startLoop } from './loop.js';
import { OllamaClient, ollamaServeEnv } from './ollama.js';
import { AGENT_VERSION, paths } from './paths.js';
import { installService, serviceStatus, uninstallService } from './service.js';
import { setup } from './setup.js';
import { spawnDetached, which } from './system.js';
import { c, fmt, out, table } from './ui.js';
import { applyUpdate, checkForUpdate, installChannel, rollbackUpdate, runUpdateChecks, updateUrl } from './update.js';

const HELP = `mesh-node ${AGENT_VERSION} - serve AI replies from this machine and earn for them

Usage
  mesh-node setup --link <code> [--gateway <url>] [--models a,b] [--with-70b] [--ollama <url>] [--max-parallel N]
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
                                  --check only reports; --rollback puts the previous version back.
                                  'start' checks daily and logs when one exists.
  mesh-node config                show the saved config (token redacted)
  mesh-node config set <key> <v>  change a setting, e.g. config set maxParallel 2 (then restart the node)
                                  keys: ${Object.entries(CONFIG_SETTERS).map(([k, v]) => `${k} - ${v.help}`).join('\n                                        ')}
  mesh-node --version | --help

Files   ~/.mesh/config.json (0600)  ~/.mesh/logs/  ~/.mesh/paused  ~/.mesh/bin/mesh-node.js (+ .prev after an update)
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
    maxParallel: str(flags['max-parallel']) !== undefined ? Number(str(flags['max-parallel'])) : undefined,
  });
}

async function cmdStart() {
  const cfg = requireConfig();
  const underService = process.env.MESH_SERVICE === '1';
  // launchd already redirects stdout to node.log; in a terminal we mirror lines there ourselves.
  const log = createLogger(underService ? undefined : paths.nodeLog());
  mkdirSync(paths.logsDir(), { recursive: true });
  log.info(`mesh-node ${AGENT_VERSION} starting: node=${cfg.nodeId} gateway=${cfg.gateway} models=${cfg.models.join(',')}`);

  // Nothing a job does may take the process down: launchd would restart it (fine), but a crash loop
  // on a poison job would not be. Log and keep serving; a genuinely broken process still exits.
  process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception: ${err.stack ?? err.message}`);
    process.exit(1);
  });

  const ollama = new OllamaClient(cfg.ollama);
  if (!(await ollama.isUp())) await startOllamaIfLocal(cfg, ollama, log);
  if (!(await ollama.isUp())) log.warn(`Ollama is not answering at ${cfg.ollama}; jobs will fail until it is up (open the Ollama app or run \`ollama serve\`)`);
  else {
    const have = await ollama.listModels().catch(() => [] as string[]);
    const missing = cfg.models.filter((m) => !have.includes(m) && !have.includes(`${m}:latest`));
    if (missing.length) log.warn(`models advertised but not pulled: ${missing.join(', ')} (ollama pull <model>)`);
  }
  if (existsSync(paths.pauseFlag())) log.info('pause flag present; heartbeating as busy until `mesh-node resume`');
  if (cfg.maxParallel > 1) log.info(`running up to ${cfg.maxParallel} jobs at once`);

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
    handle
      .stop()
      .catch((err: Error) => log.error(`error while stopping: ${err.message}`))
      .then(() => {
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

/**
 * Under launchd nobody is there to open the Ollama app: when Ollama is local and installed but not
 * running, start `ollama serve` ourselves (privacy env + OLLAMA_NUM_PARALLEL) and wait for it briefly.
 */
async function startOllamaIfLocal(cfg: { ollama: string; maxParallel: number }, ollama: OllamaClient, log: ReturnType<typeof createLogger>): Promise<void> {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.ollama)) return;
  const bin = which('ollama');
  if (!bin) return;
  try {
    mkdirSync(paths.logsDir(), { recursive: true });
    spawnDetached(bin, ['serve'], paths.ollamaLog(), ollamaServeEnv(cfg.maxParallel));
    log.info(`Ollama was not running; started \`ollama serve\` (log: ${paths.ollamaLog()})`);
  } catch (err) {
    log.warn(`could not start ollama serve: ${(err as Error).message}`);
    return;
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ollama.isUp()) return;
  }
}

async function cmdUpdate(flags: Args['flags']) {
  if (flags.rollback) {
    if (installChannel() === 'brew') throw new Error('this copy was installed with Homebrew; roll back with brew instead (brew switch / reinstall)');
    const r = rollbackUpdate();
    out.ok(`restored the previous mesh-node from ${r.backup}`);
    out.line(`   service: ${r.service === 'restarted' ? 'restarted' : r.service === 'failed' ? 'could not restart; run `mesh-node service install`' : 'not installed; restart `mesh-node start` yourself'}`);
    return;
  }
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
    out.warn('this copy was installed with Homebrew; upgrade it with: brew upgrade meshnetworkai/tap/mesh-node');
    process.exitCode = 2;
    return;
  }
  out.step(`downloading ${res.latest.bundleUrl}`);
  const r = await applyUpdate({ latest: res.latest });
  out.ok(`installed mesh-node ${r.version} at ${r.target} (sha256 verified, test-started)`);
  if (r.backup) out.line(`   previous version kept at ${r.backup} (mesh-node update --rollback)`);
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
    error = explainStatusError(err, cfg.gateway);
  }
  const service = serviceStatus();
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
          maxParallel: cfg.maxParallel,
          service,
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
  const statusText = status === 'online' || status === 'idle' ? c.green(status) : status === 'busy' ? c.cyan('busy') : status === 'offline' ? c.red('offline') : c.yellow('unknown (gateway unreachable)');
  out.title(`mesh-node ${cfg.nodeId}`);
  out.line(
    table([
      ['status', `${statusText}${paused ? c.yellow('  (paused)') : ''}${stats?.quarantined ? c.red('  (quarantined)') : ''}`],
      ['service', service],
      ['uptime 24h', fmt.pct(stats?.uptimePct24h)],
      ['jobs 24h', fmt.int(stats?.jobs24h)],
      ['tokens 24h', fmt.int(stats?.tokens24h)],
      ['earned 24h', `${fmt.usd(stats?.earnedUsd24h, 4)} credits`],
      ['earned total', `${fmt.usd(stats?.earnedUsdTotal, 4)} credits`],
      ['last seen', fmt.ago(stats?.lastSeen)],
      ['models', cfg.models.join(', ') || '-'],
      ['parallel jobs', `${typeof stats?.runningJobs === 'number' ? `${stats.runningJobs} running of ` : ''}${stats?.maxParallel ?? cfg.maxParallel}`],
      ['machine', `${cfg.chip} · ${cfg.ramGb} GB`],
      ['wallet', cfg.wallet],
      ['gateway', cfg.gateway],
      ['privacy', 'counts only; no prompts or replies are kept on this machine'],
    ]),
  );
  out.line();
  if (error) {
    out.warn(error);
    process.exitCode = 1;
  } else if (status === 'offline') {
    if (service === 'running') out.warn('the node process is running but the gateway has not heard from it recently; check `mesh-node logs`');
    else if (service === 'loaded') out.warn('the background service is installed but not running; it restarts on its own, or run `mesh-node service install` again');
    else out.warn('the node is not running; start it with `mesh-node start` or `mesh-node service install`');
  } else if (paused) out.line(`   paused: no new jobs until \`mesh-node resume\``);
  out.line();
}

/** One plain-English line for a failed GET /nodes/:id. */
export function explainStatusError(err: unknown, gateway: string): string {
  if (!(err instanceof GatewayError)) return `could not fetch live stats: ${(err as Error).message}`;
  if (err.status === 0) return `cannot reach the gateway at ${gateway} (${err.message.replace(/^could not reach gateway at \S+: /, '')}). Check your internet connection; if it is fine, the gateway may be down. The node keeps retrying on its own.`;
  if (err.status === 401 || err.status === 404) return `the gateway no longer recognises this node (${err.status}). The running node re-registers itself; if this persists, run \`mesh-node setup --link <code>\` again.`;
  if (err.status === 429) return 'the gateway is rate-limiting status requests; try again in a minute.';
  if (err.status >= 500) return `the gateway is having trouble (${err.status}); try again shortly. The node keeps retrying on its own.`;
  return `could not fetch live stats: ${err.message}`;
}

function cmdConfig(sub: string | undefined, key: string | undefined, value: string | undefined) {
  if (sub === undefined || sub === 'show' || sub === 'get') {
    const cfg = loadConfig();
    if (!cfg) {
      out.warn(`no node configured at ${paths.config()}; run \`mesh-node setup --link <code>\``);
      return;
    }
    if (sub === 'get' && key) {
      const v = (cfg as unknown as Record<string, unknown>)[key];
      if (v === undefined) throw new Error(`unknown config key "${key}"`);
      out.line(key === 'nodeToken' ? '<redacted>' : typeof v === 'string' ? v : JSON.stringify(v));
      return;
    }
    out.line(JSON.stringify({ ...cfg, nodeToken: '<redacted>' }, null, 2));
    return;
  }
  if (sub === 'set') {
    const setter = key ? CONFIG_SETTERS[key] : undefined;
    if (!key || !setter) throw new Error(`usage: mesh-node config set <key> <value>\n  keys: ${Object.keys(CONFIG_SETTERS).join(', ')}`);
    if (value === undefined) throw new Error(`usage: mesh-node config set ${key} <value>  (${setter.help})`);
    const cfg = requireConfig();
    const patch = setter.parse(value);
    saveConfig({ ...cfg, ...patch });
    out.ok(`${key} = ${JSON.stringify(Object.values(patch)[0])} saved to ${paths.config()}`);
    out.line(`   restart the node for it to take effect: ${serviceStatus() === 'not installed' ? 'stop and re-run `mesh-node start`' : '`mesh-node service install` (reloads the background service)'}`);
    return;
  }
  throw new Error('usage: mesh-node config [show | get <key> | set <key> <value>]');
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
    out.ok('paused: the node finishes any job it is on, then takes no new ones (it stays online and keeps heartbeating)');
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
      return cmdConfig(cmd[1], cmd[2], cmd[3]);
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
