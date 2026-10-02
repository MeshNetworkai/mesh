import { API_URL, MOCK } from '../config';
import { shortAddr } from './format';
import * as mock from './mock';
import type {
  AdminOverview,
  ApiKey,
  Board,
  ClaimResult,
  Leaderboard,
  CreatedKey,
  EpochSummary,
  EpochsResponse,
  KeyUsage,
  LinkCode,
  Me,
  MeshRoute,
  Model,
  MyNode,
  MyStake,
  MyPoints,
  MyReferral,
  NodeStats,
  NodesSummary,
  NonceResponse,
  PointsRules,
  RegisterChallenge,
  Report,
  RevokeKeyResult,
  RunEpochResult,
  Session,
  StakeTiers,
  StarterBatchResult,
  Stats,
  Usage,
  WeekDetail,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Extracts a readable message from gateway error bodies (plain `{error, message}` or OpenAI-shaped `{error:{message}}`). */
async function readError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error;
    if (typeof err === 'string') {
      code = err;
      message = typeof body.message === 'string' ? body.message : err;
    } else if (err && typeof err === 'object') {
      const e = err as { message?: string; code?: string | null };
      message = e.message ?? message;
      code = e.code ?? null;
    }
  } catch {
    /* non-JSON body */
  }
  return new ApiError(res.status, message, code);
}

/**
 * Sentinel passed where a bearer token used to go: "the session lives in the HttpOnly cookie".
 * `request` then sends no Authorization header and relies on `credentials: 'include'`.
 */
export const COOKIE_SESSION = 'cookie';

/** Readable double-submit cookie set by the gateway next to the HttpOnly session/admin cookie. */
export const CSRF_COOKIE = 'mesh_csrf';
export const CSRF_HEADER = 'x-mesh-csrf';

