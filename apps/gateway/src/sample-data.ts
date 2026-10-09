// Sample network activity for testing the site before the token is live (env `MESH_SAMPLE_NODES`).
//
// With MESH_SAMPLE_NODES=N an operator signed in to the admin console sees N simulated Macs on top of the
// real ones on the read endpoints (GET /stats, /nodes, /status, /report, /v1/models), together with the
// requests, tokens, spend, savings and node rewards that many machines would produce. It is there to see
// what the site looks like at that scale.
//
// Who sees it: only a request that carries admin credentials (`sampleViewFor`). Everybody else, on the
// same URLs, gets the real figures, so nothing simulated is ever shown to a visitor as the state of the
// network. It also runs on the mock adapter only: once the gateway is on the live chain adapter the
// setting is ignored.
//
// Nothing is written to the database: no node, ledger row or reward exists for a simulated Mac, it
// cannot serve a job, and the admin console's own pages keep the real numbers. Every figure is a pure
// function of N and the clock, so the endpoints agree with each other and a restart changes nothing.
// Money amounts are the real price list and config applied to the sample volume. Responses that carry
// sample figures say so in a `sample` field.
import { upstreamBilledMicros, upstreamCostMicros } from '@mesh/config';
import type { FastifyRequest } from 'fastify';
import { isAdminRequest, type AppContext } from './context.js';
import { nowSec } from './db.js';
import { nodeRewardMicros } from './ledger.js';
import { bpsOf, usdToMicros } from './money.js';
import { networkCostMicros } from './relay.js';
import { listCostMicros, savedMicros } from './savings.js';

type SampleCtx = Pick<AppContext, 'config' | 'prices' | 'policy'> & { env?: { MESH_SAMPLE_NODES?: number }; adapterStatus?: string; sampleViewer?: boolean };

const HOUR = 3600;
const DAY = 86_400;
/** Simulated activity exists for this long back from now; all-time totals count this window. */
const HISTORY_DAYS = 30;
/** Requests one simulated Mac of average size serves in an hour at the daily peak. */
const PEAK_REQUESTS_PER_NODE_HOUR = 21;
/** Share of the simulated traffic the Macs serve; the rest goes to frontier models upstream. */
const NETWORK_SHARE = 0.62;

/** Test mode as configured: `MESH_SAMPLE_NODES` while the gateway runs the mock adapter, else 0. */
export function sampleConfigured(ctx: Pick<SampleCtx, 'env' | 'adapterStatus'>): number {
  const n = ctx.env?.MESH_SAMPLE_NODES ?? 0;
  if (n <= 0) return 0;
  // Same test as GET /stats `tokenLive`: sample figures never mix with a live token.
  return (ctx.adapterStatus ?? 'mock').startsWith('mock') ? n : 0;
}

/** How many simulated Macs this view of the gateway includes: the configured number for an operator's view, 0 for everyone else. */
export function sampleNodeCount(ctx: Pick<SampleCtx, 'env' | 'adapterStatus' | 'sampleViewer'>): number {
  return ctx.sampleViewer ? sampleConfigured(ctx) : 0;
}

/**
 * The context to answer `req` with: the gateway's own for a visitor, and for a signed-in operator while
 * test mode is on a view of it that includes the simulated Macs (same database, same everything else).
 */
export async function sampleViewFor(ctx: AppContext, req: FastifyRequest): Promise<AppContext> {
  if (sampleConfigured(ctx) === 0 || !(await isAdminRequest(ctx, req))) return ctx;
  return Object.create(ctx, { sampleViewer: { value: true, enumerable: true } }) as AppContext;
}

export interface SampleInfo {
  /** Simulated Macs included in the node counts. */
  nodes: number;
  note: string;
}

/** The `sample` field of a response that includes simulated figures, or null when there are none. */
export function sampleInfo(ctx: Pick<SampleCtx, 'env' | 'adapterStatus' | 'sampleViewer'>): SampleInfo | null {
  const nodes = sampleNodeCount(ctx);
  return nodes > 0 ? { nodes, note: `Test mode (operator view): figures include ${nodes} simulated Macs and the activity they would produce. Visitors get the real figures.` } : null;
}

