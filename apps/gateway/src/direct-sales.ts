// Direct credit sales (docs/PRICING.md §7, config `directSales`).
//
// A wallet buys credits from Mesh at face value with its prepaid USD balance (the same balance the credit
// marketplace settles in, funded by a stablecoin deposit). $1 paid is $1 of credit: the payment backs the
// credit in the reserve, and Mesh earns its margin when the credit is spent, like on any other credit.
// This is the income that does not depend on the token trading: usage can grow past what fees mint.
import type { TokenomicsConfig } from '@mesh/config';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addLedgerEntry, ensureWallet } from './ledger.js';
import { addPrepaidEntry, MarketError, prepaidBalanceMicros } from './market.js';
import { MICROS } from './money.js';

export type DirectSalesConfig = TokenomicsConfig['directSales'];

export interface Purchase {
  id: string;
  wallet: string;
  creditsMicros: number;
  paidMicros: number;
  createdAt: number;
}

const usdStr = (micros: number) => (micros / MICROS).toFixed(2);

/**
 * Buy `amountMicros` of credit at face value from the wallet's prepaid balance. One transaction: the
 * prepaid balance pays (`credit_purchase`), the credits land (`purchase`), both rows share the ref.
 */
export function buyCredits(db: Db, cfg: DirectSalesConfig, input: { wallet: string; chain: string; amountMicros: number }, now = nowSec()): Purchase {
  const { wallet, amountMicros } = input;
  if (!cfg.enabled) throw new MarketError(404, 'not_found', 'direct credit sales are disabled');
  if (!Number.isInteger(amountMicros) || amountMicros <= 0) throw new MarketError(400, 'bad_amount', 'amount must be a positive number of USD');
  if (amountMicros < Math.round(cfg.minUsd * MICROS)) throw new MarketError(400, 'below_minimum', `purchases start at $${cfg.minUsd}`);
  if (amountMicros > Math.round(cfg.maxUsd * MICROS)) throw new MarketError(400, 'above_maximum', `one purchase is at most $${cfg.maxUsd}`);
  const tx = db.transaction(() => {
    ensureWallet(db, wallet, input.chain);
    const prepaid = prepaidBalanceMicros(db, wallet);
    if (prepaid < amountMicros) throw new MarketError(402, 'insufficient_prepaid', `prepaid balance is $${usdStr(prepaid)}; this purchase costs $${usdStr(amountMicros)}`);
    const id = `buy_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const ref = `purchase:${id}`;
    addPrepaidEntry(db, { wallet, deltaMicros: -amountMicros, kind: 'credit_purchase', ref }, now);
    addLedgerEntry(db, { wallet, deltaMicros: amountMicros, kind: 'purchase', ref });
    return { id, wallet, creditsMicros: amountMicros, paidMicros: amountMicros, createdAt: now };
  });
  return tx();
}

/** Credits sold directly so far (GET /report `totals.directSales`). */
export function directSalesTotals(db: Db, sinceSec = 0): { soldMicros: number; purchases: number; wallets: number } {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta_usd_micros), 0) AS v, COUNT(*) AS n, COUNT(DISTINCT wallet) AS w FROM credits_ledger WHERE kind = 'purchase' AND created_at >= ?`)
    .get(sinceSec) as { v: number; n: number; w: number };
  return { soldMicros: row.v, purchases: row.n, wallets: row.w };
}
