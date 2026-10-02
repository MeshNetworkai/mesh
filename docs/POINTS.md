# Mesh points (pre-launch)

Points are the pre-launch loyalty ledger. They accrue in the gateway for the things that make the
network work (holding, using, serving, bringing people in) and convert to MESH at the token
generation event. They are chain-agnostic: nothing on a chain is touched until TGE.

**Conversion note.** The conversion ratio is set at TGE. Points are not a promise of any amount
of MESH, of a listing, or of a date. The programme can be paused, re-rated or ended by config.

## How points are earned

Rates live in `config/tokenomics.json` under `points` (schema and defaults in
`packages/config/src/index.ts`):

| Config               | Default | Earns                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------- |
| `perUsdCredits`      | 100     | points per $1 of credits **received** from an hourly distribution                      |
| `perUsdSpent`        | 50      | points per $1 of credits **spent** on `/v1` requests                                   |
| `perNodeTokenK`      | 1       | points per 1,000 tokens **served** by a wallet's nodes (completed jobs only)            |
| `perReferralSignup`  | 500     | points to the referrer when a wallet claims their code                                 |
| `referralShareBps`   | 1000    | 10% of a referee's *future* earned points (credits, usage, node) also go to the referrer |
| `dailyCapPerWallet`  | 50000   | most points a wallet can earn per UTC day across all kinds (0 = no cap)                |
| `enabled`            | true    | off: nothing is written, every endpoint still answers                                  |

Starter credits (admin gifts) earn nothing. Admin adjustments earn or remove points outside the
cap. Points keep three decimals so a $0.001 request still counts (0.05 pts); the UI shows whole
points.

## How it works

- `points_ledger (wallet, kind, points, ref, created_at)` is append-only. `(wallet, kind, ref)` is
  unique, so every source row is awarded exactly once. `points_balances` is a view over it.
- `syncPoints` (`apps/gateway/src/points.ts`) scans `credits_ledger` and `node_rewards` from a
  per-source cursor (`points_sync`) and awards `credit:<id>`, `usage:<id>`, `node:<id>` rows
  stamped with the source row's own time. It runs after each distribution and request, and
  lazily before any points read, so points never lag money by more than one read. Replays are
  no-ops.
- The daily cap is applied at award time: an award is clamped to what is left of the wallet's
  cap for the UTC day of the source row. A fully clamped award still writes a 0-point row so the
  ref is spent and cannot be re-awarded later.
- Referral share is computed from the **credited** (post-cap) amount and is itself subject to
  the referrer's cap. Shares do not chain: A refers B, B refers C; C's points share to B only.

### Endpoints

| Method | Path                       | Auth    | What                                                                         |
| ------ | -------------------------- | ------- | ---------------------------------------------------------------------------- |
| GET    | `/points/rules`            | public  | the live rates and the conversion note                                       |
| GET    | `/me/points`               | session | balance, 24h delta, today vs cap, split by kind, rank, last 20 rows          |
| GET    | `/me/referral`             | session | `{code, link, referred, pointsEarned, referredBy}`                           |
| POST   | `/referrals/claim`         | session | `{code}` once per wallet; errors are typed (below)                           |
| GET    | `/leaderboard/:board`      | public  | `holders`, `nodes`, `points`, `referrers`; `?limit=1..100`; cached 30 s     |
| POST   | `/admin/points/adjust`     | admin   | `{wallet, points, note, ref?}`; audited in `admin_actions` as `points-adjust` |

Leaderboards truncate wallets (`9xQe…Hn4k`) for everyone. When the request carries a session
the response adds `me: {rank, wallet, value}` for the caller (rank `null` when not on the board).
Boards: holders by credits earned from distributions, nodes by tokens served, points by balance,
referrers by wallets referred (secondary: referral points earned).

## Referrals

Every wallet has one 6-character code (`A–Z` and `2–9`, no `0/O/1/I`), minted on first request
of `/me/referral`. The share link is `<web origin>/?ref=CODE`; the landing page stores the code
and the dashboard offers to claim it once the wallet is signed in.

A claim is rejected when:

| `error`              | HTTP | Why                                                          |
| -------------------- | ---- | ------------------------------------------------------------ |
| `invalid_code`       | 400  | not 6 characters from the alphabet                           |
| `unknown_code`       | 404  | no wallet owns it                                            |
| `self_referral`      | 400  | the caller's own code                                        |
| `already_referred`   | 409  | the wallet already claimed a code (one referrer, forever)    |
| `circular_referral`  | 400  | the code's owner was referred by the caller (A→B then B→A)   |
| `disabled`           | 403  | `points.enabled` is false                                    |

## Anti-abuse

- **Daily cap.** `dailyCapPerWallet` bounds what any wallet can earn per UTC day, whatever the
  mix of kinds. Shares count toward the referrer's cap.
- **Self-referral** is refused, as is the two-wallet loop. A wallet can be referred once.
- **Sybil note.** Points are per wallet, and wallets are cheap. Points scale with money actually
  moved (credits received or spent, tokens actually served), not with signups, so splitting a
  holding across wallets does not mint points; it only splits them. The referral signup bonus
  is the one flat reward, which is why it is modest and capped by the daily limit. Clusters that
  still look engineered can be adjusted (`/admin/points/adjust` with a note) and the action is
  on the audit trail. Expect a review of the top of every board before conversion.
- **Rate limits.** `/referrals/claim` is limited to 20/min per IP; leaderboards are served from
  a 30 s cache.
- **No chain, no claims.** Nothing here mints, promises or prices a token. The conversion ratio
  and eligibility rules are set at TGE and may exclude wallets flagged for abuse.

## Where it shows up

- Dashboard: **Points** tile (24h delta, rank, "how to earn" tooltip) and the **Refer a wallet**
  card (code, copy link, referred count, points, claim form).
- `/leaderboard`: four tabs, public, with the caller's own rank when signed in.
- Landing: the Hold row carries "Earn points before launch; they convert to MESH."
