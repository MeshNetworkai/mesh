import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addNodeReward, nodeRewardMicros, withholdNodeReward } from './ledger.js';
import type { JobBroker, JobPayload, JobRow, JobUsage } from './network.js';
import { eligibleNodes, nodeReputation, reputationConfig, type NodeRow, type RouteDeps } from './routing.js';
import type { Upstream, Usage } from './upstream.js';

/**
 * Spot-check verification of node work (docs/NODE_PROTOCOL.md §10, docs/PRIVACY.md §3).
 *
 * After a network node has answered a client, a sampled fraction of those jobs is re-run on a second
 * eligible node of the same tier (or the upstream when no other node is available) at temperature 0,
 * and the two outputs are compared with cheap heuristics: token-count sanity, garbage detection and a
 * word-shingle similarity score with a lenient threshold. Verdicts are recorded in `verifications`.
 * A `mismatch` costs the primary node `mismatchPenalty` reputation failures and that job's reward;
 * `quarantineAfterMismatches` mismatches in the reputation window quarantine the node (no routing, no
 * pulls) until an admin clears it.
 *
 * The check re-uses the already anonymised job payload (`jobs.payload`): the second node sees exactly
 * what the first saw, under the same privacy tier, so a check reveals nothing new to anyone.
 */

export type VerificationConfig = TokenomicsConfig['verification'];
export type Verdict = 'ok' | 'suspect' | 'mismatch' | 'inconclusive';

/** Below this similarity (with a token-count failure) the outputs are considered unrelated. Lenient on purpose. */
export const MISMATCH_SIMILARITY = 0.05;
/** Below this similarity the job is marked `suspect` (no penalty, but visible in the stats). */
export const SUSPECT_SIMILARITY = 0.2;
/** Token counts must agree within this factor (0.5 → the smaller is at least half the larger). */
export const TOKEN_TOLERANCE = 0.5;
/** New-node multiplier on the sample rate. */
export const NEW_NODE_SAMPLE_MULTIPLIER = 3;

export interface VerificationRow {
  id: number;
  job_id: string;
  check_job_id: string | null;
  primary_node: string;
  check_node: string;
  score: number | null;
  verdict: Verdict;
  reasons: string;
  primary_tokens: number | null;
  check_tokens: number | null;
  created_at: number;
}

// ---------------- sampling ----------------

/** Rate for a node with `nodeJobs` scored jobs: 3× for nodes still below `minJobsBeforeTrust`, capped at 1. */
export function effectiveSampleRate(cfg: Pick<VerificationConfig, 'sampleRate' | 'minJobsBeforeTrust'>, nodeJobs: number): number {
  const base = cfg.sampleRate;
  return nodeJobs < cfg.minJobsBeforeTrust ? Math.min(1, base * NEW_NODE_SAMPLE_MULTIPLIER) : base;
}

export interface SampleInput {
  /** Scored jobs the primary node has (reputation window). */
  nodeJobs: number;
  /** Job tier and whether the serving node belongs to the requester (owner rule): own nodes are never checked. */
  privacy: 'trusted' | 'network';
  ownNode: boolean;
  /** The job itself was a verification re-run: never check a check. */
  isCheck: boolean;
  rand?: () => number;
}

export function shouldSample(cfg: Pick<VerificationConfig, 'enabled' | 'sampleRate' | 'minJobsBeforeTrust'>, input: SampleInput): boolean {
  if (!cfg.enabled || input.isCheck) return false;
  if (input.privacy === 'trusted' && input.ownNode) return false;
  const rate = effectiveSampleRate(cfg, input.nodeJobs);
  if (rate <= 0) return false;
  return (input.rand ?? Math.random)() < rate;
}

// ---------------- heuristics ----------------

