// Integer fee math shared by the live client and the mock (mirrors apps/gateway/src/market.ts `quote`).

export interface MarketQuote {
  creditsUsd: number;
  discountBps: number;
  pricePerUsd: number;
  buyerPaysUsd: number;
  feeUsd: number;
  feeToHoldersUsd: number;
  feeToTreasuryUsd: number;
  sellerReceivesUsd: number;
}

/**
 * Client-side mirror of the gateway's integer fee math (apps/gateway/src/market.ts `quote`), in
 * micro-USD so the live "you receive" matches the server to the cent.
 */
export function quoteLocal(creditsUsd: number, discountBps: number, feeBps = 250, feeToHoldersBps = 5000): MarketQuote {
  const credits = Math.round(creditsUsd * 1e6);
  const bps = (m: number, b: number) => Math.floor((m * b) / 10_000);
  const paid = credits - bps(credits, discountBps);
  const fee = bps(paid, feeBps);
  const holders = bps(fee, feeToHoldersBps);
  return {
    creditsUsd: credits / 1e6,
    discountBps,
    pricePerUsd: (1e6 - bps(1e6, discountBps)) / 1e6,
    buyerPaysUsd: paid / 1e6,
    feeUsd: fee / 1e6,
    feeToHoldersUsd: holders / 1e6,
    feeToTreasuryUsd: (fee - holders) / 1e6,
    sellerReceivesUsd: (paid - fee) / 1e6,
  };
}

export const fmtDiscount = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