export function readCookie(name: string): string | null {
  try {
    for (const part of document.cookie.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
  } catch {
    /* no document (SSR/tests) or cookies blocked */
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (token && token !== COOKIE_SESSION) headers.set('authorization', `Bearer ${token}`);
  // Cookie-authenticated state changes must echo the CSRF cookie (gateway: double-submit check).
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set(CSRF_HEADER, csrf);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, `Could not reach the gateway at ${API_URL}`, 'network');
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- session refresh ----------

/**
 * The AuthProvider registers how to read / replace the current session token. When a
 * session-scoped request gets a 401 we try POST /auth/refresh exactly once with the token we
 * hold, swap in the fresh one and retry the original request. A second 401 propagates to the
 * caller (hooks then sign the user out).
 */
export interface SessionStore {
  getToken: () => string | null;
  setToken: (token: string) => void;
}
let sessionStore: SessionStore | null = null;
let refreshing: Promise<string | null> | null = null;

export function registerSessionStore(store: SessionStore | null) {
  sessionStore = store;
}

export const refreshSession = (token: string) =>
  request<Session & { expiresIn: string; expiresInSec: number }>('/auth/refresh', { method: 'POST' }, token);

/** GET /auth/session — who the cookie (or bearer) says we are; 401 when signed out. */
export const getSession = () => request<{ wallet: string; chain: string; exp: number | null; via: 'bearer' | 'cookie' }>('/auth/session');

/** POST /auth/logout — clears the HttpOnly session cookie and its CSRF twin. */
export const logout = () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' });

/** Refreshes the stored session once; concurrent 401s share the same refresh. */
function refreshOnce(staleToken: string): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await refreshSession(staleToken);
        // Cookie sessions: the gateway re-set the cookie; keep using it rather than holding the JWT in JS.
        const next = staleToken === COOKIE_SESSION ? COOKIE_SESSION : res.token;
        sessionStore?.setToken(next);
        return next;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** `request` for session-JWT endpoints: refreshes the token once on 401 and retries. */
async function sessionRequest<T>(path: string, init: RequestInit = {}, token: string): Promise<T> {
  try {
    return await request<T>(path, init, token);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || MOCK) throw err;
    // Only refresh the token we are actually signed in with (not a stale copy a component held).
    const current = sessionStore?.getToken();
    if (current && current !== token) return request<T>(path, init, current);
    const fresh = await refreshOnce(token);
    if (!fresh) throw err;
    return request<T>(path, init, fresh);
  }
}

// ---------- public ----------

export const getStats = (): Promise<Stats> => (MOCK ? mock.mockStats() : request<Stats>('/stats'));

export const getEpochs = async (limit = 48): Promise<EpochSummary[]> =>
  MOCK ? mock.mockEpochs(limit) : (await request<EpochsResponse>(`/epochs?limit=${limit}`)).epochs;

export const getNodes = (): Promise<NodesSummary> => (MOCK ? mock.mockNodes() : request<NodesSummary>('/nodes'));

/** GET /report — public treasury report (totals, 7d/30d, 12 ISO weeks). */
export const getReport = (): Promise<Report> => (MOCK ? mock.mockReport() : request<Report>('/report'));

/** GET /report/weekly/:isoWeek — one week in detail. */
export const getWeek = (isoWeek: string): Promise<WeekDetail> =>
  MOCK ? mock.mockWeek(isoWeek) : request<WeekDetail>(`/report/weekly/${encodeURIComponent(isoWeek)}`);

/** GET /points/rules — how points are earned (public; drives the "how to earn" tooltip). */
export const getPointsRules = (): Promise<PointsRules> => (MOCK ? mock.mockPointsRules() : request<PointsRules>('/points/rules'));

/** GET /leaderboard/:board — public ranking (wallets truncated); carries the caller's rank when a session token is passed. */
export const getLeaderboard = (board: Board, token?: string | null, limit = 100): Promise<Leaderboard> =>
  MOCK ? mock.mockLeaderboard(board, Boolean(token), limit) : request<Leaderboard>(`/leaderboard/${board}?limit=${limit}`, {}, token ?? undefined);

/** GET /stake/tiers — public tier table from config/tokenomics.json. */
export const getStakeTiers = (): Promise<StakeTiers> => (MOCK ? mock.mockStakeTiers() : request<StakeTiers>('/stake/tiers'));

// ---------- operator ----------
// The Admin page exchanges ADMIN_TOKEN for an HttpOnly admin cookie (POST /admin/login) and then
// passes COOKIE_SESSION; a raw token still works for scripts (x-admin-token header).

const adminHeaders = (token: string): Record<string, string> => (token === COOKIE_SESSION ? {} : { 'x-admin-token': token });

/** POST /admin/login — trades the admin token for a 12 h HttpOnly admin cookie (+ CSRF cookie). */
export const adminLogin = (token: string): Promise<{ ok: boolean; expiresInSec: number }> =>
  MOCK ? mock.mockAdminLogin(token) : request<{ ok: boolean; expiresInSec: number }>('/admin/login', { method: 'POST', headers: adminHeaders(token) });

/** GET /admin/session — is the admin cookie still valid? */
export const adminSession = (): Promise<{ ok: boolean }> => (MOCK ? Promise.reject(new ApiError(401, 'no mock admin cookie')) : request<{ ok: boolean }>('/admin/session'));

export const adminLogout = (): Promise<{ ok: boolean }> => (MOCK ? Promise.resolve({ ok: true }) : request<{ ok: boolean }>('/admin/logout', { method: 'POST' }));

export const adminOverview = (token: string): Promise<AdminOverview> =>
  MOCK ? mock.mockAdminOverview(token) : request<AdminOverview>('/admin/overview', { headers: adminHeaders(token) });

export const adminRunEpoch = (token: string, epochStart?: number): Promise<RunEpochResult> =>
  MOCK
    ? mock.mockAdminRunEpoch(token)
    : request<RunEpochResult>('/admin/run-epoch', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(epochStart ? { epochStart } : {}) });

export const adminFakeFees = (token: string, amountUsd: number): Promise<{ pendingFeesUsd: number }> =>
  MOCK
    ? mock.mockAdminFakeFees(token, amountUsd)
    : request<{ pendingFeesUsd: number }>('/admin/fake-fees', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify({ amountUsd }) });

