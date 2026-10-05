# contracts/evm — Foundry project

Decision (the internal docs repo): the $MESH token is launched on **Robinhood Chain via Pons**
(the launchpad mints a plain ERC-20 and routes creator fees through its Fee Escrow). This repo
therefore does **not** deploy a token. What it deploys is the fee plumbing on our side.

| Contract | Status with a Pons launch |
| --- | --- |
| `src/PonsFeeVault.sol` | **Used.** Set as Pons `creatorFeeRecipient`. `pull()` claims from the Pons escrow, `sweep()` converts to the stable and splits holder / treasury, `sweepRaw()` forwards unswapped. Owner = multisig, `sweeper` = gateway hot wallet. Pausable, Ownable2Step. |
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
export MESH_CREDIT_POOL=0x...  # gateway pool wallet (we give you this)
export MESH_TREASURY=0x...     # treasury multisig
export MESH_OWNER=0x...        # vault owner multisig (Ownable2Step: it must acceptOwnership() after)
# optional: MESH_STABLE, MESH_WETH, MESH_SWAP_ROUTER, MESH_POOL_FEE, MESH_QUOTE_TOKENS, MESH_HOLDER_BPS, MESH_PONS_ESCROW
forge script script/DeployPonsFeeVault.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $MESH_EVM_PRIVATE_KEY --broadcast
```

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
