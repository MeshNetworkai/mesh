# Credit marketplace

Holders who will not use their credits sell them at a discount; anyone buys them below face value and spends them on any model. Mesh keeps 2.5% of every sale, half of it back to holders. (The competing order book charges 5%.) Two rules bound what is sold: unused starter credit cannot be listed, and every credit lapses 90 days after it landed whether it is listed or not. Credits can also be bought from Mesh itself at face value, with the same prepaid balance (`docs/PRICING.md` §7).

Code: `apps/gateway/src/market.ts` (mechanics), `apps/gateway/src/routes/market.ts` (API), `apps/gateway/src/expiry.ts` (the 90-day clock and non-transferable starter credit), `apps/web/src/pages/Market.tsx` (UI), config block `marketplace` in `config/tokenomics.json`, tables in migration 14 and the `purchase` / `expiry` / `credit_purchase` ledger kinds in migration 19 (`apps/gateway/src/db.ts`), tests in `apps/gateway/test/market.test.ts` and `apps/gateway/test/economics.test.ts`.

## What is on chain and what is not

Credits are rows in the gateway's ledger and never go on chain. The only on-chain side of the
marketplace is the stablecoin it settles in, USDG (`marketplace.settlementSymbol`; the token address
goes in `marketplace.deposits.tokens`): buyers deposit it into a prepaid balance and sellers withdraw
it. Sellers are holders with credits they will not use, and node operators, whose rewards are paid in
credits every hour (`docs/NODE_PROTOCOL.md` §7): selling here is how either turns credits into money.

## How a trade works

1. **List.** A seller offers `amount` of credit at `discount` (0–70%). Credit past its 90 days is lapsed first, and unused starter credit is held back (below). The credit then leaves their spendable balance at once: a `market_escrow` row in `credits_ledger` (negative), so the gateway will not serve requests against it. The listing stays open for 7 days (`listingTtlHours`).
2. **Fill.** A buyer takes any part of a listing (down to $0.01, or the whole remainder). They pay the discounted price from their **prepaid balance**; the credits land in their `credits_ledger` at face value (`market_buy`) and start a fresh 90 days there. The seller is paid into their own prepaid balance, net of the fee. Partial fills leave the listing open; the last fill marks it `filled`.
3. **Cancel or expire.** Whatever is left goes back to the seller's spendable balance (`market_refund`) with its original date: the listing did not stop the clock. A sweep of expired listings runs once a minute and on every read of the book.
4. **Withdraw.** Prepaid USD can be withdrawn. The amount leaves the balance when the request is made; an operator pays it out (USDG to the wallet) and marks the request paid.

## What can be listed, and the 90-day clock

Config: `starterCredits.transferable: false` and `creditExpiry { enabled: true, days: 90 }` in `config/tokenomics.json`; rules in `docs/PRICING.md` §6.

- **Starter credit is not sellable.** What is left of a wallet's starter grant can be spent on requests but not listed. Requests spend the starter grant first, so credit a wallet earned or bought stays listable. `POST /market/listings` for more than the listable amount answers `402 non_transferable`; `GET /me/market` shows `nonTransferableUsd` and `listableUsd` (balance − unused starter credit − credit held by requests in flight). `GET /market/config → starterTransferable` tells the page which rule is on.
- **Every credit lapses after 90 days**, including credit bought here. The oldest credit is spent, listed and lapsed first.
- **A listing does not stop the clock.** Credit in an open listing is out of the balance, so it is not debited while it is listed. If it sells, the buyer's 90 days start at the fill. If it comes back (cancel, or the 7-day listing expiry), it comes back with its original date; when that date has already passed it lapses at the next check. Example: $10 lands on day 0 and $6 of it is listed on day 85. On day 90 the $4 still in the wallet lapses. Nobody buys, the listing expires on day 92, and the $6 returns already past its date: it lapses at the next check.
- **When lapsed credit is removed.** After every hourly epoch for all wallets, and for the wallet itself on `POST /market/listings` and `GET /me/market` (also on `GET /me` and on every chat request), so a balance past its date can never be listed.

Credit escrowed in open listings is still owed to someone, so the published reserve counts it: `GET /report → totals.reserve.creditsInEscrowUsd` (`docs/PRICING.md` §5).

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

Buyers pay from a prepaid USD balance (`prepaid_ledger`), which during the beta is topped up by the team after an off-chain or hand-sent USDG payment: `POST /admin/prepaid { wallet, amountUsd, note, ref? }`, audited in `admin_actions` with the note; re-posting the same `ref` is a no-op. Sellers' proceeds land in the same balance and leave through `withdrawal_requests`.

### Paying out (withdrawals)

A withdrawal is paid by hand, so the gateway makes sure somebody hears about it
(`apps/gateway/src/alerts.ts`, `routes/market.ts`):

1. `POST /me/market/withdraw` debits the prepaid balance, writes a `pending` row in
   `withdrawal_requests` and announces it at once on the alert channel:
   `[mesh] WITHDRAWAL requested #<id>: $<amount> to <wallet>`, with how many requests are waiting and
   their total. One message per request. `notified_at` (migration 20) is stamped when it has been
   sent; if the send fails, the next alert check (every `ALERT_CHECK_INTERVAL_MS`, 60 s) tries again.
2. The daily digest carries a `withdrawals:` line: how many are waiting, their total, how long the
   oldest has waited, and what was requested and paid in the last 24 hours.
