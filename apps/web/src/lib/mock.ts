// Realistic fake data for VITE_MOCK=1. Keeps state in module scope so the UI behaves like a live gateway.
// Shapes mirror apps/gateway exactly (see ./types.ts).
import type {
  Catalogue,
  CatalogueModel,
  AdminAction,
  AdminOverview,
  AdminWaitlist,
  AdmitResult,
  ApiKey,
  BetaInfo,
  InvitesResult,
  NodeVerification,
  WaitlistEntry,
  WaitlistJoin,
  Board,
  ClaimResult,
  CreatedKey,
  EpochSummary,
  HourPoint,
  KeyUsage,
  Leaderboard,
  LeaderboardRow,
  LedgerRow,
  LinkCode,
  Me,
  MeshRoute,
  Model,
  MyNode,
  MyPoints,
  MyReferral,
  NodePledge,
  NodeStats,
  NodesSummary,
  PeriodTotals,
  PledgeText,
  PrivacyTier,
  PointsKind,
  PointsRow,
  PointsRules,
  RegisterChallenge,
  Report,
  RevokeKeyResult,
  RunEpochResult,
  Session,
  StarterBatchResult,
  StarterGrant,
  StarterStatus,
  Stats,
  Usage,
  WeekDetail,
  WeekReport,
  MyStake,
  StakeTiers,
  ChainCheckReport,
  ChainFieldValues,
  ChainSettingsInput,
  ChainView,
} from './types';
import type { KeyInput } from './api';
import { TOKENOMICS } from '../config';
import { ApiError } from './api';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

const EPOCH = TOKENOMICS.epochSeconds;
const MOCK_WALLET = '9xQeKf2sVbT7mRw3Lp8nHJq4cYzA6dEuGk1oXiSNHn4k';
const HOLDER_SHARE = TOKENOMICS.holderShareBps / 10_000;
const round2 = (v: number) => Math.round(v * 100) / 100;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** 24 hourly buckets ending at the current hour (oldest first), like /stats.series24h. */
function series24h(): HourPoint[] {
  const rnd = seeded(7);
  const end = Math.floor(now() / 3600) * 3600;
  const pts: HourPoint[] = [];
  let v = 240;
  for (let i = 23; i >= 0; i--) {
    v = Math.max(80, v + (rnd() - 0.42) * 70);
    const fees = round2(v);
    const requests = 520 + Math.floor(rnd() * 480);
    pts.push({
      hour: end - i * 3600,
      feesUsd: fees,
      creditsDistributedUsd: round2(fees * HOLDER_SHARE),
      requests,
      spendUsd: Math.round(requests * (0.0006 + rnd() * 0.0004) * 1e4) / 1e4,
    });
  }
  return pts;
}

function epochs(limit: number): EpochSummary[] {
  const rnd = seeded(11);
  const end = Math.floor(now() / EPOCH) * EPOCH;
  const out: EpochSummary[] = [];
  for (let i = 0; i < Math.min(limit, 312); i++) {
    const start = end - (i + 1) * EPOCH;
    const fees = i === 4 ? 0 : round2(320 + rnd() * 180);
    out.push({
      epochStart: start,
      epochEnd: start + EPOCH,
      eligibleHolders: fees === 0 ? 0 : 1284 - Math.floor(rnd() * 40) - i * 3,
      feesUsd: fees,
      holderPoolUsd: round2(fees * HOLDER_SHARE),
      treasuryUsd: round2(fees * (1 - HOLDER_SHARE)),
      status: fees === 0 ? 'empty' : 'complete',
      createdAt: start + EPOCH + 4,
    });
  }
  return out;
}

const mask = (prefix: string) => `${prefix}${'•'.repeat(24)}`;

/** Flat network price (config/tokenomics.json requestPricing.networkPricePerMTokens), USD per 1M total tokens. */
const NETWORK_USD_PER_M = 0.02;
/** List prices (USD per 1M prompt / completion tokens) the upstream would charge; mirrors config/model-prices.json. */
const LIST_PRICES: Record<string, { prompt: number; completion: number }> = {
  'meta-llama/llama-3.1-8b-instruct': { prompt: 0.05, completion: 0.08 },
  'openai/gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'anthropic/claude-3.5-haiku': { prompt: 0.8, completion: 4.0 },
  'anthropic/claude-sonnet-4': { prompt: 3.0, completion: 15.0 },
  'mesh/mock': { prompt: 0, completion: 0 },
};
const DEFAULT_LIST = { prompt: 1.0, completion: 3.0 };

const state = {
  balanceMicros: 29_999_000,
  // Network credits so far: ~1.9k requests, 71% served by nodes, list $18.40 vs $7.66 paid on those.
  savings: { savedMicros24h: 1_184_000, savedMicrosTotal: 10_742_000, networkListMicros: 18_402_000, networkSpendMicros: 7_660_000, networkRequests: 1_312, requests: 1_848 },
  keys: [
    { id: 3, masked: mask('mesh_sk_7f3a2c'), name: 'laptop', label: 'laptop', spendLimitUsd: 0.5, spentUsd: 0.3184, created_at: now() - 86400 * 2, revoked: false },
    { id: 2, masked: mask('mesh_sk_b91e04'), name: 'cursor', label: 'cursor', spendLimitUsd: null, spentUsd: 1.9402, created_at: now() - 86400 * 9, revoked: false },
    { id: 1, masked: mask('mesh_sk_02dd7a'), name: null, label: null, spendLimitUsd: null, spentUsd: 0.0702, created_at: now() - 86400 * 21, revoked: true },
  ] as ApiKey[],
  usage: new Map<number, { requests: number; spendUsd: number; promptTokens: number; completionTokens: number }>([
    [3, { requests: 412, spendUsd: 0.3184, promptTokens: 61_800, completionTokens: 24_720 }],
    [2, { requests: 1_907, spendUsd: 1.9402, promptTokens: 286_050, completionTokens: 114_420 }],
    [1, { requests: 88, spendUsd: 0.0702, promptTokens: 13_200, completionTokens: 5_280 }],
  ]),
  ledger: [] as LedgerRow[],
  nextId: 4,
};

(function seedLedger() {
  const rnd = seeded(3);
  const end = Math.floor(now() / EPOCH) * EPOCH;
  let id = 500;
  const models = ['meta-llama/llama-3.1-8b-instruct', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'];
  for (let i = 0; i < 6; i++) {
    const epochStart = end - i * EPOCH;
    // a few usage rows after each distribution
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) {
      const micros = -Math.round(300 + rnd() * 2400);
      state.ledger.push({
        id: id--,
        kind: 'usage',
        deltaUsd: micros / 1e6,
        deltaUsdMicros: micros,
        ref: `req:${1200 - i * 7 - j} · ${models[Math.floor(rnd() * models.length)]}`,
        created_at: epochStart + 120 + j * 600,
      });
    }
    const dist = Math.round(28_000_000 + rnd() * 4_000_000);
    state.ledger.push({
      id: id--,
      kind: 'distribution',
      deltaUsd: dist / 1e6,
      deltaUsdMicros: dist,
      ref: `epoch:${epochStart}`,
      created_at: epochStart,
    });
  }
})();

/** Engine 2 (usage-revenue share) in mock mode: `VITE_MOCK_USAGE_SHARE=1` previews the "on" state of the homepage diagram and the report. */
const MOCK_USAGE_SHARE_ON = import.meta.env.VITE_MOCK_USAGE_SHARE === '1';

export const mockStats = async (): Promise<Stats> => {
  await sleep(350);
  const end = Math.floor(now() / EPOCH) * EPOCH;
  const [last] = epochs(1);
  const s = series24h();
  // fees accrue through the current hour: ~60% of a typical epoch by "now"
  const frac = (now() - end) / EPOCH;
  return {
    token: {
      name: TOKENOMICS.name,
      ticker: TOKENOMICS.ticker,
      chain: TOKENOMICS.chain,
      tradeFeeBps: TOKENOMICS.tradeFeeBps,
      holderShareBps: TOKENOMICS.holderShareBps,
      treasuryShareBps: TOKENOMICS.treasuryShareBps,
      minHoldTokens: TOKENOMICS.minHoldTokens,
      epochSeconds: EPOCH,
      description: 'Trading fees → hourly AI inference credits.',
    },
    totalFeesUsd: 128_440.21,
    creditsDistributedUsd: 64_220.1,
    creditsUsedUsd: 41_907.44,
    epochsRun: 312,
    lastEpoch: last,
    holdersEligibleLastEpoch: last.eligibleHolders,
    feesThisEpochUsd: round2(last.feesUsd * Math.max(0.05, frac)),
    requestsLast24h: s.reduce((a, p) => a + p.requests, 0),
    spendLast24hUsd: Math.round(s.reduce((a, p) => a + p.spendUsd, 0) * 100) / 100,
    nodesOnline: 37,
    servedByNetworkPercent: 71.2,
    networkSavingsUsd24h: 412.37,
    showSavings: true,
    pointsEnabled: false, // mirrors config/tokenomics.json: the programme is built but disabled
    beta: MOCK_BETA,
    verificationEnabled: true,
    starterGrants: { enabled: mockStarter.enabled, amountUsd: TOKENOMICS.starterCredits.amountUsd, granted: mockStarter.grants.length, remaining: Math.max(0, TOKENOMICS.starterCredits.maxWallets - mockStarter.grants.length) },
    usageShareEnabled: MOCK_USAGE_SHARE_ON, // mirrors config/tokenomics.json: built, off by default
    usageShareToHolders24hUsd: MOCK_USAGE_SHARE_ON ? 61.2 : 0,
    upstreamDiscountBps: TOKENOMICS.upstreamDiscountBps,
    upstreamMarkupBps: TOKENOMICS.upstreamMarkupBps,
    series24h: s,
    epochSeconds: EPOCH,
    upstream: 'mock',
    tokenLive: true,
    generatedAt: now(),
  };
};

