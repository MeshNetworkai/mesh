#!/usr/bin/env tsx
/**
 * Create the $MESH Token-2022 mint with the TransferFee extension and write
 * config/deploy.<cluster>.json.
 *
 *   pnpm --filter @mesh/chain-adapter solana:create-mint -- --cluster devnet [--decimals 6] [--supply 1000000000] [--max-fee 1000000]
 *
 * Env:
 *   MESH_SOLANA_KEYPAIR   deployer secret (base58, JSON array, or path to a solana-keygen json). Becomes
 *                         mint authority, transfer-fee config authority, withdraw-withheld authority, treasury.
 *   MESH_SOLANA_RPC_URL   optional RPC (default: public cluster RPC)
 *   MESH_HELIUS_API_KEY   optional; used to build a Helius RPC URL when MESH_SOLANA_RPC_URL is unset
 *
 * Fee bps come from config/tokenomics.json (tradeFeeBps). On devnet the deployer is airdropped
 * when its balance is below 0.5 SOL (with retries; devnet faucets rate-limit).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Keypair, PublicKey, SystemProgram,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from '../../packages/chain-adapter/src/solana/sdk.js';
import { configDir, loadTokenomics } from '../../packages/config/src/index.js';
import { jsonRpc } from '../../packages/chain-adapter/src/rpc.js';
import { keypairFromEnv, USDC_DEVNET, USDC_MAINNET } from '../../packages/chain-adapter/src/solana.js';
import { requestAirdropWithRetry, sendInstructions } from '../../packages/chain-adapter/src/solana/tx.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : [])).filter((x) => x.length),
) as Record<string, string>;

const cluster = args.cluster ?? 'devnet';
const decimals = Number(args.decimals ?? 6);
const supply = BigInt(args.supply ?? '1000000000') * 10n ** BigInt(decimals);
const maxFee = BigInt(args['max-fee'] ?? (1_000_000n * 10n ** BigInt(decimals)).toString()); // cap per transfer, token units
const dryRun = args['dry-run'] === 'true';

async function main() {
  const tokenomics = loadTokenomics();
  const feeBps = tokenomics.tradeFeeBps;
  const deployer = keypairFromEnv(process.env.MESH_SOLANA_KEYPAIR) ?? (dryRun ? Keypair.generate() : undefined);
  if (!deployer) throw new Error('MESH_SOLANA_KEYPAIR is required');
  const rpcUrl =
    process.env.MESH_SOLANA_RPC_URL ??
    (process.env.MESH_HELIUS_API_KEY
      ? `https://${cluster === 'mainnet-beta' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${process.env.MESH_HELIUS_API_KEY}`
      : `https://api.${cluster}.solana.com`);
  const rpc = jsonRpc(rpcUrl);
  console.log(`cluster=${cluster} rpc=${rpcUrl.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`deployer=${deployer.publicKey.toBase58()} feeBps=${feeBps} decimals=${decimals} supply=${supply} maxFee=${maxFee}`);

  if (cluster === 'devnet' && !dryRun) {
    const bal = await rpc.call<{ value: number }>('getBalance', [deployer.publicKey.toBase58()]);
    if (bal.value < 0.5e9) {
      console.log('airdropping 1 SOL (devnet)...');
      const ok = await requestAirdropWithRetry(rpc, deployer.publicKey, 1e9);
      if (!ok) throw new Error('devnet airdrop rate-limited; fund the deployer manually (https://faucet.solana.com) and re-run');
    }
  }

  const mint = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = dryRun ? 0 : await rpc.call<number>('getMinimumBalanceForRentExemption', [mintLen]);
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, deployer.publicKey, true, TOKEN_2022_PROGRAM_ID);

  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // extension init MUST precede InitializeMint
    createInitializeTransferFeeConfigInstruction(mint.publicKey, deployer.publicKey, deployer.publicKey, feeBps, maxFee, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, decimals, deployer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, treasuryAta, deployer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, treasuryAta, deployer.publicKey, supply, [], TOKEN_2022_PROGRAM_ID),
  ];

  let sig = 'dry-run';
  if (!dryRun) {
    sig = await sendInstructions(rpc, deployer, ixs, [mint]);
    console.log(`mint created: ${mint.publicKey.toBase58()} tx=${sig}`);
  } else {
    console.log(`[dry-run] would create mint ${mint.publicKey.toBase58()} with ${ixs.length} instructions`);
  }

  const out = {
    chain: 'solana',
    network: cluster,
    mint: mint.publicKey.toBase58(),
    decimals,
    transferFeeBps: feeBps,
    maxFee: maxFee.toString(),
    treasury: deployer.publicKey.toBase58(),
    usdcMint: cluster === 'mainnet-beta' ? USDC_MAINNET : USDC_DEVNET,
    excludeWallets: [] as string[],
    jupiterBaseUrl: 'https://lite-api.jup.ag/swap/v1',
    slippageBps: 100,
    deployedAt: new Date().toISOString(),
    createTx: sig,
    _comment:
      'Add the DEX pool vault owner(s) / program addresses to excludeWallets after seeding the pool (scripts/chain/solana-seed-pool.md). Mint authority is still the deployer: revoke it with spl-token authorize <mint> mint --disable once the supply is final.',
  };
  const path = resolve(configDir(), `deploy.${cluster}.json`);
  if (dryRun) {
    console.log(`[dry-run] would write ${path}:\n${JSON.stringify(out, null, 2)}`);
    return;
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`next: set tokenomics.meta.contractAddress=${mint.publicKey.toBase58()}, chain=solana; seed the pool; then MESH_ADAPTER=chain`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
// keep PublicKey import used for readers extending the script
void PublicKey;
