// Credit marketplace client (docs/MARKETPLACE.md). Shapes mirror apps/gateway/src/routes/market.ts.
import { MOCK } from '../config';
import { COOKIE_SESSION, rawRequest, rawSessionRequest } from './api';
import * as mock from './mockMarket';
export { quoteLocal, fmtDiscount, type MarketQuote } from './marketMath';

export interface MarketConfig {
  enabled: boolean;
  feeBps: number;
  feePercent: number;
  feeToHoldersBps: number;
  minListingUsd: number;
  minFillUsd: number;
  maxDiscountBps: number;
  listingTtlHours: number;
  /** Smallest withdrawal of prepaid balance, USD (0 or absent = no minimum). */
  minWithdrawalUsd?: number;
  settlement: 'prepaid';
  /** Self-serve top-ups (docs/MARKETPLACE.md "Paying in"); `enabled` false until the stablecoin + receiver are configured. */
  deposits?: DepositsInfo;
  /** The stablecoin buyers deposit and sellers withdraw (credits stay off chain). */
  settlementSymbol?: string;
  /** False: unused starter credit cannot be listed. */
  starterTransferable?: boolean;
  /** Days after which credit lapses (a buyer's credit starts a fresh window), or null when credits do not expire. */
  creditExpiryDays?: number | null;
}

/** GET /credits/config: direct sales (docs/PRICING.md §7). */
export interface CreditsConfig {
  enabled: boolean;
  /** USD paid per $1 of credit: always face value. */
  pricePerUsd: number;
  minUsd: number;
  maxUsd: number;
  settlement: 'prepaid';
  deposits?: DepositsInfo;
  creditExpiryDays: number | null;
  soldUsd: number;
  purchases: number;
}

/** POST /me/credits/buy. */
export interface Purchase {
  id: string;
  creditsUsd: number;
  paidUsd: number;
  created_at: number;
  expires_at: number | null;
  creditBalanceUsd: number;
  prepaidBalanceUsd: number;
}

export interface DepositsInfo {
  enabled: boolean;
  chainId: number;
  chainName: string;
  explorer: string | null;
  receiver: string | null;
  tokens: Array<{ symbol: string; address: string; decimals: number }>;
  minUsd: number;
  confirmations: number;
}

export interface DepositResult {
  ok: true;
  creditedUsd: number;
  token: string;
  blockNumber: number;
  prepaid: { usd: number };
}

export interface BookTier {
  discountBps: number;
  pricePerUsd: number;
  availableUsd: number;
  listings: number;
}

export interface Book {
  tiers: BookTier[];
  bestDiscountBps: number | null;
  totalAvailableUsd: number;
  listings: number;
  config: MarketConfig;
  generatedAt: number;
}

export type ListingStatus = 'open' | 'filled' | 'cancelled' | 'expired';
export type WithdrawalStatus = 'pending' | 'paid';

export interface Listing {
  id: string;
  seller?: string;
  amountUsd: number;
  remainingUsd: number;
  soldUsd: number;
  discountBps: number;
  pricePerUsd: number;
  status: ListingStatus;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
}

export interface CreatedListing extends Listing {
  ifFullySold: { buyerPaysUsd: number; feeUsd: number; youReceiveUsd: number };
}

export interface OpenListings {
  listings: Listing[];
  total: number;
  limit: number;
  offset: number;
}

export interface Fill {
  id: string;
  listingId: string;
  buyer: string;
  seller: string;
  creditsUsd: number;
  paidUsd: number;
  feeUsd: number;
  feeToHoldersUsd: number;
  feeToTreasuryUsd: number;
  sellerReceivedUsd: number;
  discountBps: number;
  settlement: 'prepaid' | 'external';
  settlementRef: string | null;
  created_at: number;
}

export interface FillResult extends Fill {
  creditBalanceUsd: number;
  prepaidBalanceUsd: number;
}

export interface PrepaidRow {
  id: number;
  kind: 'topup' | 'market_buy' | 'market_sale' | 'withdrawal' | 'withdrawal_refund' | 'adjustment' | 'credit_purchase';
  deltaUsd: number;
  ref: string | null;
  created_at: number;
}

export interface Withdrawal {
  id: number;
  wallet: string;
  amountUsd: number;
  status: WithdrawalStatus;
  note: string | null;
  txRef: string | null;
  created_at: number;
  paid_at: number | null;
}

export interface MyMarket {
  wallet: string;
  creditBalanceUsd: number;
  /** Unused starter credit in the balance: spendable, not sellable. */
  nonTransferableUsd?: number;
  /** What this wallet could list right now (balance − starter credit − credit held by requests in flight). */
  listableUsd?: number;
  prepaid: { usd: number; usdMicros: number; ledger: PrepaidRow[] };
  listings: Listing[];
  fills: { asBuyer: Fill[]; asSeller: Fill[] };
  withdrawals: Withdrawal[];
  config: MarketConfig;
}

/** A pending request as the operator sees it: `notified_at` is when the alert channel was told (null: not yet). */
export interface AdminWithdrawal extends Withdrawal {
  notified_at: number | null;
}