export const adminStarterCredits = (token: string, items: Array<{ wallet: string; amountUsd: number }>, note?: string): Promise<StarterBatchResult> =>
  MOCK
    ? mock.mockAdminStarterCredits(token, items, note)
    : request<StarterBatchResult>('/admin/starter-credits', {
        method: 'POST',
        headers: adminHeaders(token),
        body: JSON.stringify(note ? { items, note } : { items }),
      });

export const adminRevokeKey = (token: string, id: number): Promise<RevokeKeyResult> =>
  MOCK ? mock.mockAdminRevokeKey(token, id) : request<RevokeKeyResult>(`/admin/keys/${id}`, { method: 'DELETE', headers: adminHeaders(token) });

// ---------- auth ----------

/** Returns the SIWE/SIWS-style message the wallet must sign verbatim. */
export const getNonce = (wallet: string) =>
  request<NonceResponse>('/auth/nonce', { method: 'POST', body: JSON.stringify({ wallet }) });

/** Echoes the signed message so the gateway can pinpoint tampering (domain / nonce / issued-at). */
export const verifySignature = (wallet: string, signature: string, chain: 'solana' | 'evm', message: string) =>
  request<Session & { expiresIn: string }>('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ wallet, signature, chain, message }),
  });

// ---------- session-scoped ----------

export const getMe = (token: string): Promise<Me> => (MOCK ? mock.mockMe() : sessionRequest<Me>('/me', {}, token));

/** GET /me/stake — this wallet's staking position and tier (cached per epoch on the gateway). */
export const getMyStake = (token: string): Promise<MyStake> => (MOCK ? mock.mockMyStake() : sessionRequest<MyStake>('/me/stake', {}, token));

export const listKeys = async (token: string): Promise<ApiKey[]> =>
  MOCK ? mock.mockKeys() : (await sessionRequest<{ keys: ApiKey[] }>('/keys', {}, token)).keys;

export interface KeyInput {
  name?: string | null;
  spendLimitUsd?: number | null;
}

export const createKey = (token: string, input: KeyInput = {}): Promise<CreatedKey> => {
  const body: KeyInput = {};
  if (input.name) body.name = input.name;
  if (input.spendLimitUsd != null) body.spendLimitUsd = input.spendLimitUsd;
  return MOCK ? mock.mockCreateKey(body) : sessionRequest<CreatedKey>('/keys', { method: 'POST', body: JSON.stringify(body) }, token);
};

export const revokeKey = (token: string, id: number): Promise<unknown> =>
  MOCK ? mock.mockRevokeKey(id) : sessionRequest(`/keys/${id}`, { method: 'DELETE' }, token);

/** PATCH /keys/:id — rename and/or set/clear the spend limit (null clears). Returns the updated key. */
export const updateKey = (token: string, id: number, patch: KeyInput): Promise<ApiKey> =>
  MOCK ? mock.mockUpdateKey(id, patch) : sessionRequest<ApiKey>(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token);

export const keyUsage = (token: string, id: number): Promise<KeyUsage> =>
  MOCK ? mock.mockKeyUsage(id) : sessionRequest<KeyUsage>(`/keys/${id}/usage`, {}, token);

// ---------- points + referrals ----------

/** GET /me/points — balance, 24h delta, today vs cap, split by kind. */
export const getMyPoints = (token: string): Promise<MyPoints> => (MOCK ? mock.mockMyPoints() : sessionRequest<MyPoints>('/me/points', {}, token));

/** GET /me/referral — the wallet's code, share link and referral earnings. */
export const getMyReferral = (token: string): Promise<MyReferral> => (MOCK ? mock.mockMyReferral() : sessionRequest<MyReferral>('/me/referral', {}, token));

/** POST /referrals/claim — bind this wallet to a referrer's code (once). */
export const claimReferral = (token: string, code: string): Promise<ClaimResult> =>
  MOCK ? mock.mockClaimReferral(code) : sessionRequest<ClaimResult>('/referrals/claim', { method: 'POST', body: JSON.stringify({ code }) }, token);

// ---------- nodes (run a node) ----------

