import { useCallback, useEffect, useRef, useState } from 'react';
import { STORAGE, TOKENOMICS } from '../config';
import * as api from './api';
import { ApiError } from './api';
import { useAuth } from './auth';
import type { ApiKey, Board, EpochSummary, Leaderboard, Me, MyPoints, MyReferral, MyStake, NodeView, NodesSummary, StakeTiers, Stats } from './types';

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Generic poll-able fetch hook. `deps` restart it; `intervalMs` polls while the tab is visible. */
export function useAsync<T>(fn: (() => Promise<T>) | null, deps: unknown[], intervalMs = 0): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(fn));
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    try {
      const res = await f();
      if (!alive.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!fn) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
    let timer: number | undefined;
    if (intervalMs > 0) {
      const tick = () => {
        if (document.visibilityState === 'visible') void reload();
      };
      timer = window.setInterval(tick, intervalMs);
    }
    return () => {
      alive.current = false;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}

export function useStats(pollMs = 30_000): Async<Stats> {
  return useAsync(api.getStats, [], pollMs);
}

/** Public epoch history (GET /epochs), newest first. */
export function useEpochs(limit = 48, pollMs = 60_000): Async<EpochSummary[]> {
  return useAsync(() => api.getEpochs(limit), [limit], pollMs);
}

/** Public node summary (GET /nodes). */
export function useNodes(pollMs = 60_000): Async<NodesSummary> {
  return useAsync(api.getNodes, [], pollMs);
}

/** Session-scoped fetch that signs the user out on a 401. */
export function useSessionAsync<T>(fn: (token: string) => Promise<T>, deps: unknown[] = [], pollMs = 0): Async<T> {
  const { token, expire } = useAuth();
  const wrapped = token
    ? async () => {
        try {
          return await fn(token);
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) expire();
          throw err;
        }
      }
    : null;
  return useAsync(wrapped, [token, ...deps], pollMs);
}

export const useMe = (pollMs = 30_000): Async<Me> => useSessionAsync(api.getMe, [], pollMs);

/** The wallet's nodes with per-node stats merged in (GET /me/nodes, then GET /nodes/:id each). Polls every 15 s. */
export const useMyNodes = (pollMs = 15_000): Async<NodeView[]> =>
  useSessionAsync(
    async (token) => {
      const nodes = await api.listMyNodes(token);
      const stats = await Promise.all(nodes.map((n) => api.getNodeStats(token, n.nodeId).catch(() => null)));
      return nodes.map((n, i) => ({ ...n, stats: stats[i] }));
    },
    [],
    pollMs,
  );
export const useKeys = (): Async<ApiKey[]> => useSessionAsync(api.listKeys, []);

/** Public tier table (GET /stake/tiers). */
export const useStakeTiers = (): Async<StakeTiers> => useAsync(api.getStakeTiers, []);

/** This wallet's staking position (GET /me/stake). Polls so a confirmed stake shows up after the epoch cache rolls. */
export const useMyStake = (pollMs = 30_000): Async<MyStake> => useSessionAsync(api.getMyStake, [], pollMs);

/** Pre-launch points for the signed-in wallet (GET /me/points). */
export const useMyPoints = (pollMs = 30_000): Async<MyPoints> => useSessionAsync(api.getMyPoints, [], pollMs);

/** Referral code, link and earnings for the signed-in wallet (GET /me/referral). */
export const useMyReferral = (pollMs = 60_000): Async<MyReferral> => useSessionAsync(api.getMyReferral, [], pollMs);

/** Public leaderboard; passes the session token when there is one so the response carries the caller's rank. */
export function useLeaderboard(board: Board, limit = 100, pollMs = 30_000): Async<Leaderboard> {
  const { token } = useAuth();
  return useAsync(() => api.getLeaderboard(board, token, limit), [board, limit, token], pollMs);
}

/** Seconds until the next epoch boundary. Epochs are aligned to multiples of epochSeconds (gateway cron: top of the hour). */
export function useEpochCountdown(epochSeconds: number | undefined): { remaining: number; progress: number; nextAt: number } {
  const len = epochSeconds || TOKENOMICS.epochSeconds;
  const calc = () => {
    const now = Date.now() / 1000;
    const nextAt = Math.ceil(now / len) * len;
    const remaining = Math.max(0, nextAt - now);
    return { remaining, progress: 1 - remaining / len, nextAt };
  };
  const [v, setV] = useState(calc);
  useEffect(() => {
    const t = window.setInterval(() => setV(calc()), 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [len]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

export function useTheme(): ['light' | 'dark' | 'system', (t: 'light' | 'dark' | 'system') => void] {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      const t = localStorage.getItem(STORAGE.theme);
      return t === 'dark' || t === 'light' ? t : 'system';
    } catch {
      return 'system';
    }
  });
  const set = useCallback((t: 'light' | 'dark' | 'system') => {
    setTheme(t);
    try {
      if (t === 'system') localStorage.removeItem(STORAGE.theme);
      else localStorage.setItem(STORAGE.theme, t);
    } catch {
      /* ignore */
    }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, []);
  return [theme, set];
}

export function useCopy(): [copied: boolean, copy: (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; caller may fall back to selecting text */
    }
  }, []);
  return [copied, copy];
}
