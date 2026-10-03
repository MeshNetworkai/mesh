# Staking ($MESH tiers)

Stake MESH to reach a tier. A tier does two things, both applied **off-chain by the gateway**:

1. **Node rewards × multiplier.** Every job a node serves accrues `usdPerMTokens × tokens × tier.multiplier`
   to the node's reward wallet (`apps/gateway/src/routes/v1.ts`).
2. **Routing priority.** When several idle nodes can serve a model, candidates are ordered by the
   reward wallet's tier first, then reputation, then recency (`apps/gateway/src/routing.ts`).

The contracts hold tokens and record positions. They pay nothing, so there is no reward token to
drain, no emission schedule and no oracle on-chain.

## Tiers

Tiers live in `config/tokenomics.json` → `stakeTiers` and are the single source of truth for the
gateway and the web app. The on-chain table should be deployed from the same values (`forge script`
reads them from env, see below) and updated by the owner whenever config changes.

| tier   | minStake (MESH) | lockDays | multiplier |
| ------ | --------------- | -------- | ---------- |
| none   | 0               | –        | 1.0×       |
| silver | 10,000          | –        | 1.5×       |
| gold   | 50,000          | 30       | 2.0×       |

**Rule (identical on EVM, Solana and in the gateway):** a wallet is on the highest tier whose
`minStake <= staked` **and** whose `lockDays <= the lock the wallet committed to`. Holding 60k
without committing to the 30-day lock is silver; committing to the lock (even on a 1-token top-up)
makes it gold. The tier is kept after the lock expires for as long as the tokens stay staked.

## Position model (all chains)

```
Position { amount, lockDays, lockEndsAt }
stake(amount, lockDays):   lockDays == 0 keeps the current commitment, otherwise must be >= it
                           lockEndsAt = max(lockEndsAt, now + lockDays·86400)   # never shortens
unstake(amount):           requires now >= lockEndsAt; amount == 0 afterwards clears the lock
```

## EVM — `contracts/evm/src/MeshStaking.sol`

- `Ownable2Step` owner (multisig) can `setTiers(Tier[])`; positions are untouched and re-evaluate.
- `ReentrancyGuard` on `stake` / `unstake`; SafeERC20; credits the vault delta so a fee-on-transfer
  deployment stays solvent. Deploy sets `MeshToken.setFeeExempt(staking, true)` so stakes do not pay
  the trade fee (only possible while the deployer is still the token owner — otherwise do it from the
  multisig).
- Views: `tierOf(wallet) → (index, Tier)`, `multiplierOf`, `stakedOf`, `lockEndsAt`, `positionOf`,
  `tiers()`, `tierCount`, `totalStaked`.
- Events: `Staked(wallet, amount, total, lockDays, lockEndsAt)`, `Unstaked(wallet, amount, remaining)`,
  `TiersUpdated(count)`.
- Owner can `recoverToken` anything **except** MESH. No path moves staked MESH other than `unstake`.
- Tests: `contracts/evm/test/MeshStaking.t.sol` (17) — `FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test`.

Deploy (optional, `script/Deploy.s.sol`): `MESH_STAKING=true` deploys it after the token and writes
`staking` into `deployments/<chainId>.json`; `scripts/chain/evm-deploy.ts` copies it into
`config/deploy.<network>.json`. Tier env (defaults = tokenomics): `MESH_STAKE_TIER_NAMES`,
`MESH_STAKE_MIN` (whole tokens), `MESH_STAKE_LOCK_DAYS`, `MESH_STAKE_MULTIPLIER_BPS`.

## Solana — Anchor program design (`programs/mesh-staking`)

Status: `cargo check` passes; **not built to SBF or run on a validator** here (no Solana/Anchor CLI
in this environment). Program id is a placeholder until `anchor keys sync`. See its README.

### Accounts

| account       | PDA seeds                              | contents                                                              |
| ------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `StakeConfig` | `["config", mint]`                     | authority, mint, vault, total_staked, `tiers: Vec<Tier>` (≤ 8), bump  |
| vault         | `["vault", config]` (token account)    | Token-2022 account for `mint`, authority = config PDA                 |
| `Position`    | `["position", config, owner]`          | owner, amount (u64), lock_days (u32), lock_ends_at (i64), bump        |