/** `withdrawals` on GET /admin/market: the queue an operator pays by hand, oldest first. */
export interface AdminWithdrawals {
  pendingUsd: number;
  paidUsd: number;
  pending: AdminWithdrawal[];
  recentPaid: Withdrawal[];
  /** `telegram`, or `log` when no bot is configured (server log only); null when alerts are off. */
  announcedVia: string | null;
}

/** GET /admin/market (the parts the admin page uses). */
export interface AdminMarket {
  withdrawals: AdminWithdrawals;
  prepaid: { outstandingUsd: number };
  generatedAt: number;
}

export interface MarketWindow {
  filledUsd: number;
  paidUsd: number;
  feesUsd: number;
  fills: number;
}

export interface MarketStats {
  openListings: number;
  openDepthUsd: number;
  bestDiscountBps: number | null;
  avgDiscountBps: number | null;
  allTime: MarketWindow & { feesToHoldersUsd: number };
  last24h: MarketWindow;
  feeBps: number;
  generatedAt: number;
}

// ---------- public ----------

export const getMarketConfig = (): Promise<MarketConfig> => (MOCK ? mock.mockMarketConfig() : rawRequest<MarketConfig>('/market/config'));
export const getBook = (): Promise<Book> => (MOCK ? mock.mockBook() : rawRequest<Book>('/market/book'));
export const getOpenListings = (opts: { discountBps?: number; limit?: number; offset?: number } = {}): Promise<OpenListings> => {
  if (MOCK) return mock.mockOpenListings(opts);
  const q = new URLSearchParams();
  if (opts.discountBps !== undefined) q.set('discountBps', String(opts.discountBps));
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  const qs = q.toString();
  return rawRequest<OpenListings>(`/market/listings${qs ? `?${qs}` : ''}`);
};
export const getMarketStats = (): Promise<MarketStats> => (MOCK ? mock.mockMarketStats() : rawRequest<MarketStats>('/market/stats'));

// ---------- sellers ----------

export const createListing = (token: string, input: { amountUsd: number; discountBps: number }): Promise<CreatedListing> =>
  MOCK ? mock.mockCreateListing(input) : rawSessionRequest<CreatedListing>('/market/listings', { method: 'POST', body: JSON.stringify(input) }, token);
export const cancelListing = (token: string, id: string): Promise<Listing> =>
  MOCK ? mock.mockCancelListing(id) : rawSessionRequest<Listing>(`/market/listings/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);

// ---------- buyers ----------

export const fill = (token: string, input: { listingId: string; amountUsd: number }): Promise<FillResult> =>
  MOCK ? mock.mockFill(input) : rawSessionRequest<FillResult>('/market/fills', { method: 'POST', body: JSON.stringify(input) }, token);

// ---------- me ----------

export const myMarket = (token: string): Promise<MyMarket> => (MOCK ? mock.mockMyMarket() : rawSessionRequest<MyMarket>('/me/market', {}, token));
/** POST /me/market/deposits — paste a tx hash; the gateway verifies the transfer on chain and credits the prepaid balance. */
export const deposit = (token: string, txHash: string): Promise<DepositResult> =>
  MOCK ? mock.mockDeposit(txHash) : rawSessionRequest<DepositResult>('/me/market/deposits', { method: 'POST', body: JSON.stringify({ txHash }) }, token);
// ---------- direct sales ----------

/** GET /credits/config; null when direct sales are disabled (404). */
export const getCreditsConfig = async (): Promise<CreditsConfig | null> => {
  if (MOCK) return mock.mockCreditsConfig();
  try {
    return await rawRequest<CreditsConfig>('/credits/config');
  } catch {
    return null;
  }
};
/** POST /me/credits/buy — $1 of prepaid balance buys $1 of credit. */
export const buyCredits = (token: string, amountUsd: number): Promise<Purchase> =>
  MOCK ? mock.mockBuyCredits(amountUsd) : rawSessionRequest<Purchase>('/me/credits/buy', { method: 'POST', body: JSON.stringify({ amountUsd }) }, token);

export const withdraw = (token: string, amountUsd: number): Promise<Withdrawal & { prepaidBalanceUsd: number }> =>
  MOCK ? mock.mockWithdraw(amountUsd) : rawSessionRequest('/me/market/withdraw', { method: 'POST', body: JSON.stringify({ amountUsd }) }, token);

// ---------- admin (operator) ----------

const adminHeaders = (token: string): Record<string, string> => (token === COOKIE_SESSION ? {} : { 'x-admin-token': token });

/** GET /admin/market — the withdrawal queue and what the platform holds in prepaid balances. */
export const adminMarket = (token: string): Promise<AdminMarket> =>
  MOCK ? mock.mockAdminMarket() : rawRequest<AdminMarket>('/admin/market', { headers: adminHeaders(token) });

/** POST /admin/market/withdrawals/:id/paid — record that the payout was sent (audited). */
export const adminMarkWithdrawalPaid = (token: string, id: number, body: { txRef?: string; note?: string }): Promise<Withdrawal> =>
  MOCK ? mock.mockAdminMarkWithdrawalPaid(id, body) : rawRequest<Withdrawal>(`/admin/market/withdrawals/${id}/paid`, { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(body) });