export const mockEpochs = async (limit = 48): Promise<EpochSummary[]> => {
  await sleep(250);
  return epochs(limit);
};

export const mockNodes = async (): Promise<NodesSummary> => {
  await sleep(200);
  return {
    online: 37,
    total: 41,
    busy: 9,
    idle: 28,
    totalRamGb: 37 * 48,
    chips: { 'M3 Max': 11, 'M2 Ultra': 6, 'M4 Pro': 14, 'M1 Max': 6 },
    models: { 'llama3.1:8b': 37, 'qwen2.5:7b': 19, 'mesh/mock': 37 },
    offlineAfterSec: 90,
  };
};

// ---------- public beta (mirrors config/tokenomics.json → beta) ----------

export const MOCK_BETA: BetaInfo = { enabled: true, label: 'Beta', inviteRequired: false };
const ADMITTED_KEY = 'mesh.mock.admitted';

/**
 * Mock sign-in honours the beta gate once: the first attempt without a code gets the gateway's
 * `403 invite_required`, any non-empty code (or an earlier admission, remembered in localStorage) lets
 * the wallet in. Screenshots pre-seed the session hint, so they never hit the gate.
 */
export const mockSession = async (invite?: string | null): Promise<Session> => {
  await sleep(500);
  let admitted = false;
  try {
    admitted = localStorage.getItem(ADMITTED_KEY) === '1';
  } catch {
    /* ignore */
  }
  if (MOCK_BETA.inviteRequired && !admitted) {
    if (!invite?.trim()) throw new ApiError(403, 'Mesh is in beta: this wallet needs an invite code to sign in. Join the waitlist or enter your code.', 'invite_required');
    if (invite.trim().toLowerCase() === 'wrong') throw new ApiError(403, 'Unknown invite code.', 'invite_invalid');
    try {
      localStorage.setItem(ADMITTED_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  return { token: 'mock.jwt.token', wallet: MOCK_WALLET, chain: TOKENOMICS.chain };
};

const waitlist: WaitlistEntry[] = (() => {
  const out: WaitlistEntry[] = [];
  const t0 = now() - 3 * 86_400;
  const emails = ['ana@example.com', null, 'dev@fastmail.com', null, 'ollie@proton.me', null, 'kim@hey.com', null, null, 'sam@example.org'];
  const wallets = [null, '7xKqA2fPq9Lm3nR8sT1vW5yZ0bC4dE6gH8jK1mN3pQ9f', null, '0x8f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2be21c', null, 'Ab3dEf5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7fQz1m', null, '0x3a9b8c7d6e5f40312a1b0c9d8e7f6a5b4c3d2e1f0a9b', 'DqT4uV6wX8yZ0aB2cD4eF6gH8jK0mN2pQ4rS6tU8vW0x', null];
  for (let i = 0; i < 10; i++) {
    const invited = i < 3;
    out.push({ id: 1 + i, email: emails[i], wallet: wallets[i], createdAt: t0 + i * 9_000, invitedAt: invited ? t0 + 86_400 : null, code: invited ? mockInviteCode() : null });
  }
  return out;
})();
let nextWaitlistId = 11;
let liveCodes = 4;
let liveUses = 7;
let admittedCount = 212;

function mockInviteCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += A[Math.floor(Math.random() * A.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

function waitlistCounts() {
  const waiting = waitlist.filter((e) => !e.invitedAt).length;
  return { total: waitlist.length, waiting, invited: waitlist.length - waiting, admitted: admittedCount, liveCodes, liveUses };
}

export const mockJoinWaitlist = async (input: { wallet?: string; email?: string }): Promise<WaitlistJoin> => {
  await sleep(400);
  const email = input.email?.trim().toLowerCase() || null;
  const wallet = input.wallet?.trim() || null;
  if (!email && !wallet) throw new ApiError(400, 'wallet or email is required', 'bad_request');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ApiError(400, 'not an e-mail address', 'bad_request');
  const existing = waitlist.find((e) => (email && e.email === email) || (wallet && e.wallet === wallet));
  const entry = existing ?? { id: nextWaitlistId++, email, wallet, createdAt: now(), invitedAt: null, code: null };
  if (!existing) waitlist.push(entry);
  const position = entry.invitedAt ? 0 : waitlist.filter((e) => !e.invitedAt && e.id <= entry.id).length;
  return { ok: true, position, alreadyListed: Boolean(existing), beta: MOCK_BETA };
};

export const mockAdminWaitlist = async (token: string, status: 'waiting' | 'invited' | 'all'): Promise<AdminWaitlist> => {
  await sleep(300);
  requireMockAdmin(token);
  const entries = waitlist.filter((e) => (status === 'waiting' ? !e.invitedAt : status === 'invited' ? Boolean(e.invitedAt) : true));
  return { counts: waitlistCounts(), beta: { ...MOCK_BETA, batchSize: 200 }, entries };
};

export const mockAdminAdmitWaitlist = async (token: string, n = 200): Promise<AdmitResult> => {
  await sleep(600);
  requireMockAdmin(token);
  const picked = waitlist.filter((e) => !e.invitedAt).slice(0, n);
  const ts = now();
  for (const e of picked) {
    e.invitedAt = ts;
    e.code = mockInviteCode();
    if (e.wallet) admittedCount++;
  }
  pushAdminAction('waitlist-admit', { requested: n, admitted: picked.length });
  return { requested: n, admitted: picked.length, entries: picked.map((e) => ({ ...e })), counts: waitlistCounts() };
};

export const mockAdminInvites = async (token: string, count: number, uses: number): Promise<InvitesResult> => {
  await sleep(350);
  requireMockAdmin(token);
  const codes = Array.from({ length: count }, () => mockInviteCode());
  liveCodes += count;
  liveUses += count * uses;
  pushAdminAction('invites', { count, uses });
  return { count, uses, codes };
};

// ---------- spot-check verification (docs/NODE_PROTOCOL.md §10) ----------

const verificationOf = new Map<string, NodeVerification>([
  ['node_7Kd2pQ9f', { checked: 41, ok: 39, suspect: 2, mismatch: 0, inconclusive: 0, lastVerdict: 'ok', lastAt: now() - 2_700, quarantined: false, quarantinedAt: null, quarantineReason: null, enabled: true, sampleRate: 0.05 }],
  ['node_3Ab8xR2m', { checked: 6, ok: 3, suspect: 1, mismatch: 2, inconclusive: 0, lastVerdict: 'mismatch', lastAt: now() - 7_200, quarantined: true, quarantinedAt: now() - 7_100, quarantineReason: '2 verification mismatches (last: job job_Rt8m: primary_repeated_char_run)', enabled: true, sampleRate: 0.05 }],
]);
const emptyVerification = (): NodeVerification => ({ checked: 0, ok: 0, suspect: 0, mismatch: 0, inconclusive: 0, lastVerdict: null, lastAt: null, quarantined: false, quarantinedAt: null, quarantineReason: null, enabled: true, sampleRate: 0.05 });

export const mockAdminClearQuarantine = async (token: string, nodeId: string): Promise<{ nodeId: string; quarantined: boolean }> => {
  await sleep(300);
  requireMockAdmin(token);
  const v = verificationOf.get(nodeId) ?? emptyVerification();
  verificationOf.set(nodeId, { ...v, quarantined: false, quarantinedAt: null, quarantineReason: null });
  pushAdminAction('quarantine-clear', { nodeId });
  return { nodeId, quarantined: false };
};

export const mockMe = async (): Promise<Me> => {
  await sleep(300);
  return {
    wallet: MOCK_WALLET,
    chain: TOKENOMICS.chain,
    balance: { usd: state.balanceMicros / 1e6, usdMicros: state.balanceMicros },
    ledger: [...state.ledger].sort((a, b) => b.created_at - a.created_at).slice(0, 20),
    apiKeys: state.keys,
    savings: mockSavings(),
  };
};

function mockSavings() {
  const sv = state.savings;
  const multiplier = sv.networkSpendMicros > 0 && sv.networkListMicros > sv.networkSpendMicros ? Math.round((sv.networkListMicros / sv.networkSpendMicros) * 10) / 10 : 1;
  return {
    usd24h: sv.savedMicros24h / 1e6,
    usdTotal: sv.savedMicrosTotal / 1e6,
    networkSharePercent: sv.requests ? Math.round((sv.networkRequests / sv.requests) * 10_000) / 100 : 0,
    multiplier,
    networkSpendUsdTotal: sv.networkSpendMicros / 1e6,
    networkRequests: sv.networkRequests,
    requests: sv.requests,
  };
}

export const mockKeys = async (): Promise<ApiKey[]> => {
  await sleep(250);
  return [...state.keys];
};

export const mockCreateKey = async (input: KeyInput = {}): Promise<CreatedKey> => {
  await sleep(500);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64])
    .join('');
  const key = `mesh_sk_${rand}`;
  const id = state.nextId++;
  const name = input.name ?? null;
  const spendLimitUsd = input.spendLimitUsd ?? null;
  const privacy = input.privacy ?? null;
  state.keys.unshift({ id, masked: mask(key.slice(0, 14)), name, label: name, spendLimitUsd, spentUsd: 0, created_at: now(), revoked: false, privacy });
  state.usage.set(id, { requests: 0, spendUsd: 0, promptTokens: 0, completionTokens: 0 });
  return { id, key, prefix: key.slice(0, 14), name, spendLimitUsd, privacy, note: 'Store this key now; it is not shown again.' };
};

export const mockRevokeKey = async (id: number) => {
  await sleep(300);
  const k = state.keys.find((x) => x.id === id);
  if (k) k.revoked = true;
};

export const mockUpdateKey = async (id: number, patch: KeyInput): Promise<ApiKey> => {
  await sleep(200);
  const k = state.keys.find((x) => x.id === id);
  if (!k) throw new Error('not_found');
  if ('name' in patch) {
    k.name = patch.name ?? null;
    k.label = k.name;
  }
  if ('spendLimitUsd' in patch) k.spendLimitUsd = patch.spendLimitUsd ?? null;
  if ('privacy' in patch) k.privacy = patch.privacy ?? null;
  return { ...k };
};

export const mockKeyUsage = async (id: number): Promise<KeyUsage> => {
  await sleep(150);
  const k = state.keys.find((x) => x.id === id);
  if (!k) throw new Error('not_found');
  const all = state.usage.get(id) ?? { requests: 0, spendUsd: 0, promptTokens: 0, completionTokens: 0 };
  const scale = (f: number) => ({
    requests: Math.round(all.requests * f),
    spendUsd: Math.round(all.spendUsd * f * 1e4) / 1e4,
    promptTokens: Math.round(all.promptTokens * f),
    completionTokens: Math.round(all.completionTokens * f),
  });
  return {
    key: { ...k },
    last24h: scale(k.revoked ? 0 : 0.18),
    last7d: scale(k.revoked ? 0 : 0.7),
    allTime: { ...all, requestCount: all.requests },
    requestCount: all.requests,
    topModels: all.requests
      ? [
          { model: 'meta-llama/llama-3.1-8b-instruct', requests: Math.round(all.requests * 0.6), spendUsd: Math.round(all.spendUsd * 0.35 * 1e4) / 1e4 },
          { model: 'openai/gpt-4o-mini', requests: Math.round(all.requests * 0.4), spendUsd: Math.round(all.spendUsd * 0.65 * 1e4) / 1e4 },
        ]
      : [],
  };
};

export const mockModels = async (): Promise<Model[]> => {
  await sleep(200);
  return [
    { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
    { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'mesh/mock', name: 'Mesh mock (offline)' },
  ];
};

const REPLIES = [
  'Either side can end the agreement with 30 days’ notice, but fees already invoiced stay payable. Nothing in the clause lets one party claw back work that was delivered before the notice period ends.',
  'Hello from the Mesh network. This reply was served by a node that holds no logs; what you asked is already gone from its memory. Your hourly credits paid for it, so there is nothing to settle.',
  'Short version: credits are a share of trading fees, distributed every hour to wallets holding at least 1,000 MESH. They are spent per request, at the upstream’s cost, and they do not expire while your account is active.',
];

/**
 * Fake SSE stream: yields content deltas, then a final chunk with usage + mesh. `trusted` and `network`
 * are served by a node at the network price; `upstream_zdr` by the (fake) upstream at list price.
 */
export async function* mockChatStream(
  model: string,
  signal?: AbortSignal,
  privacy: PrivacyTier = 'trusted',
): AsyncGenerator<{ content?: string; usage?: Usage; model?: string; mesh?: MeshRoute }> {
  await sleep(380);
  const text = REPLIES[Math.floor(Math.random() * REPLIES.length)];
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (signal?.aborted) return;
    await sleep(22 + Math.random() * 40);
    yield { content: (i ? ' ' : '') + words[i], model };
  }
  const prompt_tokens = 40 + Math.floor(Math.random() * 60);
  const completion_tokens = words.length + 10;
  const total = prompt_tokens + completion_tokens;
  const list = LIST_PRICES[model] ?? DEFAULT_LIST;
  const listMicros = Math.round(prompt_tokens * list.prompt + completion_tokens * list.completion);
  if (privacy === 'upstream_zdr') {
    // Skipped the network: list price, no savings, no node.
    const cost = listMicros / 1e6;
    state.balanceMicros -= listMicros;
    state.savings.requests += 1;
    state.ledger.unshift({ id: 9000 + state.ledger.length, kind: 'usage', deltaUsd: -cost, deltaUsdMicros: -listMicros, ref: `req:${1300 + state.ledger.length} · ${model}`, created_at: now() });
    yield { usage: { prompt_tokens, completion_tokens, total_tokens: total, cost }, model, mesh: { route: 'openrouter', privacy: 'upstream_zdr', servedBy: 'upstream (ZDR)' } };
    return;
  }
  // Served by a Mesh node: billed the flat network price; the list price is what the upstream would have charged.
  const costMicros = Math.round(total * NETWORK_USD_PER_M);
  const savedMicros = Math.max(0, listMicros - costMicros);
  const cost = costMicros / 1e6;
  state.balanceMicros -= costMicros;
  state.savings.savedMicros24h += savedMicros;
  state.savings.savedMicrosTotal += savedMicros;
  state.savings.networkListMicros += listMicros;
  state.savings.networkSpendMicros += costMicros;
  state.savings.networkRequests += 1;
  state.savings.requests += 1;
  state.ledger.unshift({
    id: 9000 + state.ledger.length,
    kind: 'usage',
    deltaUsd: -cost,
    deltaUsdMicros: -Math.round(cost * 1e6),
    ref: `req:${1300 + state.ledger.length} · ${model}`,
    created_at: now(),
  });
  yield {
    usage: { prompt_tokens, completion_tokens, total_tokens: total, cost },
    model,
    mesh: {
      route: 'node',
      nodeId: 'node_7kd2a1b9pq9f',
      chip: 'M3 Max',
      privacy,
      servedBy: privacy === 'trusted' ? 'trusted node' : 'network node',
      listCostUsd: listMicros / 1e6,
      savedUsd: savedMicros / 1e6,
    },
  };
}

// ---------- my nodes (/app/node) ----------
// `?nodes=0` on the page URL previews the empty state.
const wantEmptyNodes = () => {
  try {
    return new URLSearchParams(window.location.search).get('nodes') === '0';
  } catch {
    return false;
  }
};

const MY_NODES: Array<MyNode & NodeStats> = [
  {
    nodeId: 'node_7Kd2pQ9f',
    chip: 'Apple M3 Max',
    ramGb: 64,
    models: ['llama3.1:8b', 'qwen2.5:14b'],
    status: 'busy',
    lastSeen: now() - 6,
    agentVersion: '0.1.0',
    createdAt: now() - 86400 * 12,
    uptimePct24h: 99.4,
    jobs24h: 1_284,
    tokens24h: 412_900,
    earnedUsd24h: 1.9372,
    earnedUsdTotal: 21.4418,
  },
  {
    nodeId: 'node_3Ab8xR2m',
    chip: 'Apple M1',
    ramGb: 16,
    models: ['llama3.1:8b'],
    status: 'offline',
    lastSeen: now() - 3600 * 5,
    agentVersion: '0.1.0',
    createdAt: now() - 86400 * 30,
    uptimePct24h: 61.2,
    jobs24h: 233,
    tokens24h: 70_120,
    earnedUsd24h: 0.3381,
    earnedUsdTotal: 9.0026,
  },
];

export const mockRegisterChallenge = async (wallet: string): Promise<RegisterChallenge> => {
  await sleep(200);
  const nonce = Math.random().toString(16).slice(2, 18);
  return {
    wallet,
    nonce,
    nodeId: null,
    domain: 'mesh.example',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    message: `mesh.example wants to register a Mesh node paid to:\n${wallet}\n\nNonce: ${nonce}`,
    requireSignature: true,
  };
};

const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const mockLinkCode = async (): Promise<LinkCode> => {
  await sleep(400);
  let code = '';
  for (let i = 0; i < 8; i++) code += LINK_ALPHABET[Math.floor(Math.random() * LINK_ALPHABET.length)];
  return { code, wallet: MOCK_WALLET, chain: TOKENOMICS.chain, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), expiresInSec: 900 };
};

export const mockMyNodes = async (): Promise<MyNode[]> => {
  await sleep(300);
  if (wantEmptyNodes()) return [];
  return MY_NODES.map(({ nodeId, chip, ramGb, models, status, lastSeen, agentVersion, createdAt }) => ({ nodeId, chip, ramGb, models, status, lastSeen, agentVersion, createdAt }));
};

/** Pledge state per mock node: the M3 Max is gold-staked and already pledged; the M1 is unstaked. */
const pledges = new Map<string, NodePledge>([
  ['node_7Kd2pQ9f', { signed: true, signedAt: now() - 86400 * 9, chain: TOKENOMICS.chain, trusted: true, trustedVia: 'stake+pledge', allowlisted: false, requiredStakeTier: 'gold', stakeTier: 'gold', stakeOk: true }],
  ['node_3Ab8xR2m', { signed: false, signedAt: null, chain: null, trusted: false, trustedVia: null, allowlisted: false, requiredStakeTier: 'gold', stakeTier: 'none', stakeOk: false }],
]);
const pledgeOf = (nodeId: string): NodePledge =>
  pledges.get(nodeId) ?? { signed: false, signedAt: null, chain: null, trusted: false, trustedVia: null, allowlisted: false, requiredStakeTier: 'gold', stakeTier: 'none', stakeOk: false };

export const mockPledge = async (nodeId: string): Promise<PledgeText> => {
  await sleep(150);
  return {
    nodeId,
    wallet: MOCK_WALLET,
    message: `mesh.example asks the operator of Mesh node ${nodeId} to pledge:\n${MOCK_WALLET}\n\n1. I will not log, store, forward or inspect the prompts or replies this node processes.\n2. I will run the unmodified Mesh node agent and Ollama, with debug logging off.\n3. I will not run memory-inspection, packet-capture or similar tooling against the node process while it serves jobs.\n4. I understand that breaking this pledge forfeits trusted status and accrued rewards for this node.\n\nURI: https://mesh.example\nVersion: 1\nNode ID: ${nodeId}`,
    ...pledgeOf(nodeId),
  };
};

export const mockSignPledge = async (nodeId: string): Promise<PledgeText> => {
  await sleep(300);
  const cur = pledgeOf(nodeId);
  const next: NodePledge = { ...cur, signed: true, signedAt: now(), chain: TOKENOMICS.chain, trusted: cur.allowlisted || cur.stakeOk, trustedVia: cur.allowlisted ? 'allowlist' : cur.stakeOk ? 'stake+pledge' : null };
  pledges.set(nodeId, next);
  const text = await mockPledge(nodeId);
  return { ...text, ...next };
};

export const mockNodeStats = async (nodeId: string): Promise<NodeStats> => {
  await sleep(200);
  const n = MY_NODES.find((x) => x.nodeId === nodeId);
  if (!n) throw new Error('not_found');
  // Jitter the live node a little so polling visibly updates.
  const live = n.status !== 'offline';
  return {
    nodeId,
    status: n.status,
    uptimePct24h: n.uptimePct24h,
    jobs24h: n.jobs24h + (live ? Math.floor((now() % 600) / 60) : 0),
    tokens24h: n.tokens24h + (live ? (now() % 600) * 7 : 0),
    earnedUsd24h: n.earnedUsd24h + (live ? (now() % 600) * 0.000003 : 0),
    earnedUsdTotal: n.earnedUsdTotal + (live ? (now() % 600) * 0.000003 : 0),
    lastSeen: live ? now() - 6 : n.lastSeen,
    chip: n.chip,
    ramGb: n.ramGb,
    models: n.models,
    pledge: pledgeOf(nodeId),
    verification: verificationOf.get(nodeId) ?? emptyVerification(),
    quarantined: verificationOf.get(nodeId)?.quarantined ?? false,
  };
};

// ---------- public treasury report (/report) ----------

const DAY = 86_400;
const WEEK = 7 * DAY;

function weekStartOf(sec: number): number {
  const d = new Date(sec * 1000);
  const dow = (d.getUTCDay() + 6) % 7;
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - dow * DAY;
}
function isoWeekOf(sec: number): { isoWeek: string; start: number; end: number } {
  const start = weekStartOf(sec);
  const thursday = new Date((start + 3 * DAY) * 1000);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((start + 3 * DAY - Date.UTC(year, 0, 1) / 1000) / WEEK) + 1;
  return { isoWeek: `${year}-W${String(week).padStart(2, '0')}`, start, end: start + WEEK };
}
function parseIsoWeek(s: string) {
  const m = /^(\d{4})-W(\d{2})$/.exec(s);
  if (!m) return null;
  const jan4 = Date.UTC(Number(m[1]), 0, 4) / 1000;
  return isoWeekOf(weekStartOf(jan4) + (Number(m[2]) - 1) * WEEK);
}

const TREASURY_SHARE = 1 - HOLDER_SHARE;
const OPS_USD = 1_800; // hosting + RPC, booked once a month in the mock

/** Deterministic weekly figures: ~13 weeks of history, growth with a dip, network share ramping up. */
function periodFor(start: number, end: number, seed: number): PeriodTotals {
  const rnd = seeded(seed);
  const t = Math.max(0, Math.min(1, (end - start) / WEEK));
  const weekIdx = Math.floor((weekStartOf(now()) - weekStartOf(start)) / WEEK); // 0 = this week
  if (weekIdx > 12) return { feesInUsd: 0, creditsOutUsd: 0, starterCreditsUsd: 0, creditsUsedUsd: 0, nodeRewardsUsd: 0, treasuryInUsd: 0, requests: 0, servedByNetwork: 0, servedByOpenRouter: 0, servedByNetworkPercent: 0, epochs: 0, completeEpochs: 0 };
  const growth = 1 + (12 - weekIdx) * 0.09 - (weekIdx === 5 ? 0.35 : 0);
  const partial = weekIdx === 0 ? Math.max(0.1, (now() - start) / WEEK) : 1;
  const fees = round2((5_900 + rnd() * 900) * growth * partial * t);
  const requests = Math.round((88_000 + rnd() * 9_000) * growth * partial * t);
  const share = Math.min(0.61, Math.max(0, 0.08 + (12 - weekIdx) * 0.045 + (rnd() - 0.5) * 0.04));
  const served = Math.round(requests * share);
  const epochs = Math.round(168 * partial * t);
  return {
    feesInUsd: fees,
    creditsOutUsd: round2(fees * HOLDER_SHARE),
    starterCreditsUsd: weekIdx === 12 ? 2_500 : weekIdx === 9 ? 400 : 0,
    creditsUsedUsd: round2(fees * HOLDER_SHARE * (0.55 + rnd() * 0.2)),
    nodeRewardsUsd: Math.round(served * 1_300 * 0.06) / 1e6, // ~1.3k tokens per request at $0.06/M
    treasuryInUsd: round2(fees * TREASURY_SHARE),
    requests,
    servedByNetwork: served,
    servedByOpenRouter: requests - served,
    servedByNetworkPercent: requests ? Math.round((served / requests) * 10_000) / 100 : 0,
    epochs,
    completeEpochs: Math.max(0, epochs - (weekIdx === 5 ? 6 : 1)),
  };
}

function weekReportFor(w: { isoWeek: string; start: number; end: number }): WeekReport {
  const n = now();
  return { ...w, ...periodFor(w.start, w.end, 100 + Math.floor(w.start / WEEK)), current: n >= w.start && n < w.end };
}

const sumPeriods = (ps: PeriodTotals[]): PeriodTotals => {
  const s = ps.reduce(
    (a, p) => ({
      feesInUsd: a.feesInUsd + p.feesInUsd,
      creditsOutUsd: a.creditsOutUsd + p.creditsOutUsd,
      starterCreditsUsd: a.starterCreditsUsd + p.starterCreditsUsd,
      creditsUsedUsd: a.creditsUsedUsd + p.creditsUsedUsd,
      nodeRewardsUsd: a.nodeRewardsUsd + p.nodeRewardsUsd,
      treasuryInUsd: a.treasuryInUsd + p.treasuryInUsd,
      requests: a.requests + p.requests,
      servedByNetwork: a.servedByNetwork + p.servedByNetwork,
      servedByOpenRouter: a.servedByOpenRouter + p.servedByOpenRouter,
      servedByNetworkPercent: 0,
      epochs: a.epochs + p.epochs,
      completeEpochs: a.completeEpochs + p.completeEpochs,
    }),
    { feesInUsd: 0, creditsOutUsd: 0, starterCreditsUsd: 0, creditsUsedUsd: 0, nodeRewardsUsd: 0, treasuryInUsd: 0, requests: 0, servedByNetwork: 0, servedByOpenRouter: 0, servedByNetworkPercent: 0, epochs: 0, completeEpochs: 0 },
  );
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    ...s,
    feesInUsd: r2(s.feesInUsd),
    creditsOutUsd: r2(s.creditsOutUsd),
    creditsUsedUsd: r2(s.creditsUsedUsd),
    treasuryInUsd: r2(s.treasuryInUsd),
    nodeRewardsUsd: Math.round(s.nodeRewardsUsd * 1e4) / 1e4,
    servedByNetworkPercent: s.requests ? Math.round((s.servedByNetwork / s.requests) * 10_000) / 100 : 0,
  };
};

const REPORT_METHOD = {
  credits: 'Credits are a share of trading fees already collected, converted 1:1 to USD-denominated inference credits. They are not a yield, a promise, or a claim on future fees.',
  attribution:
    'Fees and the treasury share are booked to the ISO week (UTC) of the epoch window that earned them; credits out follow their epoch; usage, starter credits and node rewards follow the time they happened.',
  treasury:
    'treasuryBalanceUsd = treasury share received − node rewards accrued − buybacks − ops, from the treasury ledger. Node rewards accrue in USD when a Mesh node completes a job and are paid from the treasury share.',
  network: 'servedByNetworkPercent = requests served by a Mesh node ÷ all requests in the period (requests_log).',
};

export const mockReport = async (): Promise<Report> => {
  await sleep(320);
  const n = now();
  const thisWeek = weekStartOf(n);
  const weeks: WeekReport[] = [];
  for (let i = 11; i >= 0; i--) weeks.push(weekReportFor(isoWeekOf(thisWeek - i * WEEK)));
  const allWeeks: PeriodTotals[] = [];
  for (let i = 12; i >= 0; i--) allWeeks.push(periodFor(thisWeek - i * WEEK, thisWeek - i * WEEK + WEEK, 100 + Math.floor((thisWeek - i * WEEK) / WEEK)));
  const totals = sumPeriods(allWeeks);
  const last7d = sumPeriods([periodFor(n - 7 * DAY, n, 7)]);
  const last30d = sumPeriods([periodFor(n - 30 * DAY, n - 23 * DAY, 30), periodFor(n - 23 * DAY, n - 16 * DAY, 31), periodFor(n - 16 * DAY, n - 9 * DAY, 32), periodFor(n - 9 * DAY, n - 2 * DAY, 33), periodFor(n - 2 * DAY, n, 34)]);
  const ops = -OPS_USD * 3;
  const balance = round2(totals.treasuryInUsd - totals.nodeRewardsUsd + ops);
  return {
    token: { name: TOKENOMICS.name, ticker: TOKENOMICS.ticker, chain: TOKENOMICS.chain, holderShareBps: TOKENOMICS.holderShareBps, treasuryShareBps: TOKENOMICS.treasuryShareBps },
    totals: {
      ...totals,
      creditsOutstandingUsd: round2(totals.creditsOutUsd + totals.starterCreditsUsd - totals.creditsUsedUsd),
      walletsWithCredits: 1_312,
      treasury: { feeShareUsd: totals.treasuryInUsd, nodeRewardAccrualUsd: -totals.nodeRewardsUsd, buybackUsd: 0, opsUsd: ops, otherUsd: 0, guestChatUsd: -38.4, marketFeeUsd: 61.18, balanceUsd: balance },
      marketplace: { listed: 6_420, filled: 4_894, paid: 3_640.5, fills: 212, feesToHolders: 61.18, feesToTreasury: 61.18, openDepth: 1_526, openListings: 9, bestDiscountBps: 3000, avgDiscountBps: 2560 },
      usageShare: {
        enabled: MOCK_USAGE_SHARE_ON,
        holderBps: 3000,
        treasuryBps: 7000,
        marginUsd: MOCK_USAGE_SHARE_ON ? 2_140.4 : 0,
        toHoldersUsd: MOCK_USAGE_SHARE_ON ? 642.12 : 0,
        toTreasuryUsd: MOCK_USAGE_SHARE_ON ? 1_498.28 : 0,
        requests: MOCK_USAGE_SHARE_ON ? 184_200 : 0,
        bySource: {
          network: { marginUsd: MOCK_USAGE_SHARE_ON ? 1_610.4 : 0, toHoldersUsd: MOCK_USAGE_SHARE_ON ? 483.12 : 0, toTreasuryUsd: MOCK_USAGE_SHARE_ON ? 1_127.28 : 0, requests: MOCK_USAGE_SHARE_ON ? 131_000 : 0 },
          upstream: { marginUsd: MOCK_USAGE_SHARE_ON ? 530 : 0, toHoldersUsd: MOCK_USAGE_SHARE_ON ? 159 : 0, toTreasuryUsd: MOCK_USAGE_SHARE_ON ? 371 : 0, requests: MOCK_USAGE_SHARE_ON ? 53_200 : 0 },
          marketplaceFee: { toHoldersUsd: 61.18, counted: true },
        },
      },
    },
    last7d,
    last30d,
    byWeek: weeks,
    feesIn: totals.feesInUsd,
    creditsOut: totals.creditsOutUsd,
    nodeRewards: totals.nodeRewardsUsd,
    treasuryBalanceUsd: balance,
    servedByNetworkPercent: totals.servedByNetworkPercent,
    epochsRun: totals.epochs,
    holdingAge: { enabled: false, maxDays: 30, minMultiplier: 1, maxMultiplier: 2 },
    method: REPORT_METHOD,
    lastUpdated: Math.floor(n / EPOCH) * EPOCH + 4,
    generatedAt: n,
  };
};

export const mockWeek = async (isoWeek: string): Promise<WeekDetail> => {
  await sleep(220);
  const w = parseIsoWeek(isoWeek);
  if (!w) throw new ApiError(400, 'isoWeek must look like 2026-W40', 'bad_request');
  const n = now();
  const base = weekReportFor(w);
  const days = [];
  for (let d = w.start; d < w.end; d += DAY) {
    const p = d >= n ? sumPeriods([]) : periodFor(d, d + DAY, Math.floor(d / DAY));
    days.push({ day: new Date(d * 1000).toISOString().slice(0, 10), start: d, end: d + DAY, ...p });
  }
  const epochDetails: EpochSummary[] = [];
  const rnd = seeded(Math.floor(w.start / WEEK));
  for (let t = w.start; t < Math.min(w.end, n); t += EPOCH) {
    const fees = round2((base.feesInUsd / Math.max(1, base.epochs)) * (0.6 + rnd() * 0.8));
    epochDetails.push({ epochStart: t, epochEnd: t + EPOCH, eligibleHolders: 1_240 + Math.floor(rnd() * 60), feesUsd: fees, holderPoolUsd: round2(fees * HOLDER_SHARE), treasuryUsd: round2(fees * TREASURY_SHARE), status: 'complete', createdAt: t + EPOCH + 4 });
  }
  const next = isoWeekOf(w.end);
  return { ...base, days, epochDetails, previous: isoWeekOf(w.start - WEEK).isoWeek, next: next.start <= n ? next.isoWeek : null, method: REPORT_METHOD, generatedAt: n };
};

// ---------- operator surface (/admin) ----------
// Any non-empty token is accepted in mock mode; "wrong" is rejected so the error path can be previewed.

export const MOCK_ADMIN_TOKEN_HINT = 'any token works in mock mode (try "wrong" for the error state)';

/** In mock mode the Admin page "logs in" and then passes the cookie sentinel; remember what it logged in with. */
let mockAdminLoggedIn = false;

function requireMockAdmin(token: string) {
  if (token === 'cookie' && mockAdminLoggedIn) return;
  if (!token || token === 'wrong' || token === 'cookie') throw new ApiError(401, 'admin token required', 'unauthorized');
}

export const mockAdminLogin = async (token: string): Promise<{ ok: boolean; expiresInSec: number }> => {
  await sleep(250);
  requireMockAdmin(token);
  mockAdminLoggedIn = true;
  return { ok: true, expiresInSec: 12 * 3600 };
};

const admin = {
  pendingFeesUsd: 212.4,
  actions: [] as AdminAction[],
  errors: [
    { id: 418, route: 'POST /v1/chat/completions', status: 502, code: 'upstream_timeout', message: 'openrouter: headers not received within 60000ms', created_at: now() - 3_100 },
    { id: 417, route: 'POST /v1/chat/completions', status: 502, code: 'node_stream_failed', message: 'node_7Kd2pQ9f: stall > 6000ms after 212 chunks', created_at: now() - 14_800 },
    { id: 409, route: 'GET /nodes/node_3Ab8xR2m/jobs/next', status: 500, code: 'internal_error', message: 'SQLITE_BUSY: database is locked', created_at: now() - 86_400 * 2 },
  ],
  revokedKeys: new Set<number>([1]),
  nextActionId: 912,
};

(function seedAdminActions() {
  const end = Math.floor(now() / EPOCH) * EPOCH;
  const a: AdminAction[] = [];
  for (let i = 0; i < 6; i++) a.push({ id: 911 - i, action: 'run-epoch', payload: { epochStart: end - (i + 1) * EPOCH, status: i === 4 ? 'empty' : 'complete', feesUsdMicros: i === 4 ? 0 : 412_000_000 - i * 9_000_000, holders: 1_284 - i * 3 }, created_at: end - i * EPOCH + 3 });
  a.splice(2, 0, { id: 905, action: 'starter-credits', payload: { count: 3, note: 'launch day friends', items: [{ wallet: '7xKq…9f2A', amountUsd: 5 }, { wallet: 'Ab3d…Qz1m', amountUsd: 5 }, { wallet: '0x8f…e21c', amountUsd: 2.5 }] }, created_at: end - 2 * EPOCH + 900 });
  a.splice(5, 0, { id: 903, action: 'revoke-key', payload: { id: 1, wallet: '9xQe…Hn4k', prefix: 'mesh_sk_02dd7a' }, created_at: end - 4 * EPOCH + 1_200 });
  admin.actions = a;
})();

export const mockAdminOverview = async (token: string): Promise<AdminOverview> => {
  await sleep(380);
  requireMockAdmin(token);
  const eps = epochs(48);
  const nodes = MY_NODES;
  const totals = await mockReport();
  return {
    time: now(),
    upstream: 'mock',
    adapter: 'mock',
    chain: TOKENOMICS.chain,
    epochs: eps.map((e) => ({ ...e, feeTxId: e.status === 'complete' ? `mock-fee-tx-${Math.floor(e.epochStart / EPOCH) % 1000}` : null })),
    totals: {
      feesUsd: totals.feesIn,
      treasuryUsd: totals.totals.treasuryInUsd,
      creditsDistributedUsd: totals.creditsOut,
      starterCreditsUsd: totals.totals.starterCreditsUsd,
      creditsUsedUsd: totals.totals.creditsUsedUsd,
      creditsOutstandingUsd: totals.totals.creditsOutstandingUsd,
      wallets: 1_402,
      activeApiKeys: 2_117 - admin.revokedKeys.size,
      requests: totals.totals.requests,
      requests24h: 20_940,
      nodeRewardsUsd: totals.nodeRewards,
      treasuryBalanceUsd: totals.treasuryBalanceUsd,
    },
    holdingAge: totals.holdingAge,
    topHolders: [
      { wallet: '9xQeKf2sVbT7mRw3Lp8nHJq4cYzA6dEuGk1oXiSNHn4k', balanceUsd: 29.999, earnedUsd: 181.42, usedUsd: 151.42 },
      { wallet: '7xKqA2fPq9Lm3nR8sT1vW5yZ0bC4dE6gH8jK1mN3pQ9f', balanceUsd: 24.11, earnedUsd: 96.3, usedUsd: 72.19 },
      { wallet: 'Ab3dEf5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7fQz1m', balanceUsd: 18.73, earnedUsd: 41.0, usedUsd: 22.27 },
      { wallet: '0x8f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2be21c', balanceUsd: 12.4, earnedUsd: 12.4, usedUsd: 0 },
      { wallet: '0x3a9b8c7d6e5f40312a1b0c9d8e7f6a5b4c3d2e1f0a9b', balanceUsd: 9.02, earnedUsd: 30.5, usedUsd: 21.48 },
    ],
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      wallet: n.nodeId === 'node_7Kd2pQ9f' ? '7xKqA2fPq9Lm3nR8sT1vW5yZ0bC4dE6gH8jK1mN3pQ9f' : '0x8f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2be21c',
      url: '-',
      models: n.models,
      chip: n.chip,
      ramGb: n.ramGb,
      busy: n.status === 'busy',
      lastSeen: n.lastSeen ?? 0,
      online: n.status !== 'offline',
      quarantined: verificationOf.get(n.nodeId)?.quarantined ?? false,
      verification: verificationOf.get(n.nodeId) ?? emptyVerification(),
    })),
    verification: {
      checked: 1_046,
      ok: 1_001,
      suspect: 38,
      mismatch: 5,
      inconclusive: 2,
      quarantinedNodes: [...verificationOf.values()].filter((v) => v.quarantined).length,
      recent: [
        { id: 1046, jobId: 'job_Qm3xT9', checkJobId: 'job_Vk2pL1', primaryNode: 'node_7Kd2pQ9f', checkNode: 'node_9Xy1Lm4q', score: 0.93, verdict: 'ok', reasons: [], createdAt: now() - 2_700 },
        { id: 1045, jobId: 'job_Hd8wQ2', checkJobId: null, primaryNode: 'node_2Pq7Zr5k', checkNode: 'upstream:openrouter', score: 0.41, verdict: 'ok', reasons: [], createdAt: now() - 4_100 },
        { id: 1044, jobId: 'job_Rt8mN3', checkJobId: 'job_Ab1cD2', primaryNode: 'node_3Ab8xR2m', checkNode: 'node_7Kd2pQ9f', score: 0.01, verdict: 'mismatch', reasons: ['primary_repeated_char_run', 'similarity_0.01'], createdAt: now() - 7_200 },
        { id: 1043, jobId: 'job_Ww4eR7', checkJobId: 'job_Zz9yX8', primaryNode: 'node_9Xy1Lm4q', checkNode: 'node_7Kd2pQ9f', score: 0.17, verdict: 'suspect', reasons: ['similarity_0.17'], createdAt: now() - 9_900 },
      ],
      config: { enabled: true, sampleRate: 0.05, minJobsBeforeTrust: 20, mismatchPenalty: 3, quarantineAfterMismatches: 2 },
    },
    beta: { ...MOCK_BETA, batchSize: 200, ...waitlistCounts() },
    recentErrors: admin.errors,
    recentAdminActions: [...admin.actions].sort((a, b) => b.id - a.id).slice(0, 50),
  };
};