`Tier { name: [u8;16], min_stake: u64 (raw units), lock_days: u32, multiplier_bps: u32 }`.

### Instructions

| ix               | signer    | effect                                                                                                   |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `initialize`     | authority | create config + vault, validate + store tiers                                                            |
| `set_tiers`      | authority | replace the tier table (same validation as EVM: first tier 0/0, strictly ascending, multiplier > 0)      |
| `stake`          | staker    | `transfer_checked(staker_ata → vault)`, credit vault delta, update lock as above; `init_if_needed` Position |
| `unstake`        | staker    | require `now >= lock_ends_at`, debit, `transfer_checked(vault → staker_ata)` signed by config PDA         |
| `close_position` | staker    | close an empty Position, refund rent                                                                     |

Events `Staked`, `Unstaked`, `TiersUpdated` mirror the EVM ones. Errors mirror the Solidity custom
errors (`ZeroAmount`, `LockTooLong`, `LockShorterThanCommitted`, `StillLocked`, `InsufficientStake`,
tier validation errors).

Reading positions from the gateway: derive `["position", config, wallet]` for each wallet,
`getMultipleAccounts`, decode (8-byte discriminator + borsh). Until that lands,
`SolanaAdapter.getStakes` throws `NotWiredError` and every Solana wallet is on the base tier.

## ChainAdapter

```ts
interface StakeInfo { wallet; staked /* token units */; lockEndsAt?; lockDays? }
ChainAdapter.getStakes?(wallets: string[]): Promise<StakeInfo[]>   // optional, same order
hasStaking(adapter)                                                 // type guard
```

- `MockAdapter`: `DEFAULT_MOCK_STAKES` (alice gold/locked, bob silver), `setStake(wallet, staked, {lockDays})`.
- `EvmAdapter`: reads `MeshStaking.positionOf` when the deploy json has `staking`; the staking
  contract is also added to the holder exclusions (staked tokens are not "held" for distribution).
  Without `staking` → `NotWiredError`.
- `SolanaAdapter`: `NotWiredError` (see above).

## Gateway

`apps/gateway/src/staking.ts` — `StakeResolver`:

- `resolve(wallet)` / `resolveMany(wallets)` read positions through the adapter and cache them
  **per epoch** (`epochSeconds`), so a tier is stable within an epoch and costs one read per wallet
  per epoch. `peek(wallet)` is the sync view for routing (base tier until the first read completes,
  which it kicks off). `NotWiredError`, a missing `getStakes`, or an RPC failure → base tier for the
  epoch (`available: false`), never an error for the request.
- `tierForPosition` / `nextTierFor` implement the tier rule above against `config.stakeTiers`.

Routes (`apps/gateway/src/routes/stake.ts`):

- `GET /stake/tiers` (public) → `{ chain, ticker, tiers:[{name,minStake,lockDays,multiplier}], available, contract, epochSeconds }`
- `GET /me/stake` (session) → `{ wallet, staked, tier, tierIndex, multiplier, lockDays, lockEndsAt, nextTier:{…, needStake}|null, available, contract, epoch }`

Tests: `apps/gateway/test/staking.test.ts` (tier rules, resolver cache + fallbacks, routes, reward
multiplier end-to-end through a fake node, routing order).

## Web — `/app/stake`

`apps/web/src/pages/Stake.tsx`: tiles (your tier, staked, multiplier, lock end), the tiers table with
your row marked, and the stake / unstake panels.

- The build discovers `config/deploy.*.json` (`import.meta.glob`); when one is EVM, not simulated and
  has `staking`, `STAKING_TARGET` is set and the panels drive the contract through wagmi
  (approve → stake with the chosen lock; unstake disabled while locked). The staking chain is added
  to the wagmi config so the wallet can switch to it.
- Without a deploy json the page shows the "opens with the token launch" state, and the landing
  "Stake" row keeps saying **Week 2**.
- `VITE_MOCK=1` shows a gold example position (62,500 MESH, 18 days of lock left).

## Operations

- Tier changes: edit `tokenomics.json`, then `setTiers` on-chain from the owner so both agree. The
  gateway re-evaluates at the next epoch; `StakeResolver.clear()` forces it.
- Rewards are paid from the treasury share exactly as before — the multiplier only scales the accrual,
  so budget for the average multiplier when setting `nodeRewards.usdPerMTokens`.
