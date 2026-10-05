/** Minimal JSON-RPC plumbing shared by both adapters; everything is injectable for tests. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonRpc {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'JsonRpcError';
  }
}

export interface JsonRpcOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Retries on network errors / 429 / 5xx with exponential backoff. Default 3. */
  retries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

export function jsonRpc(url: string, opts: JsonRpcOptions = {}): JsonRpc {
  const f: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const retries = opts.retries ?? 3;
  const base = opts.retryBaseMs ?? 250;
  let id = 0;
  return {
    async call<T>(method: string, params: unknown = []): Promise<T> {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
          let res: Response;
          try {
            res = await f(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...opts.headers },
              body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(t);
          }
          if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
          if (!res.ok) throw new JsonRpcError(method, res.status, `HTTP ${res.status}`);
          const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
          if (body.error) throw new JsonRpcError(method, body.error.code, body.error.message, body.error.data);
          return body.result as T;
        } catch (err) {
          lastErr = err;
          if (err instanceof JsonRpcError) throw err; // deterministic: do not retry
          if (attempt === retries) break;
          await sleep(base * 2 ** attempt);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build a JsonRpc from a static method→handler map (tests). Unknown methods throw. */
export function fakeRpc(handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>): JsonRpc & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async call<T>(method: string, params: unknown = []): Promise<T> {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`fakeRpc: no handler for ${method}`);
      return (await h(params)) as T;
    },
  };
}

/** 0..10000 whole basis points, else a share split goes negative and the on-chain transfer reverts. */
export function assertBps(bps: number, what: string): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`${what} must be an integer between 0 and 10000 (got ${bps})`);
  return bps;
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new Error(`invalid decimals ${decimals}`);
}

/**
 * Integer token amount (bigint, base units) → token units as a JS number. The integer and fractional
 * parts are split in bigint space first, so a balance far above 2^53 base units (any 18-decimal token
 * with a few hundred tokens) keeps its integer part exact instead of going through one lossy Number().
 */
export function toUnits(raw: bigint, decimals: number): number {
  checkDecimals(decimals);
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const n = Number(whole) + Number(frac) / Number(scale);
  return neg ? -n : n;
}

/**
 * Token units → base units, rounding down. Parses the double's shortest round-trip decimal string
 * ("0.3", not "0.299999999999999989"), so what the caller typed is what goes on chain; handles the
 * exponent notation JS uses at >= 1e21 and < 1e-6, and any `decimals`.
 */
export function toRaw(units: number, decimals: number): bigint {
  checkDecimals(decimals);
  if (!Number.isFinite(units) || units < 0) throw new Error(`invalid amount ${units}`);
  const [mantissa, expStr] = units.toString().split('e');
  const exp = Number(expStr ?? 0);
  const [int, frac = ''] = mantissa.split('.');
  const digits = int + frac;
  const point = int.length + exp + decimals; // where the decimal point sits in `digits` after scaling
  if (point <= 0) return 0n;
  if (point >= digits.length) return BigInt(digits.padEnd(point, '0'));
  return BigInt(digits.slice(0, point));
}