function pushAdminAction(action: string, payload: unknown): number {
  const id = admin.nextActionId++;
  admin.actions.unshift({ id, action, payload, created_at: now() });
  return id;
}

export const mockAdminRunEpoch = async (token: string): Promise<RunEpochResult> => {
  await sleep(700);
  requireMockAdmin(token);
  const start = Math.floor(now() / EPOCH) * EPOCH - EPOCH;
  const fees = admin.pendingFeesUsd;
  admin.pendingFeesUsd = 0;
  const status = fees > 0 ? 'complete' : 'empty';
  pushAdminAction('run-epoch', { epochStart: start, status, feesUsdMicros: Math.round(fees * 1e6), holders: fees > 0 ? 1_284 : 0 });
  const pool = round2(fees * HOLDER_SHARE);
  return {
    epochStart: start,
    epochEnd: start + EPOCH,
    status,
    feesUsd: fees,
    holderPoolUsd: pool,
    treasuryUsd: round2(fees - pool),
    eligibleHolders: fees > 0 ? 1_284 : 0,
    holdingAgeApplied: false,
    distributed: fees > 0 ? [{ wallet: MOCK_WALLET, usd: round2(pool * 0.0062), multiplier: 1 }] : [],
  };
};

export const mockAdminFakeFees = async (token: string, amountUsd: number) => {
  await sleep(250);
  requireMockAdmin(token);
  admin.pendingFeesUsd = round2(admin.pendingFeesUsd + amountUsd);
  pushAdminAction('fake-fees', { amountUsd });
  return { pendingFeesUsd: admin.pendingFeesUsd };
};

