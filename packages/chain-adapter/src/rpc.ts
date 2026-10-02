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

/** Integer token amount (bigint, base units) → token units as a JS number. */
export function toUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Token units → base units, rounding down. Avoids float drift for large decimals. */
export function toRaw(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units < 0) throw new Error(`invalid amount ${units}`);
  const [int, frac = ''] = units.toFixed(decimals).split('.');
  return BigInt(int + frac.padEnd(decimals, '0').slice(0, decimals));
}