3. The operator opens **Admin → Withdrawals** (`/admin`, data from `GET /admin/market`): the queue,
   oldest first, with the wallet to pay, the amount and how long it has waited. They send the
   stablecoin from the treasury wallet themselves, paste the transaction hash and press **Mark paid**
   (`POST /admin/market/withdrawals/:id/paid { txRef }`, audited as `withdrawal-paid`). The user then
   sees the request as paid. The page and the gateway never move money.

The channel is Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. Without them the
message only goes to the gateway log, and with `ALERTS_ENABLED=false` nothing is announced at all;
`GET /admin/market → withdrawals.announcedVia` (`telegram`, `log` or `null`) says which, and the admin
panel repeats it.

The same balance pays for credits bought directly from Mesh at face value (`POST /me/credits/buy`, `prepaid_ledger` kind `credit_purchase`; `docs/PRICING.md` §7). A direct purchase has no seller, no discount and no fee: $1 of prepaid buys $1 of credit.

Every fill records `settlement = 'prepaid'`. A USDG settlement adapter can be added without a schema change: it credits `prepaid_ledger` (`kind = 'topup'`, `ref = <tx>`) when a transfer lands, or fills directly with `settlement = 'external'` and the tx in `settlement_ref`. Withdrawals would be paid by the same adapter and marked with the payout `tx_ref`.

### Paying in (self-serve deposits)

When `marketplace.deposits` has a `receiver` and at least one token, the Market page shows **Top up** next to the prepaid balance:

1. The buyer sends USDG on Robinhood Chain **from the wallet they are signed in with** to the receiver address (shown with a Copy button; the minimum is `minUsd`).
2. They paste the transaction hash. `POST /me/market/deposits { txHash }` fetches the receipt over JSON-RPC (`MESH_EVM_RPC_URL`, else the chain's public RPC), decodes the ERC-20 `Transfer` logs and credits the prepaid balance when all of these hold: the transaction succeeded, it is `confirmations` blocks behind the head, a transfer went to the receiver in an accepted token, and its sender is the signed-in wallet. Amounts are converted to micro-USD from the token's decimals.
3. One credit per transaction hash, ever (`market_deposits` is keyed on the hash; the prepaid row carries `ref = deposit:<hash>`). A second paste answers `409 already_credited`; a pending or under-confirmed transfer answers `409 pending` / `409 unconfirmed` with the current count, so the page can simply be retried.

Deposits from a different wallet than the session's are refused (`wrong_sender`) rather than credited to the wrong account; the operator can credit those by hand with `POST /admin/prepaid` after checking the explorer. Withdrawals stay manual during the beta.

## Ledger entries per trade

| Event | credits_ledger | prepaid_ledger | treasury_ledger | pool_extra_micros |
| --- | --- | --- | --- | --- |
| List $A | seller −A `market_escrow` | | | |
| Fill $C of it | buyer +C `market_buy` | buyer −paid `market_buy`, seller +(paid−fee) `market_sale` | +toTreasury `market_fee` | +toHolders |
| Cancel / expire | seller +remaining `market_refund` (keeps its original date) | | | |
| Withdraw $W | | wallet −W `withdrawal` | | |
| Epoch runs | holders +pool `distribution` | | | rows stamped with `epoch_start` |
| Buy $B from Mesh (not a trade; `docs/PRICING.md` §7) | buyer +B `purchase` | buyer −B `credit_purchase` | | |
| Credit lapses after 90 days | wallet −lapsed `expiry` | | | |

Everything is reproducible from these tables; `GET /report` carries `totals.marketplace { listed, filled, paid, fills, feesToHolders, feesToTreasury, openDepth, openListings, bestDiscountBps, avgDiscountBps }`.

## API

Public: `GET /market/config` (fee, limits, deposits, plus `starterTransferable` and `creditExpiryDays`), `GET /market/book` (depth by discount tier, best discount, total available), `GET /market/listings?limit&offset&discountBps` (open listings, no seller address), `GET /market/stats`, `GET /market/quote?amountUsd&discountBps`.

Session (bearer or cookie + CSRF): `POST /market/listings { amountUsd, discountBps }`, `DELETE /market/listings/:id`, `POST /market/fills { listingId, amountUsd }`, `GET /me/market` (credit balance, `nonTransferableUsd`, `listableUsd`, prepaid balance and ledger, listings, fills), `POST /me/market/withdraw { amountUsd }`.

Admin: `POST /admin/prepaid`, `POST /admin/market/withdrawals/:id/paid { txRef?, note? }`, `GET /admin/market` (`withdrawals { pendingUsd, paidUsd, pending[] with notified_at, recentPaid[], announcedVia }`), `GET /admin/market/listings/:id`, `POST /admin/market/reap`.

Errors are `{ error, message, statusCode }`: `insufficient_credits` (402, listing more than you hold), `non_transferable` (402, the balance covers the listing only by counting unused starter credit), `insufficient_prepaid` (402), `own_listing`, `listing_closed`, `insufficient_depth` (409), `below_minimum`, `discount_too_deep` (400). Writes are rate-limited to 30 a minute per IP, reads to 120. With `marketplace.enabled: false` every `/market` route is 404.

## Config

```json
"marketplace": { "enabled": true, "feeBps": 250, "feeToHoldersBps": 5000, "minListingUsd": 1, "maxDiscountBps": 7000, "listingTtlHours": 168 }
```
