// Fake credit marketplace for VITE_MOCK=1. Module-scope state so listing, buying and withdrawing behave like the gateway.
import { ApiError } from './api';
import { mockAccount } from './mock';
import type { Book, CreatedListing, Fill, FillResult, Listing, MarketConfig, MarketStats, MyMarket, OpenListings, PrepaidRow, Withdrawal } from './market';
import { quoteLocal } from './marketMath';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3_600;
const DAY = 86_400;
const CFG: MarketConfig = { enabled: true, feeBps: 250, feePercent: 2.5, feeToHoldersBps: 5000, minListingUsd: 1, minFillUsd: 0.01, maxDiscountBps: 7000, listingTtlHours: 168, settlement: 'prepaid', deposits: { enabled: true, chainId: 4663, chainName: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com', receiver: '0x00000000000000000000000000000000000000Fe', tokens: [{ symbol: 'USDC', address: '0x1111111111111111111111111111111111111111', decimals: 6 }], minUsd: 5, confirmations: 3 } };
const ME = mockAccount.wallet;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

let seq = 100;
const id = (p: string) => `${p}_${(seq++).toString(36).padStart(6, '0')}`;

interface L extends Listing {
  seller: string;
}

const listings: L[] = [];
const fills: Fill[] = [];
const prepaidLedger: PrepaidRow[] = [];
const withdrawals: Withdrawal[] = [];
let prepaidSeq = 1;

function prepaidAdd(kind: PrepaidRow['kind'], deltaUsd: number, ref: string | null, at = now()) {
  prepaidLedger.unshift({ id: prepaidSeq++, kind, deltaUsd: r6(deltaUsd), ref, created_at: at });
}
const prepaidBalance = () => r6(prepaidLedger.reduce((a, p) => a + p.deltaUsd, 0));

function seedListing(seller: string, amountUsd: number, discountBps: number, ageHours: number, soldUsd = 0): L {
  const created = now() - ageHours * HOUR;
  const l: L = {
    id: id('lst'),
    seller,
    amountUsd,
    remainingUsd: amountUsd - soldUsd,
    soldUsd,
    discountBps,
    pricePerUsd: (10_000 - discountBps) / 10_000,
    status: 'open',
    created_at: created,
    expires_at: created + CFG.listingTtlHours * HOUR,
    closed_at: null,
  };
  listings.push(l);
  return l;
}

// Other holders' depth: a real-looking book with a few tiers.
seedListing('7xKqA2fPq9Lm3nR8sT1vW5yZ0bC4dE6gH8jK1mN3pQ9f', 120, 3500, 30, 40);
seedListing('Ab3dEf5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7fQz1m', 60, 3000, 70);
seedListing('0x8f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2be21c', 250, 3000, 12, 70);
seedListing('4kLmN8pQ2rS6tU0vW4xY8zA2bC6dE0fG4hJ8kL2mN6pQ', 45, 2500, 100);
seedListing('9aBcD3eFgH7iJkL1mNoP5qRsT9uVwX3yZaB7cDeF1gHi', 500, 2000, 40, 110);
seedListing('2mNoP6qRsT0uVwX4yZaB8cDeF2gHiJ6kLmN0pQrS4tUv', 80, 1500, 130);
seedListing('6qRsT0uVwX4yZaB8cDeF2gHiJ6kLmN0pQrS4tUv8wXyZ', 30, 1000, 150);
// One of mine, partly sold: the sale paid into my prepaid balance.
const mine = seedListing(ME, 40, 2500, 60, 15);
{
  const q = quoteLocal(15, 2500);
  const f: Fill = {
    id: id('fill'),
    listingId: mine.id,
    buyer: '3pQ9fXk2mN7vB4cT8hL1sD6yR0wE5uA9iJ3oG7zK2lM',
    seller: ME,
    creditsUsd: 15,
    paidUsd: q.buyerPaysUsd,
    feeUsd: q.feeUsd,
    feeToHoldersUsd: q.feeToHoldersUsd,
    feeToTreasuryUsd: q.feeToTreasuryUsd,
    sellerReceivedUsd: q.sellerReceivesUsd,
    discountBps: 2500,
    settlement: 'prepaid',
    settlementRef: null,
    created_at: now() - 2 * DAY,
  };
  fills.push(f);
  prepaidAdd('topup', 25, 'beta:welcome', now() - 5 * DAY);
  prepaidAdd('market_sale', q.sellerReceivesUsd, `fill:${f.id}`, f.created_at);
  withdrawals.push({ id: 1, wallet: ME, amountUsd: 10, status: 'paid', note: null, txRef: '5Kq…mock-usdc-payout-3', created_at: now() - 4 * DAY, paid_at: now() - 3 * DAY });
  prepaidAdd('withdrawal', -10, 'withdrawal:1', now() - 4 * DAY);
}

const stats = { filledUsd: 1_840, paidUsd: 1_352.4, feesUsd: 33.81, fills: 61, weightedBps: 1_840 * 2_650 };

function reap() {
  const t = now();
  for (const l of listings) {
    if (l.status === 'open' && l.expires_at <= t) {
      l.status = 'expired';
      l.closed_at = t;
      if (l.seller === ME && l.remainingUsd > 0) mockAccount.adjust(Math.round(l.remainingUsd * 1e6), 'market_refund', `listing:${l.id}:expired`);
      l.remainingUsd = 0;
    }
  }
}

const open = () => listings.filter((l) => l.status === 'open' && l.remainingUsd > 0);
const pub = (l: L): Listing => ({ ...l, seller: undefined });
const bySeq = (a: Listing, b: Listing) => b.discountBps - a.discountBps || a.created_at - b.created_at;

export const mockMarketConfig = async (): Promise<MarketConfig> => {
  await sleep(120);
  return CFG;
};

export const mockBook = async (): Promise<Book> => {
  await sleep(250);
  reap();
  const byTier = new Map<number, { availableUsd: number; listings: number }>();
  for (const l of open()) {
    const t = byTier.get(l.discountBps) ?? { availableUsd: 0, listings: 0 };
    t.availableUsd = r6(t.availableUsd + l.remainingUsd);
    t.listings += 1;
    byTier.set(l.discountBps, t);
  }
  const tiers = [...byTier.entries()].sort((a, b) => b[0] - a[0]).map(([discountBps, t]) => ({ discountBps, pricePerUsd: (10_000 - discountBps) / 10_000, ...t }));
  return {
    tiers,
    bestDiscountBps: tiers[0]?.discountBps ?? null,
    totalAvailableUsd: r6(tiers.reduce((a, t) => a + t.availableUsd, 0)),
    listings: tiers.reduce((a, t) => a + t.listings, 0),
    config: CFG,
    generatedAt: now(),
  };
};

export const mockOpenListings = async (opts: { discountBps?: number; limit?: number; offset?: number }): Promise<OpenListings> => {
  await sleep(150);
  reap();
  const all = open()
    .filter((l) => opts.discountBps === undefined || l.discountBps === opts.discountBps)
    .sort(bySeq);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return { listings: all.slice(offset, offset + limit).map(pub), total: all.length, limit, offset };
};

export const mockMarketStats = async (): Promise<MarketStats> => {
  await sleep(200);
  const b = await mockBook();
  return {
    openListings: b.listings,
    openDepthUsd: b.totalAvailableUsd,
    bestDiscountBps: b.bestDiscountBps,
    avgDiscountBps: Math.round(stats.weightedBps / stats.filledUsd),
    allTime: { filledUsd: r6(stats.filledUsd), paidUsd: r6(stats.paidUsd), feesUsd: r6(stats.feesUsd), feesToHoldersUsd: r6(stats.feesUsd / 2), fills: stats.fills },
    last24h: { filledUsd: 95, paidUsd: 68.4, feesUsd: 1.71, fills: 4 },
    feeBps: CFG.feeBps,
    generatedAt: now(),
  };
};

export const mockCreateListing = async (input: { amountUsd: number; discountBps: number }): Promise<CreatedListing> => {
  await sleep(400);
  const micros = Math.round(input.amountUsd * 1e6);
  if (input.amountUsd < CFG.minListingUsd) throw new ApiError(400, `listings start at $${CFG.minListingUsd}`, 'below_minimum');
  if (input.discountBps > CFG.maxDiscountBps) throw new ApiError(400, `the deepest discount allowed is ${CFG.maxDiscountBps / 100}%`, 'discount_too_deep');
  if (mockAccount.balanceMicros < micros) throw new ApiError(402, `spendable balance is $${(mockAccount.balanceMicros / 1e6).toFixed(2)}; cannot list $${input.amountUsd.toFixed(2)}`, 'insufficient_credits');
  const l = seedListing(ME, r6(input.amountUsd), input.discountBps, 0);
  mockAccount.adjust(-micros, 'market_escrow', `listing:${l.id}`);
  const q = quoteLocal(l.amountUsd, l.discountBps);
  return { ...l, ifFullySold: { buyerPaysUsd: q.buyerPaysUsd, feeUsd: q.feeUsd, youReceiveUsd: q.sellerReceivesUsd } };
};

export const mockCancelListing = async (lid: string): Promise<Listing> => {
  await sleep(300);
  const l = listings.find((x) => x.id === lid && x.seller === ME);
  if (!l) throw new ApiError(404, 'no such listing for this wallet', 'not_found');
  if (l.status !== 'open') return l;
  l.status = 'cancelled';
  l.closed_at = now();
  if (l.remainingUsd > 0) mockAccount.adjust(Math.round(l.remainingUsd * 1e6), 'market_refund', `listing:${l.id}:cancelled`);
  l.remainingUsd = 0;
  return l;
};

export const mockFill = async (input: { listingId: string; amountUsd: number }): Promise<FillResult> => {
  await sleep(450);
  reap();
  const l = listings.find((x) => x.id === input.listingId);
  if (!l) throw new ApiError(404, 'no such listing', 'not_found');
  if (l.status !== 'open') throw new ApiError(409, 'this listing is no longer open', 'listing_closed');
  if (l.seller === ME) throw new ApiError(409, 'you cannot buy your own listing; cancel it instead', 'own_listing');
  const amt = r6(input.amountUsd);
  if (amt > l.remainingUsd + 1e-9) throw new ApiError(409, `only $${l.remainingUsd.toFixed(2)} of this listing is left`, 'insufficient_depth');
  if (amt < CFG.minFillUsd && Math.abs(amt - l.remainingUsd) > 1e-9) throw new ApiError(400, 'buys start at $0.01 (or the whole remainder)', 'below_minimum');
  const q = quoteLocal(amt, l.discountBps);
  const bal = prepaidBalance();
  if (bal + 1e-9 < q.buyerPaysUsd) throw new ApiError(402, `prepaid balance is $${bal.toFixed(2)}; this buy costs $${q.buyerPaysUsd.toFixed(2)}`, 'insufficient_prepaid');
  const f: Fill = {
    id: id('fill'),
    listingId: l.id,
    buyer: ME,
    seller: l.seller,
    creditsUsd: amt,
    paidUsd: q.buyerPaysUsd,
    feeUsd: q.feeUsd,
    feeToHoldersUsd: q.feeToHoldersUsd,
    feeToTreasuryUsd: q.feeToTreasuryUsd,
    sellerReceivedUsd: q.sellerReceivesUsd,
    discountBps: l.discountBps,
    settlement: 'prepaid',
    settlementRef: null,
    created_at: now(),
  };
  fills.unshift(f);
  l.remainingUsd = r6(l.remainingUsd - amt);
  l.soldUsd = r6(l.soldUsd + amt);
  if (l.remainingUsd <= 0) {
    l.status = 'filled';
    l.closed_at = now();
  }
  prepaidAdd('market_buy', -q.buyerPaysUsd, `fill:${f.id}`);
  mockAccount.adjust(Math.round(amt * 1e6), 'market_buy', `fill:${f.id}`);
  stats.filledUsd += amt;
  stats.paidUsd += q.buyerPaysUsd;
  stats.feesUsd += q.feeUsd;
  stats.fills += 1;
  stats.weightedBps += amt * l.discountBps;
  return { ...f, creditBalanceUsd: mockAccount.balanceMicros / 1e6, prepaidBalanceUsd: prepaidBalance() };
};

export const mockMyMarket = async (): Promise<MyMarket> => {
  await sleep(250);
  reap();
  return {
    wallet: ME,
    creditBalanceUsd: mockAccount.balanceMicros / 1e6,
    prepaid: { usd: prepaidBalance(), usdMicros: Math.round(prepaidBalance() * 1e6), ledger: prepaidLedger.slice(0, 20) },
    listings: listings.filter((l) => l.seller === ME).sort((a, b) => b.created_at - a.created_at),
    fills: { asBuyer: fills.filter((f) => f.buyer === ME), asSeller: fills.filter((f) => f.seller === ME) },
    withdrawals: [...withdrawals].sort((a, b) => b.created_at - a.created_at),
    config: CFG,
  };
};

export const mockWithdraw = async (amountUsd: number): Promise<Withdrawal & { prepaidBalanceUsd: number }> => {
  await sleep(350);
  const amt = r6(amountUsd);
  const bal = prepaidBalance();
  if (amt <= 0) throw new ApiError(400, 'amount must be a positive number of USD', 'bad_amount');
  if (bal + 1e-9 < amt) throw new ApiError(402, `prepaid balance is $${bal.toFixed(2)}; cannot withdraw $${amt.toFixed(2)}`, 'insufficient_prepaid');
  const w: Withdrawal = { id: withdrawals.length + 1, wallet: ME, amountUsd: amt, status: 'pending', note: null, txRef: null, created_at: now(), paid_at: null };
  withdrawals.push(w);
  prepaidAdd('withdrawal', -amt, `withdrawal:${w.id}`);
  return { ...w, prepaidBalanceUsd: prepaidBalance() };
};

export const mockDeposit = async (txHash: string) => ({ ok: true as const, creditedUsd: 25, token: 'USDC', blockNumber: 1_234_567, prepaid: { usd: 25 }, txHash });
