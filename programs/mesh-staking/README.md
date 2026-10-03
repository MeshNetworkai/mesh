# mesh-staking (Solana / Anchor) — skeleton

Solana twin of `contracts/evm/src/MeshStaking.sol`: a position registry for $MESH staking tiers.
It holds tokens in a PDA-owned vault, records `{amount, lock_days, lock_ends_at}` per wallet and
pays no rewards. The gateway reads positions once per epoch and applies the tier off-chain
(reward multiplier + routing priority). Design, PDA layout and instruction list: `docs/STAKING.md`.

## Status

**Type-checked, not built or tested on-chain.** `cargo check` passes against anchor-lang /
anchor-spl 0.30.1 (host target), but no Solana / Anchor CLI (`solana`, `anchor`, `cargo build-sbf`)
is available in the environment this was written in, so:

- `src/lib.rs` is complete as a first version: accounts, PDAs, state, events, errors, tier math and
  both Token-2022 `transfer_checked` CPIs mirror the EVM contract. It has not run on a validator.
- `declare_id!` is a placeholder. Run `anchor keys sync` after the first build.
- No `tests/` yet; mirror `contracts/evm/test/MeshStaking.t.sol` (17 cases) in TypeScript.
- The gateway's `SolanaAdapter.getStakes` throws `NotWiredError` until a program id is added to
  `config/deploy.<network>.json` (`staking`), so Solana wallets sit on the base tier meanwhile.

## Build (when a toolchain is present)

```sh
# Solana 1.18+, Anchor 0.30.1
cd programs/mesh-staking
anchor build
anchor keys sync          # writes the real program id into lib.rs + Anchor.toml
anchor test               # tests/ to be added alongside the CPI implementation
```

## Finishing the implementation

1. Build + deploy to devnet, `anchor keys sync`, write the program id into
   `config/deploy.devnet.json` as `staking`.
2. Tests mirroring `contracts/evm/test/MeshStaking.t.sol` (17 cases), including a transfer-fee
   mint so the vault-delta crediting is exercised.
3. `packages/chain-adapter/src/solana.ts`: replace the `NotWiredError` in `getStakes` with a
   `getMultipleAccounts` read of `["position", config, wallet]` PDAs and decode `Position`
   (Anchor discriminator + borsh: owner 32, amount u64, lock_days u32, lock_ends_at i64, bump u8).
4. Consider `withdraw_withheld` handling if the vault accumulates withheld fees under Token-2022.