export const mockAdminStarterCredits = async (token: string, items: Array<{ wallet: string; amountUsd: number }>, note?: string): Promise<StarterBatchResult> => {
  await sleep(400);
  requireMockAdmin(token);
  const batchId = pushAdminAction('starter-credits', { count: items.length, note: note ?? null, items });
  return {
    batchId,
    count: items.length,
    totalUsd: round2(items.reduce((a, i) => a + i.amountUsd, 0)),
    granted: items.map((it, i) => ({ ledgerId: 5_000 + i, wallet: it.wallet, amountUsd: it.amountUsd, balanceUsd: it.amountUsd })),
  };
};

/* ---------- starter credits on first connect (docs/SWITCHING.md) ---------- */

const mockStarter: { override: boolean | null; enabled: boolean; grants: StarterGrant[] } = {
  override: null,
  enabled: TOKENOMICS.starterCredits.enabled,
  grants: Array.from({ length: 212 }, (_, i) => ({
    wallet: `${['9xQe', '4kLm', '7pRt', 'Bq2z', 'Hn3v'][i % 5]}${(1000 + i * 37).toString(36)}…${(i * 911).toString(16).padStart(4, '0')}`,
    amountUsd: TOKENOMICS.starterCredits.amountUsd,
    grantedAt: now() - i * 1900 - 120,
    ipHash: ((i * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 8),
  })),
};

function mockStarterStatus(): StarterStatus {
  const granted = mockStarter.grants.length;
  return {
    enabled: mockStarter.enabled,
    configEnabled: TOKENOMICS.starterCredits.enabled,
    override: mockStarter.override,
    amountUsd: TOKENOMICS.starterCredits.amountUsd,
    maxWallets: TOKENOMICS.starterCredits.maxWallets,
    requireMinHold: false,
    maxPerIpPerDay: 3,
    granted,
    remaining: TOKENOMICS.starterCredits.maxWallets === 0 ? null : Math.max(0, TOKENOMICS.starterCredits.maxWallets - granted),
    grantedUsd: round2(granted * TOKENOMICS.starterCredits.amountUsd),
  };
}

export const mockAdminStarter = async (token: string): Promise<StarterStatus> => {
  await sleep(200);
  requireMockAdmin(token);
  return { ...mockStarterStatus(), grants: mockStarter.grants.slice(0, 200) };
};

export const mockAdminStarterToggle = async (token: string, enabled: boolean | null): Promise<StarterStatus> => {
  await sleep(200);
  requireMockAdmin(token);
  const before = mockStarter.enabled;
  mockStarter.override = enabled;
  mockStarter.enabled = enabled === null ? TOKENOMICS.starterCredits.enabled : enabled;
  pushAdminAction('starter-toggle', { before, after: mockStarter.enabled, override: enabled });
  return mockStarterStatus();
};

// ---------- Admin → Token (chain settings) ----------

const PONS = {
  escrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  launchLocker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
  buybackVault: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
};
const chainFile: ChainFieldValues = {
  token: null,
  feeVault: null,
  creditPool: null,
  treasury: null,
  stable: null,
  swapRouter: null,
  priceFeed: null,
  deployBlock: null,
  excludeWallets: [PONS.escrow, PONS.factory, PONS.hook, PONS.launchLocker, PONS.buybackVault].map((a) => a.toLowerCase()),
};
const chainOverrides: ChainFieldValues = {
  token: '0x5fB2a3C8e9d1F0b47a6E2c9D8e7F1a2B3c4D5e6F',
  feeVault: '0x9A1b2C3d4E5f60718293A4b5C6d7E8f9A0B1c2D3',
  creditPool: '0x1F2e3D4c5B6a79889766554433221100FfEeDdCc',
  treasury: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
  deployBlock: 1_842_930,
  excludeWallets: ['0x7777777777777777777777777777777777777777'],
};
const chainMeta = new Map<string, { updatedAt: number; updatedBy: string | null }>(Object.keys(chainOverrides).map((k) => [k, { updatedAt: now() - 3_600 * 5, updatedBy: 'cookie' }]));

function isHexAddr(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function mockChainView(): ChainView {
  const fields = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed', 'deployBlock', 'excludeWallets'] as const;
  const effective: ChainFieldValues = { ...chainFile };
  const overridden: ChainView['overridden'] = [];
  for (const f of fields) {
    const v = chainOverrides[f];
    if (v === undefined || v === null || v === '') continue;
    overridden.push(f);
    if (f === 'excludeWallets') effective.excludeWallets = Array.from(new Set([...((chainFile.excludeWallets as string[]) ?? []), ...((v as string[]) ?? [])]));
    else effective[f] = v;
  }
  const ready = isHexAddr(effective.token) && isHexAddr(effective.feeVault);
  return {
    chain: 'evm',
    network: 'robinhood',
    chainId: 4663,
    chainName: 'Robinhood Chain',
    explorer: 'https://robinhoodchain.blockscout.com',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    feeSource: 'pons',
    adapter: { status: 'mock', requested: 'mock', ready, restartNeeded: false, waitingFor: null },
    sweeper: '0x3C0ffEe1234567890aBcDeF1234567890AbCdEf0',
    file: { path: 'config/deploy.robinhood.json', exists: true, error: null, values: { ...chainFile } },
    overrides: { ...chainOverrides },
    overrideMeta: Array.from(chainMeta.entries()).map(([key, m]) => ({ key, ...m })),
    effective: { ...effective, chainId: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', sweepMode: 'raw', quoteTokens: ['0x0000000000000000000000000000000000000000'], fixedEthUsd: null, ponsEscrow: PONS.escrow, curve: null },
    overridden,
    fields: [...fields],
  };
}

export const mockAdminChain = async (token: string): Promise<ChainView> => {
  await sleep(220);
  requireMockAdmin(token);
  return mockChainView();
};

export const mockAdminChainSave = async (token: string, input: ChainSettingsInput): Promise<ChainView & { ok: boolean; written: Record<string, unknown> }> => {
  await sleep(300);
  requireMockAdmin(token);
  if (input.chainId !== undefined && input.chainId !== 4663) throw new ApiError(400, `these addresses are for chainId ${input.chainId}; config/deploy.robinhood.json is chainId 4663`, 'chain_mismatch');
  const written: Record<string, unknown> = {};
  for (const k of ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v === null || v === '') {
      delete chainOverrides[k];
      chainMeta.delete(k);
      written[k] = null;
      continue;
    }
    if (!isHexAddr(v)) throw new ApiError(400, `${k}: not a 0x address: ${v}`, 'bad_request');
    chainOverrides[k] = v;
    chainMeta.set(k, { updatedAt: now(), updatedBy: 'cookie' });
    written[k] = v;
  }
  if (input.deployBlock !== undefined) {
    if (input.deployBlock === null || input.deployBlock === '') {
      delete chainOverrides.deployBlock;
      chainMeta.delete('deployBlock');
      written.deployBlock = null;
    } else {
      chainOverrides.deployBlock = Number(input.deployBlock);
      chainMeta.set('deployBlock', { updatedAt: now(), updatedBy: 'cookie' });
      written.deployBlock = Number(input.deployBlock);
    }
  }
  if (input.excludeWallets !== undefined) {
    const raw = input.excludeWallets === null ? [] : Array.isArray(input.excludeWallets) ? input.excludeWallets : input.excludeWallets.split(/[\s,]+/);
    const list = Array.from(new Set(raw.map((w) => w.trim()).filter(Boolean).map((w) => w.toLowerCase())));
    const bad = list.find((w) => !isHexAddr(w));
    if (bad) throw new ApiError(400, `excludeWallets: not a 0x address: ${bad}`, 'bad_request');
    if (list.length) {
      chainOverrides.excludeWallets = list;
      chainMeta.set('excludeWallets', { updatedAt: now(), updatedBy: 'cookie' });
    } else {
      delete chainOverrides.excludeWallets;
      chainMeta.delete('excludeWallets');
    }
    written.excludeWallets = list.length ? list : null;
  }
  pushAdminAction('chain-settings', { written });
  return { ok: true, written, ...mockChainView() };
};

export const mockAdminChainClear = async (token: string): Promise<ChainView & { ok: boolean; cleared: string[] }> => {
  await sleep(200);
  requireMockAdmin(token);
  const cleared = Object.keys(chainOverrides);
  for (const k of cleared) delete chainOverrides[k as keyof ChainFieldValues];
  chainMeta.clear();
  pushAdminAction('chain-settings-clear', { cleared });
  return { ok: true, cleared, ...mockChainView() };
};

export const mockAdminChainCheck = async (token: string): Promise<ChainCheckReport> => {
  await sleep(900);
  requireMockAdmin(token);
  const v = mockChainView();
  const items: ChainCheckReport['items'] = [
    { check: 'rpc.chainId', status: 'ok', detail: 'RPC https://rpc.mainnet.chain.robinhood.com is chain 4663 (Robinhood Chain)' },
    { check: 'token.erc20', status: 'ok', detail: 'Mesh (MESH), 18 decimals, supply 1000000000', value: { name: 'Mesh', symbol: 'MESH', decimals: 18 } },
    { check: 'escrow.balance', status: 'ok', detail: 'escrow holds 0.4821 ETH for feeVault', value: '482100000000000000' },
    { check: 'feeVault.owner', status: 'ok', detail: 'owner 0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
    { check: 'feeVault.sweeper', status: 'ok', detail: 'sweeper 0x3C0ffEe1234567890aBcDeF1234567890AbCdEf0 (matches MESH_EVM_PRIVATE_KEY)' },
    { check: 'feeVault.creditPool', status: 'ok', detail: `creditPool ${v.effective.creditPool as string}` },
    { check: 'feeVault.treasury', status: 'ok', detail: `treasury ${v.effective.treasury as string}` },
    { check: 'feeVault.stable', status: 'ok', detail: 'vault has no stable set: only sweepRaw works (sweepMode raw, fine)' },
    { check: 'feeVault.holderShareBps', status: 'ok', detail: 'holder share 5000 bps', value: 5000 },
    { check: 'excludeWallets.curve', status: 'warn', detail: 'no `curve` address yet: add the Pons bonding-curve address (and the pool after graduation) to excludeWallets' },
    { check: 'priceFeed', status: 'warn', detail: 'no priceFeed and no fixedEthUsd: ETH fees will be valued at $0 until one is set' },
    { check: 'deployBlock', status: 'ok', detail: `scans start at block ${v.effective.deployBlock as number}` },
  ];
  pushAdminAction('chain-check', { ok: true, rpcReachable: true, fails: [] });
  return { ok: true, ready: v.adapter.ready, adapter: 'mock', chainId: 4663, rpcUrl: v.rpcUrl, rpcReachable: true, rpcChainId: 4663, items, checkedAt: now() };
};

export const mockAdminRevokeKey = async (token: string, id: number): Promise<RevokeKeyResult> => {
  await sleep(300);
  requireMockAdmin(token);
  if (id > 2_200) throw new ApiError(404, `no api key with id ${id}`, 'not_found');
  const already = admin.revokedKeys.has(id);
  admin.revokedKeys.add(id);
  const k = state.keys.find((x) => x.id === id);
  if (k) k.revoked = true;
  pushAdminAction('revoke-key', { id, wallet: MOCK_WALLET, prefix: k ? k.masked.slice(0, 14) : 'mesh_sk_…', alreadyRevoked: already });
  return { id, wallet: MOCK_WALLET, prefix: k ? k.masked.slice(0, 14) : 'mesh_sk_…', revoked: true, alreadyRevoked: already };
};

// ---------- pre-launch points + referrals ----------

const POINTS_RULES: PointsRules = {
  enabled: true,
  perUsdCredits: 100,
  perUsdSpent: 50,
  perNodeTokenK: 1,
  perReferralSignup: 500,
  referralSharePercent: 10,
  dailyCapPerWallet: 50_000,
  conversion: 'Points convert to MESH at TGE at a ratio set then. Points are not a promise of any amount of MESH.',
};

const refState = {
  code: 'K7PX4M',
  referred: 3,
  referredBy: null as string | null,
  pointsFromSignups: 1500,
  pointsFromShare: 412.35,
};

function pointsLedger(): PointsRow[] {
  const rnd = seeded(5);
  const rows: PointsRow[] = [];
  let id = 900;
  const end = Math.floor(now() / EPOCH) * EPOCH;
  for (let i = 0; i < 8; i++) {
    const t = end - i * EPOCH;
    const dist = state.ledger.find((r) => r.kind === 'distribution' && r.ref === `epoch:${t}`);
    if (dist) rows.push({ id: id--, kind: 'credits', points: Math.round(dist.deltaUsd * POINTS_RULES.perUsdCredits * 1000) / 1000, ref: `credit:${dist.id}`, created_at: t });
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) rows.push({ id: id--, kind: 'usage', points: Math.round(rnd() * 120) / 1000, ref: `usage:${1200 - i * 7 - j}`, created_at: t + 120 + j * 600 });
    if (i % 3 === 0) rows.push({ id: id--, kind: 'node', points: Math.round(rnd() * 42_000) / 1000, ref: `node:${400 - i}`, created_at: t + 1800 });
    if (i === 2) rows.push({ id: id--, kind: 'referral_share', points: 61.2, ref: 'share:8812', created_at: t + 900 });
  }
  if (refState.referred > 0) rows.push({ id: id--, kind: 'referral_signup', points: 500, ref: 'signup:7Kd2…pQ9f', created_at: end - 30 * 3600 });
  return rows.sort((a, b) => b.created_at - a.created_at);
}

export const mockPointsRules = async (): Promise<PointsRules> => {
  await sleep(120);
  return { ...POINTS_RULES };
};

export const mockMyPoints = async (): Promise<MyPoints> => {
  await sleep(320);
  const rows = pointsLedger();
  const byKind = { credits: 0, usage: 0, node: 0, referral_signup: 0, referral_share: 0, adjustment: 0 } as Record<PointsKind, number>;
  for (const r of rows) byKind[r.kind] += r.points;
  // long-running programme: a seeded all-time total sits on top of the recent rows
  byKind.credits += 38_412;
  byKind.usage += 1_730.4;
  byKind.node += 9_204.8;
  byKind.referral_signup = refState.referred * POINTS_RULES.perReferralSignup;
  byKind.referral_share = refState.pointsFromShare;
  const t = now();
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    wallet: MOCK_WALLET,
    points: round(total),
    delta24h: round(rows.filter((r) => r.created_at >= t - 86_400).reduce((a, r) => a + r.points, 0)),
    today: round(rows.filter((r) => r.created_at >= Math.floor(t / 86_400) * 86_400).reduce((a, r) => a + r.points, 0)),
    dailyCap: POINTS_RULES.dailyCapPerWallet,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round(v)])) as Record<PointsKind, number>,
    rank: 42,
    recent: rows.slice(0, 20),
    rules: { ...POINTS_RULES },
  };
};

