#!/usr/bin/env tsx
/**
 * Devnet smoke test for the Solana fee path, end to end, with throwaway keys:
 *   airdrop → create Token-2022 mint with 1.5% transfer fee → mint to A → A transfers to B
 *   (fee withheld in B's account) → SolanaAdapter.withheld() sees it → harvest via
 *   withdrawWithheldTokensFromAccounts → balances via getProgramAccounts fallback.
 *
 *   pnpm --filter @mesh/chain-adapter solana:smoke
 *
 * Needs network access to api.devnet.solana.com (or MESH_SOLANA_RPC_URL). When the airdrop is
 * rate-limited (very common) the script exits 0 with a clear SKIP message so CI stays green.
 * No Jupiter leg: there is no MESH/USDC route on devnet; collectFees() is exercised on mainnet
 * with --dry-run first (see the internal docs repo).
 */
import {
  Keypair, SystemProgram,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  createTransferCheckedWithFeeInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from '../../packages/chain-adapter/src/solana/sdk.js';
import { jsonRpc } from '../../packages/chain-adapter/src/rpc.js';
import { SolanaAdapter, USDC_DEVNET } from '../../packages/chain-adapter/src/solana.js';
import { requestAirdropWithRetry, sendInstructions } from '../../packages/chain-adapter/src/solana/tx.js';

const rpcUrl = process.env.MESH_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = jsonRpc(rpcUrl, { retries: 2, timeoutMs: 20_000 });
const DEC = 6;
const u = (n: number) => BigInt(n) * 10n ** BigInt(DEC);

async function main() {
  const payer = Keypair.generate();
  const holderB = Keypair.generate();
  console.log(`rpc=${rpcUrl}\npayer=${payer.publicKey.toBase58()}`);
  try {
    await rpc.call('getHealth');
  } catch (err) {
    console.log(`SKIP: devnet RPC unreachable (${err instanceof Error ? err.message : err})`);
    return;
  }
  const funded = await requestAirdropWithRetry(rpc, payer.publicKey, 1e9, 4);
  if (!funded) {
    console.log('SKIP: devnet airdrop rate-limited; fund the payer at https://faucet.solana.com and re-run with MESH_SOLANA_KEYPAIR');
    return;
  }

  // 1. mint with 1.5% transfer fee
  const mint = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await rpc.call<number>('getMinimumBalanceForRentExemption', [mintLen]);
  const ataA = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(mint.publicKey, holderB.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const sig1 = await sendInstructions(
    rpc,
    payer,
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, 150, u(1_000_000), TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DEC, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataA, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataB, holderB.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint.publicKey, ataA, payer.publicKey, u(1_000_000), [], TOKEN_2022_PROGRAM_ID),
    ],
    [mint],
  );
  console.log(`mint ${mint.publicKey.toBase58()} created, 1,000,000 minted to A: ${sig1}`);

  // 2. A → B 10,000 (fee 150)
  const amount = u(10_000);
  const fee = (amount * 150n) / 10_000n;
  const sig2 = await sendInstructions(rpc, payer, [
    createTransferCheckedWithFeeInstruction(ataA, mint.publicKey, ataB, payer.publicKey, amount, DEC, fee, [], TOKEN_2022_PROGRAM_ID),
  ]);
  console.log(`A → B 10,000 (fee ${fee}): ${sig2}`);

  // 3. adapter sees the withheld fee and harvests it
  const adapter = new SolanaAdapter({
    rpc,
    signer: payer,
    mint: mint.publicKey.toBase58(),
    decimals: DEC,
    usdcMint: USDC_DEVNET,
    holderShareBps: 0, // no Jupiter route on devnet: everything to "treasury" (= signer, so no transfer)
  });
  const w = await adapter.withheld();
  console.log(`withheld: total=${w.total} in ${w.accounts.length} account(s)`);
  if (w.total !== fee) throw new Error(`expected withheld ${fee}, got ${w.total}`);
  const sweep = await adapter.sweep();
  console.log(`harvest tx=${sweep.txId} feeTokens=${sweep.feeTokens}`);
  const after = await adapter.withheld();
  if (after.total !== 0n) throw new Error(`withheld after harvest should be 0, got ${after.total}`);

  // 4. balances via getProgramAccounts fallback (public RPC has no DAS)
  const balances = await adapter.snapshotBalances();
  const b = balances.get(holderB.publicKey.toBase58());
  console.log(`B balance=${b} (expected ${amount - fee})`);
  if (b !== amount - fee) throw new Error('unexpected B balance');
  console.log('OK: devnet smoke passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