/** GET /me/nodes — the wallet's registered nodes. Accepts `{nodes: [...]}` or a bare array. */
export const listMyNodes = async (token: string): Promise<MyNode[]> => {
  if (MOCK) return mock.mockMyNodes();
  const body = await sessionRequest<{ nodes?: MyNode[] } | MyNode[]>('/me/nodes', {}, token);
  const rows = Array.isArray(body) ? body : (body.nodes ?? []);
  return rows.map((n) => ({ ...n, models: Array.isArray(n.models) ? n.models : [], status: n.status ?? 'offline', lastSeen: n.lastSeen ?? null }));
};

/** POST /nodes/register/challenge — the registration text the wallet signs (shared with the agent's signed flow). */
export const getRegisterChallenge = (wallet: string): Promise<RegisterChallenge> =>
  MOCK ? mock.mockRegisterChallenge(wallet) : request<RegisterChallenge>('/nodes/register/challenge', { method: 'POST', body: JSON.stringify({ wallet }) });

/** POST /nodes/link — trades the signed challenge for a one-time link code (15 min) bound to the session wallet. */
export const createLinkCode = (token: string, input: { nonce: string; signature: string; chain: 'solana' | 'evm' }): Promise<LinkCode> =>
  MOCK ? mock.mockLinkCode() : sessionRequest<LinkCode>('/nodes/link', { method: 'POST', body: JSON.stringify(input) }, token);

/** GET /nodes/:id — stats for one node (session bearer). */
export const getNodeStats = (token: string, nodeId: string): Promise<NodeStats> =>
  MOCK ? mock.mockNodeStats(nodeId) : sessionRequest<NodeStats>(`/nodes/${encodeURIComponent(nodeId)}`, {}, token);

// ---------- OpenAI-compatible ----------

export const listModels = async (apiKey: string): Promise<Model[]> => {
  if (MOCK) return mock.mockModels();
  const body = await request<{ data: Model[] }>('/v1/models', {}, apiKey);
  return body.data ?? [];
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  usage: Usage | null;
  model: string;
  latencyMs: number;
  servedBy: string;
  /** Set when a Mesh node served the request (carries listCostUsd / savedUsd when savings are shown). */
  mesh: MeshRoute | null;
}

/**
 * Streams a chat completion. `onDelta` receives content fragments; the resolved value carries
 * the usage object from the final SSE chunk (OpenRouter includes `usage.cost` when asked).
 */
export async function streamChat(
  opts: {
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    upstreamName?: string;
  },
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  const started = performance.now();
  if (MOCK) {
    let usage: Usage | null = null;
    let model = opts.model;
    let mesh: MeshRoute | null = null;
    for await (const chunk of mock.mockChatStream(opts.model, opts.signal)) {
      if (chunk.content) onDelta(chunk.content);
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) model = chunk.model;
      if (chunk.mesh) mesh = chunk.mesh;
    }
    return { usage, model, latencyMs: performance.now() - started, servedBy: mock.MOCK_NODE_LABEL, mesh };
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true, usage: { include: true } }),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, `Could not reach the gateway at ${API_URL}`, 'network');
  }
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ApiError(502, 'Gateway returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage: Usage | null = null;
  let model = opts.model;
  let mesh: MeshRoute | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const obj = JSON.parse(data) as {
        model?: string;
        usage?: Usage | null;
        mesh?: MeshRoute | null;
        choices?: Array<{ delta?: { content?: string | null } }>;
      };
      if (obj.model) model = obj.model;
      if (obj.usage) usage = obj.usage;
      if (obj.mesh?.route === 'node') mesh = obj.mesh;
      const content = obj.choices?.[0]?.delta?.content;
      if (content) onDelta(content);
    } catch {
      /* partial / comment line */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) buf.split('\n').forEach(handleLine);

  const served = mesh as MeshRoute | null; // assigned inside handleLine; TS narrows the let to null here
  return {
    usage,
    model,
    latencyMs: performance.now() - started,
    servedBy: served ? `node ${shortAddr(served.nodeId, 6, 4)}` : opts.upstreamName ? `upstream ${opts.upstreamName}` : 'gateway',
    mesh: served,
  };
}