export const mockMyReferral = async (): Promise<MyReferral> => {
  await sleep(260);
  return {
    wallet: MOCK_WALLET,
    code: refState.code,
    link: `${window.location.origin}/?ref=${refState.code}`,
    referred: refState.referred,
    pointsEarned: Math.round((refState.pointsFromSignups + refState.pointsFromShare) * 1000) / 1000,
    pointsFromSignups: refState.pointsFromSignups,
    pointsFromShare: refState.pointsFromShare,
    referredBy: refState.referredBy,
    perReferralSignup: POINTS_RULES.perReferralSignup,
    referralSharePercent: POINTS_RULES.referralSharePercent,
  };
};

export const mockClaimReferral = async (code: string): Promise<ClaimResult> => {
  await sleep(400);
  const c = code.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(c)) throw new ApiError(400, 'Referral codes are 6 letters or digits.', 'invalid_code');
  if (c === refState.code) throw new ApiError(400, 'You cannot claim your own code.', 'self_referral');
  if (refState.referredBy) throw new ApiError(409, 'This wallet already claimed a referral code.', 'already_referred');
  if (c === 'ZZZZZZ') throw new ApiError(404, 'No wallet has that referral code.', 'unknown_code');
  refState.referredBy = '7Kd2…pQ9f';
  return { wallet: MOCK_WALLET, referrer: refState.referredBy, referrerPointsAwarded: POINTS_RULES.perReferralSignup, sharePercent: POINTS_RULES.referralSharePercent };
};

