import type { FetchLike, JsonRpc } from '../rpc.js';
import type { TransferEvent } from '../timeweight.js';

/**
 * Helius DAS `getTokenAccounts` (paginated). Works against any Helius RPC URL (the DAS
 * methods live on the same endpoint). Returns owner → total balance (base units).
 */
export interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: number | string;
  frozen?: boolean;
}

export async function dasTokenAccountsByMint(
  rpc: JsonRpc,
  mint: string,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<DasTokenAccount[]> {
  const limit = opts.limit ?? 1000;
  const out: DasTokenAccount[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 1000); page++) {
    const r = await rpc.call<{ token_accounts?: DasTokenAccount[]; total?: number }>('getTokenAccounts', {
      mint,
      page,
      limit,
      options: { showZeroBalance: false },
    });
    const accounts = r.token_accounts ?? [];
    out.push(...accounts);
    if (accounts.length < limit) break;
  }
  return out;
}

export function balancesByOwner(accounts: DasTokenAccount[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const a of accounts) {
    const amt = BigInt(String(a.amount));
    if (amt <= 0n) continue;
    m.set(a.owner, (m.get(a.owner) ?? 0n) + amt);
  }
  return m;
}

/**
 * Helius enhanced transactions for an address (here: the mint), walked backwards in time
 * until `untilTs`. Each tx carries `tokenTransfers[]` with owner-level from/to, which is
 * exactly what the time-weighting needs (we never see token-account addresses).
 */
export interface EnhancedTx {
  signature: string;
  timestamp: number;
  transactionError?: unknown;
  tokenTransfers?: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    mint: string;
    tokenAmount: number; // UI amount (already divided by decimals)
  }>;
}

export interface HeliusTxOptions {
  apiKey: string;
  baseUrl?: string; // default https://api.helius.xyz
  fetch?: FetchLike;
  /** Stop paging after this many requests (safety). */
  maxPages?: number;
  pageLimit?: number;
}

export async function heliusTransfersForMint(
  mint: string,
  untilTs: number,
  decimals: number,
  opts: HeliusTxOptions,
): Promise<{ events: TransferEvent[]; complete: boolean }> {
  const f: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const base = (opts.baseUrl ?? 'https://api.helius.xyz').replace(/\/$/, '');
  const events: TransferEvent[] = [];
  let before: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 200); page++) {
    const url = new URL(`${base}/v0/addresses/${mint}/transactions`);
    url.searchParams.set('api-key', opts.apiKey);
    url.searchParams.set('limit', String(opts.pageLimit ?? 100));
    if (before) url.searchParams.set('before', before);
    const res = await f(url.toString());
    if (!res.ok) throw new Error(`helius transactions HTTP ${res.status}`);
    const txs = (await res.json()) as EnhancedTx[];
    if (!Array.isArray(txs) || txs.length === 0) return { events, complete: true };
    for (const tx of txs) {
      if (tx.timestamp < untilTs) return { events, complete: true };
      if (tx.transactionError) continue;
      for (const t of tx.tokenTransfers ?? []) {
        if (t.mint !== mint) continue;
        events.push({
          ts: tx.timestamp,
          from: t.fromUserAccount || null,
          to: t.toUserAccount || null,
          amount: uiToRaw(t.tokenAmount, decimals),
        });
      }
    }
    before = txs[txs.length - 1].signature;
  }
  return { events, complete: false };
}

function uiToRaw(ui: number, decimals: number): bigint {
  const [i, fr = ''] = ui.toFixed(decimals).split('.');
  return BigInt(i + fr.padEnd(decimals, '0').slice(0, decimals));
}
