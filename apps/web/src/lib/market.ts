// Credit marketplace client (docs/MARKETPLACE.md). Shapes mirror apps/gateway/src/routes/market.ts.
import { MOCK } from '../config';
import { rawRequest, rawSessionRequest } from './api';
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
  settlement: 'prepaid';
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
  kind: 'topup' | 'market_buy' | 'market_sale' | 'withdrawal' | 'withdrawal_refund' | 'adjustment';
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
  prepaid: { usd: number; usdMicros: number; ledger: PrepaidRow[] };
  listings: Listing[];
  fills: { asBuyer: Fill[]; asSeller: Fill[] };
  withdrawals: Withdrawal[];
  config: MarketConfig;
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
export const withdraw = (token: string, amountUsd: number): Promise<Withdrawal & { prepaidBalanceUsd: number }> =>
  MOCK ? mock.mockWithdraw(amountUsd) : rawSessionRequest('/me/market/withdraw', { method: 'POST', body: JSON.stringify({ amountUsd }) }, token);