const BOARD_META: Record<Board, { unit: string; label: string; secondaryLabel: string | null }> = {
  holders: { unit: 'usd', label: 'Credits earned', secondaryLabel: null },
  nodes: { unit: 'tokens', label: 'Tokens served', secondaryLabel: 'jobs' },
  points: { unit: 'points', label: 'Points', secondaryLabel: null },
  referrers: { unit: 'referrals', label: 'Wallets referred', secondaryLabel: 'points' },
};

function fakeWallet(rnd: () => number): string {
  const alpha = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const pick = () => alpha[Math.floor(rnd() * alpha.length)];
  return `${pick()}${pick()}${pick()}${pick()}…${pick()}${pick()}${pick()}${pick()}`;
}

/** Deterministic rankings per board; the mock wallet sits at a fixed rank with its own figures. */
function boardRows(board: Board, total: number): LeaderboardRow[] {
  const rnd = seeded({ holders: 21, nodes: 22, points: 23, referrers: 24 }[board]);
  const rows: LeaderboardRow[] = [];
  let value = { holders: 4_812.4, nodes: 48_300_000, points: 1_284_000, referrers: 212 }[board];
  for (let i = 0; i < total; i++) {
    const decay = 1 - (0.012 + rnd() * 0.045);
    value = board === 'referrers' ? Math.max(1, Math.floor(value * decay)) : value * decay;
    const v = board === 'holders' ? Math.round(value * 100) / 100 : board === 'nodes' ? Math.round(value / 1000) * 1000 : Math.round(value * 1000) / 1000;
    const secondary = board === 'nodes' ? Math.round(v / 1_650) : board === 'referrers' ? Math.round(v * 500 + rnd() * v * 400) : null;
    rows.push({ rank: i + 1, wallet: fakeWallet(rnd), value: v, secondary });
  }
  return rows;
}