/** Flags that mark an output as garbage regardless of what the check produced. */
export function garbageFlags(text: string): string[] {
  const flags: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    flags.push('empty');
    return flags;
  }
  // U+FFFD is what decoders emit for bytes that were not valid UTF-8; control chars other than whitespace are noise too.
  let bad = 0;
  for (const ch of trimmed) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) bad++;
  }
  const chars = [...trimmed].length;
  if (bad / chars > 0.05) flags.push('non_utf8');
  // Runs of one repeated character (model stuck in a loop or emitting padding).
  if (/(.)\1{39,}/su.test(trimmed)) flags.push('repeated_char_run');
  // Same short token repeated over and over ("the the the the …").
  const words = trimmed.split(/\s+/);
  if (words.length >= 12) {
    const distinct = new Set(words.map((w) => w.toLowerCase())).size;
    if (distinct / words.length < 0.08) flags.push('repeated_words');
  }
  // Mostly non-letter noise (long outputs only; short code/number replies are fine).
  if (chars >= 40) {
    const letters = (trimmed.match(/\p{L}|\p{N}/gu) ?? []).length;
    if (letters / chars < 0.3) flags.push('low_alnum');
  }
  return flags;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word shingles of size `n` (unigrams when the text is too short for bigrams). */
export function shingles(text: string, n = 2): Set<string> {
  const w = words(text);
  const size = w.length < 4 ? 1 : n;
  const out = new Set<string>();
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

/** Jaccard similarity of word bigrams, 0..1. Two empty texts are 1 (nothing to disagree about). */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface Output {
  text: string;
  completionTokens: number;
}

export interface Comparison {
  score: number;
  verdict: Exclude<Verdict, 'inconclusive'>;
  reasons: string[];
  /** min/max of the two completion token counts; null when either is 0. */
  tokenRatio: number | null;
}

/**
 * Compare the primary output with the check output. Garbage on the primary side is a mismatch on its
 * own; otherwise token-count sanity and similarity decide. The thresholds are lenient: the client may
 * have sampled at a high temperature, so only "clearly unrelated" is punished and "different wording"
 * is at most `suspect`.
 */
export function compareOutputs(primary: Output, check: Output): Comparison {
  const reasons: string[] = [];
  const garbage = garbageFlags(primary.text);
  for (const g of garbage) reasons.push(`primary_${g}`);
  const score = Math.round(similarity(primary.text, check.text) * 10_000) / 10_000;
  const lo = Math.min(primary.completionTokens, check.completionTokens);
  const hi = Math.max(primary.completionTokens, check.completionTokens);
  const tokenRatio = hi === 0 ? null : lo / hi;
  const tokensSane = tokenRatio === null ? true : tokenRatio >= TOKEN_TOLERANCE;
  if (!tokensSane) reasons.push(`token_count_${primary.completionTokens}_vs_${check.completionTokens}`);
  // Reported token count that cannot match the text (claims hundreds of tokens for a handful of characters, or the reverse).
  const estimated = Math.max(1, Math.ceil(primary.text.length / 4));
  const claimRatio = Math.min(estimated, primary.completionTokens || 0) / Math.max(estimated, primary.completionTokens || 1);
  const claimSane = primary.completionTokens === 0 || claimRatio >= 0.2;
  if (!claimSane) reasons.push(`token_claim_${primary.completionTokens}_for_${primary.text.length}_chars`);
  if (score < SUSPECT_SIMILARITY) reasons.push(`similarity_${score}`);

  let verdict: Comparison['verdict'] = 'ok';
  if (garbage.length > 0 || !claimSane) verdict = 'mismatch';
  else if (score < MISMATCH_SIMILARITY && !tokensSane) verdict = 'mismatch';
  else if (score < SUSPECT_SIMILARITY || !tokensSane) verdict = 'suspect';
  return { score, verdict, reasons, tokenRatio };
}

// ---------------- stats ----------------

export interface NodeVerificationStats {
  checked: number;
  ok: number;
  suspect: number;
  mismatch: number;
  inconclusive: number;
  lastVerdict: Verdict | null;
  lastAt: number | null;
  quarantined: boolean;
  quarantinedAt: number | null;
  quarantineReason: string | null;
}

export function nodeVerificationStats(db: Db, node: Pick<NodeRow, 'node_id' | 'quarantined_at' | 'quarantine_reason'>): NodeVerificationStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN verdict = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN verdict = 'suspect' THEN 1 ELSE 0 END) AS suspect,
              SUM(CASE WHEN verdict = 'mismatch' THEN 1 ELSE 0 END) AS mismatch,
              SUM(CASE WHEN verdict = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive
       FROM verifications WHERE primary_node = ?`,
    )
    .get(node.node_id) as { checked: number; ok: number | null; suspect: number | null; mismatch: number | null; inconclusive: number | null };
  const last = db.prepare(`SELECT verdict, created_at FROM verifications WHERE primary_node = ? ORDER BY id DESC LIMIT 1`).get(node.node_id) as
    | { verdict: Verdict; created_at: number }
    | undefined;
  return {
    checked: row.checked,
    ok: row.ok ?? 0,
    suspect: row.suspect ?? 0,
    mismatch: row.mismatch ?? 0,
    inconclusive: row.inconclusive ?? 0,
    lastVerdict: last?.verdict ?? null,
    lastAt: last?.created_at ?? null,
    quarantined: node.quarantined_at !== null && node.quarantined_at !== undefined,
    quarantinedAt: node.quarantined_at ?? null,
    quarantineReason: node.quarantine_reason ?? null,
  };
}

/** Network-wide counts + the most recent rows (admin overview). */
export function verificationOverview(db: Db, limit = 25) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN verdict = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN verdict = 'suspect' THEN 1 ELSE 0 END) AS suspect,
              SUM(CASE WHEN verdict = 'mismatch' THEN 1 ELSE 0 END) AS mismatch,
              SUM(CASE WHEN verdict = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive
       FROM verifications`,
    )
    .get() as { checked: number; ok: number | null; suspect: number | null; mismatch: number | null; inconclusive: number | null };
  const recent = db.prepare(`SELECT * FROM verifications ORDER BY id DESC LIMIT ?`).all(limit) as VerificationRow[];
  const quarantined = (db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE quarantined_at IS NOT NULL`).get() as { n: number }).n;
  return {
    checked: row.checked,
    ok: row.ok ?? 0,
    suspect: row.suspect ?? 0,
    mismatch: row.mismatch ?? 0,
    inconclusive: row.inconclusive ?? 0,
    quarantinedNodes: quarantined,
    recent: recent.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      checkJobId: r.check_job_id,
      primaryNode: r.primary_node,
      checkNode: r.check_node,
      score: r.score,
      verdict: r.verdict,
      reasons: safeReasons(r.reasons),
      primaryTokens: r.primary_tokens,
      checkTokens: r.check_tokens,
      createdAt: r.created_at,
    })),
  };
}

function safeReasons(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function quarantineNode(db: Db, nodeId: string, reason: string, now = nowSec()): void {
  db.prepare(`UPDATE nodes SET quarantined_at = COALESCE(quarantined_at, ?), quarantine_reason = ? WHERE node_id = ?`).run(now, reason.slice(0, 200), nodeId);
}

export function clearQuarantine(db: Db, nodeId: string): boolean {
  return db.prepare(`UPDATE nodes SET quarantined_at = NULL, quarantine_reason = NULL WHERE node_id = ?`).run(nodeId).changes === 1;
}

// ---------------- the verifier ----------------

export interface VerifierDeps extends RouteDeps {
  config: RouteDeps['config'] & {
    verification: VerificationConfig;
    routing: TokenomicsConfig['routing'];
    nodeRewards: TokenomicsConfig['nodeRewards'];
  };
  broker: JobBroker;
  upstream: Upstream;
}

export interface VerifyInput {
  /** The completed primary job (status done). */
  job: JobRow;
  nodeId: string;
  /** Reward wallet of the primary node (owner rule check). */
  nodeWallet: string;
  text: string;
  usage: JobUsage;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export class Verifier {
  /** Random source for sampling; tests pin it. */
  rand: () => number = Math.random;
  private pending = new Set<Promise<void>>();

  constructor(
    private deps: VerifierDeps,
    /** Replaced with the Fastify logger once the server exists (server.ts). */
    public log: Logger = { info: () => undefined, warn: () => undefined },
  ) {}

  get config(): VerificationConfig {
    return this.deps.config.verification;
  }

  /** Decide whether to spot-check this job; when yes, run the check in the background. Returns the decision. */
  maybeSchedule(input: VerifyInput): boolean {
    const cfg = this.config;
    const rep = nodeReputation(this.deps.db, input.nodeId, reputationConfig(this.deps.config));
    const sample = shouldSample(cfg, {
      nodeJobs: rep.jobs,
      privacy: input.job.privacy,
      ownNode: input.job.requester_wallet !== null && input.job.requester_wallet === input.nodeWallet,
      isCheck: input.job.check_of !== null,
      rand: this.rand,
    });
    if (!sample) return false;
    const p: Promise<void> = this.verify(input)
      .then(() => undefined)
      .catch((err) => this.log.warn({ err, jobId: input.job.job_id }, 'verification failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return true;
  }

  /** Wait for every in-flight check (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Run the check now and record the verdict. Exposed for tests; `maybeSchedule` is the normal entry. */
  async verify(input: VerifyInput): Promise<VerificationRow> {
    const { job } = input;
    // Let the caller finish writing the client's reply first: the check never delays an answer.
    await new Promise<void>((r) => setImmediate(r));
    const payload = JSON.parse(job.payload) as JobPayload;
    const check = await this.runCheck(job, payload, input.nodeId);
    let verdict: Verdict;
    let score: number | null = null;
    let reasons: string[];
    if (!check) {
      verdict = 'inconclusive';
      reasons = ['check_unavailable'];
    } else {
      const cmp = compareOutputs({ text: input.text, completionTokens: input.usage.completionTokens }, { text: check.text, completionTokens: check.completionTokens });
      verdict = cmp.verdict;
      score = cmp.score;
      reasons = cmp.reasons;
    }
    const ts = nowSec();
    this.deps.db
      .prepare(
        `INSERT INTO verifications (job_id, check_job_id, primary_node, check_node, score, verdict, reasons, primary_tokens, check_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .run(job.job_id, check?.checkJobId ?? null, input.nodeId, check?.checkNode ?? 'none', score, verdict, JSON.stringify(reasons), input.usage.completionTokens, check?.completionTokens ?? null, ts);
    const row = this.deps.db.prepare(`SELECT * FROM verifications WHERE job_id = ?`).get(job.job_id) as VerificationRow;
    if (verdict === 'mismatch') this.applyMismatch(input.nodeId, job.job_id, reasons);
    this.log.info({ jobId: job.job_id, primaryNode: input.nodeId, checkNode: check?.checkNode ?? null, verdict, score, reasons }, 'verification recorded');
    return row;
  }

  private applyMismatch(nodeId: string, jobId: string, reasons: string[]): void {
    const cfg = this.config;
    withholdNodeReward(this.deps.db, jobId, 'verification_mismatch');
    // The mismatch changes the node's reputation and possibly its routability: drop both caches.
    this.deps.broker.invalidateReputation(nodeId);
    const rep = nodeReputation(this.deps.db, nodeId, reputationConfig(this.deps.config));
    if (rep.mismatches >= cfg.quarantineAfterMismatches) {
      quarantineNode(this.deps.db, nodeId, `${rep.mismatches} verification mismatches (last: job ${jobId}: ${reasons.slice(0, 3).join(', ')})`);
      this.deps.broker.invalidateNodes();
      this.log.warn({ nodeId, mismatches: rep.mismatches, jobId }, 'node quarantined after repeated verification mismatches');
    }
  }

  /**
   * Re-run the job at temperature 0 on another eligible node of the same tier, else on the upstream.
   * Returns null when neither produced an answer (the verdict is then `inconclusive`).
   */
  private async runCheck(job: JobRow, payload: JobPayload, primaryNode: string): Promise<{ text: string; completionTokens: number; checkNode: string; checkJobId: string | null } | null> {
    const params = { ...payload.params, temperature: 0 };
    const trustedOnly = job.privacy === 'trusted';
    const others = eligibleNodes(this.deps, job.tag, { exclude: primaryNode, trustedOnly, requesterWallet: job.requester_wallet });
    if (others.length > 0) {
      const viaNode = await this.runOnNode(job, payload, params, primaryNode, trustedOnly);
      if (viaNode) return viaNode;
    }
    return this.runUpstream(job, payload, params);
  }

  private async runOnNode(job: JobRow, payload: JobPayload, params: Record<string, unknown>, primaryNode: string, trustedOnly: boolean) {
    const routing = this.deps.config.routing;
    const { job: check, relay } = this.deps.broker.create({
      model: job.model,
      tag: job.tag,
      wallet: job.wallet,
      apiKeyId: job.api_key_id,
      payload: { messages: payload.messages, params },
      maxTokens: job.max_tokens,
      deadlineMs: Date.now() + routing.jobTimeoutMs,
      privacy: trustedOnly ? 'trusted' : 'network',
      requesterWallet: job.requester_wallet,
      excludeNodeId: primaryNode,
      checkOf: job.job_id,
    });
    const createdMs = Date.now();
    const text: string[] = [];
    let nodeId: string | null = null;
    let usage: JobUsage | null = null;
    let sent = 0;
    for (;;) {
      const now = Date.now();
      const budget = sent === 0 ? routing.firstTokenTimeoutMs - (now - createdMs) : routing.stallTimeoutMs;
      const ev = await relay.next(Math.max(0, Math.min(budget, check.deadline_ms - now)));
      if (ev.type === 'claimed') nodeId = ev.nodeId;
      else if (ev.type === 'chunk') {
        text.push(ev.delta);
        sent++;
      } else if (ev.type === 'done') {
        usage = ev.usage;
        break;
      } else {
        // fail / timeout: give up on the node path; the caller falls back to the upstream.
        const reason = ev.type === 'fail' ? `node_error: ${ev.error}` : sent === 0 ? (nodeId ? 'first_token_timeout' : 'unclaimed') : 'stall_timeout';
        this.deps.broker.abandon(check.job_id, 'failed', `check: ${reason}`, nodeId !== null);
        this.log.warn({ checkJobId: check.job_id, jobId: job.job_id, nodeId, reason }, 'verification check job failed on node');
        return null;
      }
    }
    this.deps.broker.release(check.job_id);
    if (!nodeId) return null;
    // The check node did real work: it earns the normal reward (nobody is billed for a check).
    const node = this.deps.db.prepare(`SELECT wallet FROM nodes WHERE node_id = ?`).get(nodeId) as { wallet: string } | undefined;
    const tokens = usage.promptTokens + usage.completionTokens;
    if (node) addNodeReward(this.deps.db, { wallet: node.wallet, nodeId, jobId: check.job_id, tokens, usdMicros: nodeRewardMicros(tokens, this.deps.config.nodeRewards.usdPerMTokens) });
    return { text: text.join(''), completionTokens: usage.completionTokens, checkNode: nodeId, checkJobId: check.job_id };
  }

  private async runUpstream(job: JobRow, payload: JobPayload, params: Record<string, unknown>) {
    try {
      const body: Record<string, unknown> = { model: job.model, messages: payload.messages, ...params, max_tokens: job.max_tokens, stream: false };
      const res = await this.deps.upstream.chat(body, { zdr: job.privacy !== 'network' });
      if (!res.ok) {
        this.log.warn({ jobId: job.job_id, status: res.status }, 'verification upstream check failed');
        return null;
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: Usage; error?: unknown };
      if (json.error) return null;
      const text = json.choices?.[0]?.message?.content ?? '';
      const completionTokens = json.usage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));
      return { text, completionTokens, checkNode: `upstream:${this.deps.upstream.name}`, checkJobId: null };
    } catch (err) {
      this.log.warn({ err, jobId: job.job_id }, 'verification upstream check errored');
      return null;
    }
  }
}