/** Deterministic value in [0, 1) for an integer seed (a mulberry32 step): the same seed always gives the same number. */
function unit(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

/** How busy the network is in the hour starting at `hourStart`, 0..1: a daily curve, quieter weekends, hourly noise. */
function load(hourStart: number): number {
  const hourOfDay = Math.floor(hourStart / HOUR) % 24;
  const weekday = (Math.floor(hourStart / DAY) + 4) % 7; // 1970-01-01 was a Thursday
  const daily = 0.42 + 0.58 * Math.sin((Math.PI * ((hourOfDay + 20) % 24)) / 24) ** 2; // peaks mid-afternoon UTC
  const weekend = weekday === 0 || weekday === 6 ? 0.82 : 1;
  return daily * weekend * (0.88 + 0.24 * unit(Math.floor(hourStart / HOUR)));
}

// ---------- machines ----------

const CHIPS: Array<{ chip: string; share: number; ram: number[]; power: number; parallel: number }> = [
  { chip: 'Apple M1', share: 9, ram: [16], power: 1, parallel: 1 },
  { chip: 'Apple M1 Pro', share: 8, ram: [16, 32], power: 1.5, parallel: 2 },
  { chip: 'Apple M1 Max', share: 6, ram: [32, 64], power: 2.2, parallel: 2 },
  { chip: 'Apple M2', share: 12, ram: [16, 24], power: 1.15, parallel: 1 },
  { chip: 'Apple M2 Pro', share: 11, ram: [16, 32], power: 1.7, parallel: 2 },
  { chip: 'Apple M2 Max', share: 8, ram: [32, 64, 96], power: 2.6, parallel: 2 },
  { chip: 'Apple M2 Ultra', share: 2, ram: [64, 128, 192], power: 3.6, parallel: 4 },
  { chip: 'Apple M3', share: 9, ram: [16, 24], power: 1.35, parallel: 1 },
  { chip: 'Apple M3 Pro', share: 10, ram: [18, 36], power: 1.9, parallel: 2 },
  { chip: 'Apple M3 Max', share: 8, ram: [36, 48, 64, 128], power: 3, parallel: 2 },
  { chip: 'Apple M4', share: 7, ram: [16, 24, 32], power: 1.6, parallel: 1 },
  { chip: 'Apple M4 Pro', share: 7, ram: [24, 48], power: 2.3, parallel: 2 },
  { chip: 'Apple M4 Max', share: 3, ram: [36, 64, 128], power: 3.4, parallel: 4 },
];
const CHIP_SHARES = CHIPS.reduce((a, c) => a + c.share, 0);

/** Least RAM (GB) a simulated Mac needs to advertise a network model, by Ollama tag; unknown tags need 16. */
const MODEL_MIN_RAM: Record<string, number> = { 'llama3.1:8b': 16, 'qwen2.5:7b': 16, 'qwen2.5:14b': 24, 'llama3.1:70b': 64 };

export interface SampleMachine {
  /** Display id, `sim_` + 4 hex: recognisable next to a real node's id. */
  id: string;
  chip: string;
  ramGb: number;
  models: string[];
  maxParallel: number;
  /** Jobs it is running right now. */
  running: number;
  /** Joined (unix seconds). */
  since: number;
  agentVersion: string;
  uptimePct24h: number;
  /** Its share of the simulated traffic, relative to the other machines. */
  weight: number;
}

/** The Ollama tags simulated Macs can advertise: the configured network models, without the offline mock. */
function networkTags(ctx: Pick<SampleCtx, 'policy'>): string[] {
  return [...new Set(Object.values(ctx.policy.networkModels ?? {}))].filter((tag) => !tag.startsWith('mesh/'));
}

/** The simulated Macs, in a stable order: machine `i` is the same machine on every call. */
export function sampleMachines(ctx: SampleCtx, now = nowSec()): SampleMachine[] {
  const n = sampleNodeCount(ctx);
  const tags = networkTags(ctx);
  const busyNow = load(Math.floor(now / HOUR) * HOUR);
  const out: SampleMachine[] = [];
  for (let i = 0; i < n; i++) {
    const seed = (i + 1) * 7919;
    let pick = unit(seed) * CHIP_SHARES;
    const c = CHIPS.find((x) => (pick -= x.share) < 0) ?? CHIPS[0];
    const ramGb = c.ram[Math.floor(unit(seed + 1) * c.ram.length)];
    const fits = tags.filter((tag) => (MODEL_MIN_RAM[tag] ?? 16) <= ramGb);
    // Everybody runs the first model that fits; the larger ones are advertised by about two machines in three.
    const models = fits.filter((_, k) => k === 0 || unit(seed + 10 + k) < 0.66);
    const uptimePct24h = unit(seed + 2) < 0.7 ? 100 : Math.round((91 + unit(seed + 3) * 8.9) * 10) / 10;
    // Jobs in flight change every 20 seconds (a heartbeat), following the hour's load.
    let running = 0;
    for (let slot = 0; slot < c.parallel; slot++) if (unit(seed + 100 + slot + Math.floor(now / 20) * 31) < busyNow * 0.45) running++;
    out.push({
      id: `sim_${Math.floor(unit(seed + 4) * 0x10000).toString(16).padStart(4, '0')}`,
      chip: c.chip,
      ramGb,
      models,
      maxParallel: c.parallel,
      running,
      since: now - Math.floor((2 + unit(seed + 5) * 41) * DAY),
      agentVersion: '0.1.0',
      uptimePct24h,
      // Bigger chips serve more; no two machines of one kind are equally busy.
      weight: c.power * (uptimePct24h / 100) * (0.7 + 0.6 * unit(seed + 6)),
    });
  }
  return out;
}

export interface SampleFleet {
  nodes: number;
  busy: number;
  slots: number;
  running: number;
  ramGb: number;
  chips: Record<string, number>;
  models: Record<string, number>;
}

/** The simulated Macs as counts, in the shape of GET /nodes. */
export function sampleFleet(ctx: SampleCtx, now = nowSec()): SampleFleet {
  const fleet: SampleFleet = { nodes: 0, busy: 0, slots: 0, running: 0, ramGb: 0, chips: {}, models: {} };
  for (const m of sampleMachines(ctx, now)) {
    fleet.nodes++;
    fleet.slots += m.maxParallel;
    fleet.running += m.running;
    if (m.running >= m.maxParallel) fleet.busy++;
    fleet.ramGb += m.ramGb;
    fleet.chips[m.chip] = (fleet.chips[m.chip] ?? 0) + 1;
    for (const tag of m.models) fleet.models[tag] = (fleet.models[tag] ?? 0) + 1;
  }
  return fleet;
}

// ---------- activity ----------

export interface SampleActivity {
  /** All simulated requests: served by the simulated Macs plus the ones that went upstream. */
  requests: number;
  networkRequests: number;
  networkTokens: number;
  /** What the simulated requests would have been billed, micro-USD. */
  spendMicros: number;
  /** What the network-served ones would have saved against list price, micro-USD. */
  savedMicros: number;
  /** What the simulated Macs would have earned, micro-USD. */
  rewardMicros: number;
  /** The margin on the network-served and the upstream-served requests (billed − reward, billed − upstream cost), micro-USD. */
  networkMarginMicros: number;
  upstreamMarginMicros: number;
  upstreamRequests: number;
}

const NO_ACTIVITY: SampleActivity = { requests: 0, networkRequests: 0, networkTokens: 0, spendMicros: 0, savedMicros: 0, rewardMicros: 0, networkMarginMicros: 0, upstreamMarginMicros: 0, upstreamRequests: 0 };

/** Prices that do not change from hour to hour, worked out once per call. */
interface Rates {
  /** One average request to a frontier model: what the wallet is billed and what is left after the upstream's own price. */
  upstreamBilledMicros: number;
  upstreamMarginMicros: number;
  /** Micro-USD saved per 1M network tokens against list price, across the models the simulated Macs run. */
  savedPerMTokens: number;
}

function rates(ctx: SampleCtx, now: number): Rates {
  const pricing = ctx.config.requestPricing;
  // The upstream side is priced as the median model on the list, at a typical request size.
  const models = Object.values(ctx.prices.models ?? {}).sort((a, b) => a.promptUsdPerM - b.promptUsdPerM);
  const mid = models[Math.floor(models.length / 2)];
  const list = mid ? usdToMicros((950 * mid.promptUsdPerM + 380 * mid.completionUsdPerM) / 1_000_000) : 0;
  const billed = upstreamBilledMicros(list, pricing);
  // Savings: each model's list price for 1M tokens against the flat network price, weighted by how many machines run it.
  const fleet = sampleFleet(ctx, now).models;
  const advertised = Object.values(fleet).reduce((a, b) => a + b, 0) || 1;
  const networkPerM = networkCostMicros(1_000_000, pricing.networkPricePerMTokens);
  let savedPerMTokens = 0;
  for (const [tag, machines] of Object.entries(fleet)) {
    const alias = Object.entries(ctx.policy.networkModels ?? {}).find(([, t]) => t === tag)?.[0];
    if (!alias) continue;
    const listPerM = listCostMicros({ prompt_tokens: 680_000, completion_tokens: 320_000 }, alias, ctx.prices, ctx.policy);
    savedPerMTokens += (machines / advertised) * savedMicros(listPerM, networkPerM);
  }
  return { upstreamBilledMicros: billed, upstreamMarginMicros: Math.max(0, billed - upstreamCostMicros(list, pricing)), savedPerMTokens };
}

/** The whole hour starting at `hourStart`, for `n` simulated Macs. */
function hourActivity(ctx: SampleCtx, n: number, hourStart: number, r: Rates): SampleActivity {
  const h = Math.floor(hourStart / HOUR);
  const networkRequests = Math.round(n * PEAK_REQUESTS_PER_NODE_HOUR * load(hourStart));
  const upstreamRequests = Math.round(networkRequests * ((1 - NETWORK_SHARE) / NETWORK_SHARE) * (0.9 + 0.2 * unit(h + 1_000_003)));
  const networkTokens = Math.round(networkRequests * (1180 + 340 * unit(h + 2_000_003)));
  const networkSpend = networkCostMicros(networkTokens, ctx.config.requestPricing.networkPricePerMTokens);
  // The same ceiling a real job gets (relay.ts): never more than the configured share of what was billed.
  const reward = Math.min(bpsOf(networkSpend, ctx.config.nodeRewards.maxShareOfPriceBps), nodeRewardMicros(networkTokens, ctx.config.nodeRewards.usdPerMTokens));
  return {
    requests: networkRequests + upstreamRequests,
    networkRequests,
    networkTokens,
    spendMicros: networkSpend + upstreamRequests * r.upstreamBilledMicros,
    savedMicros: (networkTokens * r.savedPerMTokens) / 1_000_000,
    rewardMicros: reward,
    networkMarginMicros: networkSpend - reward,
    upstreamMarginMicros: upstreamRequests * r.upstreamMarginMicros,
    upstreamRequests,
  };
}

/**
 * Simulated activity in [from, to) (unix seconds). Hours are deterministic; an hour the window only partly
 * covers (the current one, or the edges) counts in proportion. Nothing exists before `HISTORY_DAYS` ago or
 * after `now`.
 */
export function sampleActivity(ctx: SampleCtx, from: number, to: number, now = nowSec()): SampleActivity {
  const n = sampleNodeCount(ctx);
  const start = Math.max(from, now - HISTORY_DAYS * DAY);
  const end = Math.min(to, now);
  if (n <= 0 || end <= start) return NO_ACTIVITY;
  const r = rates(ctx, now);
  const sum = { ...NO_ACTIVITY };
  for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
    const part = (Math.min(end, h + HOUR) - Math.max(start, h)) / HOUR;
    const a = hourActivity(ctx, n, h, r);
    for (const k of Object.keys(sum) as Array<keyof SampleActivity>) sum[k] += a[k] * part;
  }
  for (const k of Object.keys(sum) as Array<keyof SampleActivity>) sum[k] = Math.round(sum[k]);
  return sum;
}

/**
 * The simulated usage-revenue share for [from, to): what the holders' and the treasury's part of those
 * margins would be under config `usageShare`, in the shape of usage-share.ts `usageShareTotals`.
 */
export function sampleUsageShare(ctx: SampleCtx, from: number, to: number, now = nowSec()) {
  const cfg = ctx.config.usageShare;
  const a = sampleActivity(ctx, from, to, now);
  const side = (marginMicros: number, requests: number, on: boolean) => {
    const counted = cfg.enabled && on ? marginMicros : 0;
    const holders = bpsOf(counted, cfg.holderBps);
    return { marginMicros: counted, holderMicros: holders, treasuryMicros: counted - holders, requests: counted > 0 ? requests : 0 };
  };
  return { network: side(a.networkMarginMicros, a.networkRequests, cfg.sources.network), upstream: side(a.upstreamMarginMicros, a.upstreamRequests, cfg.sources.upstream) };
}