export const mockLeaderboard = async (board: Board, withSession: boolean, limit = 100): Promise<Leaderboard> => {
  await sleep(280);
  const total = { holders: 1284, nodes: 41, points: 1611, referrers: 318 }[board];
  const rows = boardRows(board, Math.min(limit, total));
  const myRank = { holders: 57, nodes: 12, points: 42, referrers: 61 }[board];
  // the mock wallet takes over the row at its rank so its figure sits between its neighbours
  const slot = rows[myRank - 1] ?? boardRows(board, myRank)[myRank - 1];
  const myValue = slot.value;
  const mySecondary = slot.secondary;
  if (myRank <= rows.length) rows[myRank - 1] = { rank: myRank, wallet: '9xQe…Hn4k', value: myValue, secondary: mySecondary };
  return {
    board,
    ...BOARD_META[board],
    limit,
    total,
    rows,
    me: withSession ? { rank: myRank, wallet: MOCK_WALLET, value: myValue, secondary: mySecondary } : null,
    cachedAt: now() - 7,
    generatedAt: now(),
  };
};

// ---------- staking ----------

const MOCK_TIERS = [...TOKENOMICS.stakeTiers].sort((a, b) => a.minStake - b.minStake).map((t) => ({ name: t.name, minStake: t.minStake, lockDays: t.lockDays ?? 0, multiplier: t.multiplier }));
/** Demo position: gold with 18 days of lock left. */
const mockStake = { staked: 62_500, lockDays: 30, lockEndsAt: Math.floor(Date.now() / 1000) + 18 * 86_400 };

