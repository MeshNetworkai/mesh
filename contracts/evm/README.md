# contracts/evm — Foundry project

Decision (the internal docs repo): the $MESH token is launched on **Robinhood Chain via Pons**
(the launchpad mints a plain ERC-20 and routes creator fees through its Fee Escrow). This repo
therefore does **not** deploy a token. What it deploys is the fee plumbing on our side.

| Contract | Status with a Pons launch |
| --- | --- |
| `src/PonsFeeVault.sol` | **Used.** Set as Pons `creatorFeeRecipient`. `pull()` claims from the Pons escrow, `sweep()` converts to the stable and splits holder / treasury, `sweepRaw()` forwards unswapped. Production calls `sweep()` only (see "Which sweep the gateway calls"). Owner = multisig, `sweeper` = gateway hot wallet. Pausable, Ownable2Step. |
| `src/interfaces/IPonsFeeEscrow.sol` | **Used.** The escrow surface we call (selectors from the Pons v2 docs — verify on Blockscout before mainnet). |
| `src/interfaces/IMeshSwapAdapter.sol` | **Used** when the stable route is not a Uniswap v3 SwapRouter02 (e.g. v4 universal router): a tiny adapter implements one `swap()`. |
| `src/MeshStaking.sol` | Optional, chain-agnostic: stakes any ERC-20, so it works with the Pons-minted token. Deploy later if staking launches. |
| `src/MeshToken.sol` | **Not used with a Pons launch.** Kept as the self-deploy fallback (fee-on-transfer ERC-20). |
| `src/FeeVault.sol` | **Not used with a Pons launch** (it collects MeshToken's transfer fee). Kept with MeshToken. |
| `src/TeamLock.sol` | **Not used with a Pons launch** (Pons locks the curve/pool itself via its LaunchLocker; a team allocation, if any, is handled on the Pons side). Kept with MeshToken. |

## Build / test

```sh
pnpm install                       # pulls @openzeppelin/contracts + solc via npm
forge build && forge test          # 56 tests (34 MeshToken/FeeVault/TeamLock/MeshStaking + 22 PonsFeeVault)
# without access to binaries.soliditylang.org:
FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test
```

## Deploy PonsFeeVault

```sh
export MESH_SWEEPER=0x...      # gateway hot wallet (we give you this)
export MESH_CREDIT_POOL=0x...  # credit-pool wallet: the reserve behind credits, separate from the treasury (we give you this)
export MESH_TREASURY=0x...     # treasury multisig
export MESH_OWNER=0x...        # vault owner multisig (Ownable2Step: it must acceptOwnership() after)
# needed before the first production sweep (set here, or later with setStable + setRoute from the owner):
export MESH_STABLE=0x...       # USDG / USDC the vault settles in
export MESH_WETH=0x...         # WETH9 on this chain
export MESH_SWAP_ROUTER=0x...  # Uniswap v3 SwapRouter02; with MESH_POOL_FEE (default 500) sets a V3Single ETH → stable route
# optional: MESH_POOL_FEE, MESH_QUOTE_TOKENS, MESH_HOLDER_BPS, MESH_PONS_ESCROW
forge script script/DeployPonsFeeVault.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $MESH_EVM_PRIVATE_KEY --broadcast
```

The script sets the ETH route only when `MESH_STABLE`, `MESH_WETH` and `MESH_SWAP_ROUTER` are all
given. Without them the vault deploys with no stablecoin and no route, and the owner has to call
`setStable(stable, weth)` and `setRoute(asset, kind, router, fee, path)` before the gateway's first
sweep.

Writes `deployments/pons-<chainId>.json`. The testnet rehearsal (`scripts/chain/robinhood-testnet-rehearsal.ts`)
deploys the same contract together with the mocks in `test/mocks/` (MockPonsEscrow, MockERC20).

## PonsFeeVault interface

```
constructor(InitParams{owner, sweeper, escrow, creditPool, treasury, stable, weth, holderShareBps, quoteTokens[]})
receive()                                              // escrow.claim() pays ETH here
// owner
setSweeper(address) · setRecipients(creditPool, treasury) · setHolderShareBps(uint16)
setStable(stable, weth) · setQuoteTokens(address[]) · setRoute(asset, RouteKind, router, fee, path)
pause() · unpause() · transferFeeRecipient(token, newRecipient) · rescue(asset, to, amount)
// sweeper (or owner)
pull() returns (ethPulled)                             // escrow.claim() + claimToken(q) for each quote token
sweep(asset, minOut) returns (grossIn, holderOut, treasuryOut)    // asset → stable via route, split
sweepRaw(asset)      returns (grossIn, holderOut, treasuryOut)    // no swap, split the asset itself
// views
pendingInEscrow() returns (assets[], amounts[]) · held(asset) · quoteTokens() · routeOf(asset)
escrow() · sweeper() · creditPool() · treasury() · stable() · weth() · holderShareBps() · owner() · paused()
// events
Pulled(asset, amount) · Swept(asset, grossIn, holderOut, treasuryOut) · SweptRaw(asset, grossIn, holderOut, treasuryOut)
```

`asset == address(0)` is native ETH. `RouteKind`: `None` (sweepRaw only), `V3Single` (SwapRouter02
`exactInputSingle`, ETH goes in as msg.value with `tokenIn = weth`), `V3Path` (`exactInput(path)`),
`Adapter` (`IMeshSwapAdapter.swap`).

## Which sweep the gateway calls

The contract offers both `sweep()` and `sweepRaw()`, and it was not changed when the gateway moved to
stablecoin settlement: `sweepRaw()` still exists on chain and the sweeper role may call it. The
swap-only policy lives off chain, in the gateway:

- `config/deploy.robinhood.json` ships `sweepMode: "swap"`, and `PonsEvmAdapter` then calls
  `sweep(asset, minOut)` only. The holder share reaches `creditPool` in the stablecoin and backs the
  USD credits the gateway mints 1:1 (`docs/PRICING.md` §5).
- `sweepMode: "raw"` (`sweepRaw()`) is kept for the testnet rehearsal
  (`config/deploy.robinhood-testnet.json`), where no stable route exists. The admin Check
  (`packages/chain-adapter/src/pons-check.ts`) warns when it is set.
- `sweep()` reverts with `StableNotSet` when the vault has no stablecoin, with `NoRoute(asset)` when
  the asset has no route, and with `Slippage(out, minOut)` when the swap returns less than the floor
  the adapter computed from the Chainlink ETH/USD feed. In each case nothing moves: the fees stay in
  the vault and the gateway mints nothing.
- When the feed is stale or unreadable the adapter does not call `sweep()` for ETH at all; the fees
  wait in the Pons escrow or the vault for a later epoch.

Nothing on chain stops the sweeper key from calling `sweepRaw()`; taking it out would be a contract
change and a redeploy.
