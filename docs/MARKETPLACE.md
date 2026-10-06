# Credit marketplace

Holders who will not use their credits sell them at a discount; anyone buys them below face value and spends them on any model. Mesh keeps 2.5% of every sale, half of it back to holders. (The competing order book charges 5%.)

Code: `apps/gateway/src/market.ts` (mechanics), `apps/gateway/src/routes/market.ts` (API), `apps/web/src/pages/Market.tsx` (UI), config block `marketplace` in `config/tokenomics.json`, tables in migration 14 (`apps/gateway/src/db.ts`), tests in `apps/gateway/test/market.test.ts`.

## How a trade works

1. **List.** A seller offers `amount` of credit at `discount` (0–70%). The credit leaves their spendable balance at once: a `market_escrow` row in `credits_ledger` (negative), so the gateway will not serve requests against it. The listing stays open for 7 days (`listingTtlHours`).
2. **Fill.** A buyer takes any part of a listing (down to $0.01, or the whole remainder). They pay the discounted price from their **prepaid balance**; the credits land in their `credits_ledger` at face value (`market_buy`). The seller is paid into their own prepaid balance, net of the fee. Partial fills leave the listing open; the last fill marks it `filled`.
3. **Cancel or expire.** Whatever is left goes back to the seller's spendable balance (`market_refund`). An expiry sweep runs once a minute and on every read of the book.
4. **Withdraw.** Prepaid USD can be withdrawn. The amount leaves the balance when the request is made; an operator pays it out (USDC to the wallet) and marks the request paid.

## Fee math

All amounts are integer micro-USD; every step floors, and the pieces always add up exactly.

```
pricePerUsd = 1e6 − bps(1e6, discount)          stored on the listing
paid        = credits − bps(credits, discount)   what the buyer pays
fee         = bps(paid, feeBps)                  2.5% of the price, paid by the seller
toHolders   = bps(fee, feeToHoldersBps)          half of the fee
toTreasury  = fee − toHolders                    the other half
seller      = paid − fee
```

Example, $100 of credit at 30% off: the buyer pays $70.00 and receives $100 of credit; the fee is $1.75; the seller receives $68.25; $0.875 goes to holders and $0.875 to the treasury.

Where the fee goes:

- **Holders' half** is written to `pool_extra_micros`. The next hourly epoch (`jobs/distribute.ts`) adds everything pending there to the holder pool, distributes it pro-rata like trading fees, and stamps the rows with the epoch so nothing is paid twice. If an epoch has no eligible holder the money waits for the next one.
- **Treasury half** is a `market_fee` row in `treasury_ledger`, visible in `/report` under `totals.treasury.marketFeeUsd`.

## Prepaid balance (settlement)

Buyers pay from a prepaid USD balance (`prepaid_ledger`), which during the beta is topped up by the team after an off-chain or hand-sent USDC payment: `POST /admin/prepaid { wallet, amountUsd, note, ref? }`, audited in `admin_actions` with the note; re-posting the same `ref` is a no-op. Sellers' proceeds land in the same balance and leave through `withdrawal_requests`.

Every fill records `settlement = 'prepaid'`. A USDC settlement adapter can be added without a schema change: it credits `prepaid_ledger` (`kind = 'topup'`, `ref = <tx>`) when a transfer lands, or fills directly with `settlement = 'external'` and the tx in `settlement_ref`. Withdrawals would be paid by the same adapter and marked with the payout `tx_ref`.

### Paying in (self-serve deposits)

When `marketplace.deposits` has a `receiver` and at least one token, the Market page shows **Top up** next to the prepaid balance:

1. The buyer sends USDC or USDG on Robinhood Chain **from the wallet they are signed in with** to the receiver address (shown with a Copy button; the minimum is `minUsd`).
2. They paste the transaction hash. `POST /me/market/deposits { txHash }` fetches the receipt over JSON-RPC (`MESH_EVM_RPC_URL`, else the chain's public RPC), decodes the ERC-20 `Transfer` logs and credits the prepaid balance when all of these hold: the transaction succeeded, it is `confirmations` blocks behind the head, a transfer went to the receiver in an accepted token, and its sender is the signed-in wallet. Amounts are converted to micro-USD from the token's decimals.
3. One credit per transaction hash, ever (`market_deposits` is keyed on the hash; the prepaid row carries `ref = deposit:<hash>`). A second paste answers `409 already_credited`; a pending or under-confirmed transfer answers `409 pending` / `409 unconfirmed` with the current count, so the page can simply be retried.

Deposits from a different wallet than the session's are refused (`wrong_sender`) rather than credited to the wrong account; the operator can credit those by hand with `POST /admin/prepaid` after checking the explorer. Withdrawals stay manual during the beta.

## Ledger entries per trade

| Event | credits_ledger | prepaid_ledger | treasury_ledger | pool_extra_micros |
| --- | --- | --- | --- | --- |
| List $A | seller −A `market_escrow` | | | |
| Fill $C of it | buyer +C `market_buy` | buyer −paid `market_buy`, seller +(paid−fee) `market_sale` | +toTreasury `market_fee` | +toHolders |
| Cancel / expire | seller +remaining `market_refund` | | | |
| Withdraw $W | | wallet −W `withdrawal` | | |
| Epoch runs | holders +pool `distribution` | | | rows stamped with `epoch_start` |

Everything is reproducible from these tables; `GET /report` carries `totals.marketplace { listed, filled, paid, fills, feesToHolders, feesToTreasury, openDepth, openListings, bestDiscountBps, avgDiscountBps }`.

## API

Public: `GET /market/config`, `GET /market/book` (depth by discount tier, best discount, total available), `GET /market/listings?limit&offset&discountBps` (open listings, no seller address), `GET /market/stats`, `GET /market/quote?amountUsd&discountBps`.

Session (bearer or cookie + CSRF): `POST /market/listings { amountUsd, discountBps }`, `DELETE /market/listings/:id`, `POST /market/fills { listingId, amountUsd }`, `GET /me/market`, `POST /me/market/withdraw { amountUsd }`.

Admin: `POST /admin/prepaid`, `POST /admin/market/withdrawals/:id/paid { txRef?, note? }`, `GET /admin/market`, `GET /admin/market/listings/:id`, `POST /admin/market/reap`.

Errors are `{ error, message, statusCode }`: `insufficient_credits` (402, listing more than you hold), `insufficient_prepaid` (402), `own_listing`, `listing_closed`, `insufficient_depth` (409), `below_minimum`, `discount_too_deep` (400). Writes are rate-limited to 30 a minute per IP, reads to 120. With `marketplace.enabled: false` every `/market` route is 404.

## Config

```json
"marketplace": { "enabled": true, "feeBps": 250, "feeToHoldersBps": 5000, "minListingUsd": 1, "maxDiscountBps": 7000, "listingTtlHours": 168 }
```