export const mockStakeTiers = async (): Promise<StakeTiers> => {
  await sleep(200);
  return { chain: TOKENOMICS.chain, ticker: TOKENOMICS.ticker, tiers: MOCK_TIERS, available: true, contract: null, epochSeconds: TOKENOMICS.epochSeconds };
};

export const mockMyStake = async (): Promise<MyStake> => {
  await sleep(300);
  let idx = 0;
  MOCK_TIERS.forEach((t, i) => {
    if (mockStake.staked >= t.minStake && mockStake.lockDays >= t.lockDays) idx = i;
  });
  const tier = MOCK_TIERS[idx];
  const next = MOCK_TIERS[idx + 1];
  const E = TOKENOMICS.epochSeconds;
  return {
    wallet: MOCK_WALLET,
    staked: mockStake.staked,
    tier,
    tierIndex: idx,
    multiplier: tier.multiplier,
    lockDays: mockStake.lockDays,
    lockEndsAt: mockStake.lockEndsAt,
    nextTier: next ? { ...next, needStake: Math.max(0, next.minStake - mockStake.staked) } : null,
    available: true,
    contract: null,
    epoch: Math.floor(Date.now() / 1000 / E) * E,
  };
};

/** Mock wallet state shared with feature mocks (lib/mockMarket.ts) so a listing or a buy moves the same balance /me shows. */
export const mockAccount = {
  wallet: MOCK_WALLET,
  get balanceMicros() {
    return state.balanceMicros;
  },
  adjust(deltaMicros: number, kind: string, ref: string) {
    state.balanceMicros += deltaMicros;
    state.ledger.push({ id: 9000 + state.ledger.length, kind, deltaUsd: deltaMicros / 1e6, deltaUsdMicros: deltaMicros, ref, created_at: now() });
  },
};

/* ---------- model catalogue (GET /v1/models) ---------- */

type MockCatalogueRow = [id: string, displayName: string, vendor: string, tier: 'frontier' | 'fast' | 'open', prompt: number, completion: number, served: CatalogueModel['served'], online: number];
/** Mirrors config/model-prices.json + config/model-policy.json: network models first, then the curated upstream catalogue. */
const MOCK_CATALOGUE: MockCatalogueRow[] = [
  ['llama-3.1-8b', 'Llama 3.1 8B', 'Meta', 'open', 0.05, 0.08, 'both', 14],
  ['qwen-2.5-7b', 'Qwen 2.5 7B', 'Qwen', 'open', 0.04, 0.1, 'both', 5],
  ['anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 'Anthropic', 'frontier', 3, 15, 'upstream', 0],
  ['anthropic/claude-opus-4.1', 'Claude Opus 4.1', 'Anthropic', 'frontier', 15, 75, 'upstream', 0],
  ['openai/gpt-5', 'GPT-5', 'OpenAI', 'frontier', 1.25, 10, 'upstream', 0],
  ['openai/gpt-4.1', 'GPT-4.1', 'OpenAI', 'frontier', 2, 8, 'upstream', 0],
  ['google/gemini-2.5-pro', 'Gemini 2.5 Pro', 'Google', 'frontier', 1.25, 10, 'upstream', 0],
  ['x-ai/grok-4', 'Grok 4', 'xAI', 'frontier', 3, 15, 'upstream', 0],
  ['mistralai/mistral-large', 'Mistral Large', 'Mistral', 'frontier', 2, 6, 'upstream', 0],
  ['anthropic/claude-3.5-haiku', 'Claude 3.5 Haiku', 'Anthropic', 'fast', 0.8, 4, 'upstream', 0],
  ['openai/gpt-5-mini', 'GPT-5 mini', 'OpenAI', 'fast', 0.25, 2, 'upstream', 0],
  ['google/gemini-2.5-flash', 'Gemini 2.5 Flash', 'Google', 'fast', 0.3, 2.5, 'upstream', 0],
  ['deepseek/deepseek-chat-v3.1', 'DeepSeek V3.1', 'DeepSeek', 'open', 0.2, 0.8, 'upstream', 0],
  ['deepseek/deepseek-r1', 'DeepSeek R1', 'DeepSeek', 'open', 0.4, 2, 'upstream', 0],
  ['moonshotai/kimi-k2', 'Kimi K2', 'Moonshot', 'open', 0.14, 2.49, 'upstream', 0],
  ['meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B', 'Meta', 'open', 0.1, 0.32, 'upstream', 0],
  ['qwen/qwen-2.5-72b-instruct', 'Qwen 2.5 72B', 'Qwen', 'open', 0.12, 0.39, 'upstream', 0],
];
/** Mock gateway runs a 20% upstream discount so the picker shows "mesh price vs list" on frontier rows too. */
const MOCK_UPSTREAM_DISCOUNT_BPS = 2000;
const MOCK_GUEST_TIERS: Array<'frontier' | 'fast' | 'open'> = ['open', 'fast'];

export const mockCatalogue = async (guest = false): Promise<Catalogue> => {
  await sleep(200);
  const disc = 1 - MOCK_UPSTREAM_DISCOUNT_BPS / 10_000;
  const rows: CatalogueModel[] = MOCK_CATALOGUE.map(([id, displayName, vendor, tier, prompt, completion, served, online]) => {
    const network = served !== 'upstream';
    return {
      id,
      object: 'model',
      owned_by: network ? 'mesh' : vendor.toLowerCase(),
      name: displayName,
      displayName,
      vendor,
      tier,
      served,
      listPrice: { promptUsdPerM: prompt, completionUsdPerM: completion },
      meshPrice: network
        ? { promptUsdPerM: NETWORK_USD_PER_M, completionUsdPerM: NETWORK_USD_PER_M }
        : { promptUsdPerM: Math.round(prompt * disc * 1e6) / 1e6, completionUsdPerM: Math.round(completion * disc * 1e6) / 1e6 },
      privacy: network ? 'network' : 'upstream_zdr',
      online,
      guestAllowed: network || MOCK_GUEST_TIERS.includes(tier),
      mesh_network: network,
    };
  });
  return {
    object: 'list',
    data: guest ? rows.filter((r) => r.guestAllowed) : rows,
    pricing: { networkPricePerMTokens: NETWORK_USD_PER_M, upstreamDiscountBps: MOCK_UPSTREAM_DISCOUNT_BPS, upstreamMarkupBps: 0, guestTiers: MOCK_GUEST_TIERS },
  };
};
