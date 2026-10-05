#!/usr/bin/env tsx
/**
 * Robinhood Chain TESTNET rehearsal of the Pons fee path (docs: scripts/chain/robinhood-testnet-rehearsal.md).
 *
 * Deploys, with a throwaway key:
 *   1. MockPonsEscrow      — stands in for the Pons Fee Escrow (same selectors as IPonsFeeEscrow)
 *   2. MockERC20 "MESH-test" — stands in for the Pons-minted token (whole supply to a "curve" wallet)
 *   3. PonsFeeVault        — the real contract, owner = sweeper = the throwaway key, creditPool/treasury = fresh addresses
 * then simulates fee accrual (ETH into the escrow for the vault), moves some MESH-test between holders,
 * runs ONE PonsEvmAdapter.collectFees() (raw mode, fixed ETH price) and prints getHolderBalances().
 * Finally it writes the addresses into config/deploy.robinhood-testnet.json (unless --no-write).
 *
 *   export MESH_EVM_PRIVATE_KEY=0x...   # throwaway key funded with testnet ETH (≈0.02 ETH is plenty)
 *   pnpm --filter @mesh/chain-adapter evm:rehearsal -- [--rpc-url URL] [--chain-id 46630] [--fee-eth 0.001] [--no-write] [--dry-run]
 *
 * Needs `forge build` artifacts in contracts/evm/out (FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge build when
 * solc binaries cannot be downloaded). Nothing here touches mainnet or any real Pons contract.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, formatEther, generatePrivateKey, http, parseEther, privateKeyToAccount, zeroAddress, type Abi, type Address, type Hex } from '../../packages/chain-adapter/src/evm/sdk.js';
import { PonsEvmAdapter } from '../../packages/chain-adapter/src/pons.js';
import { KNOWN_CHAINS, memoryStateStore } from '../../packages/chain-adapter/src/evm.js';
import { checkPonsConfig } from '../../packages/chain-adapter/src/pons-check.js';
import { erc20Abi } from '../../packages/chain-adapter/src/evm/abi.js';
import { configDir } from '../../packages/config/src/index.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : [])).filter((x) => x.length),
) as Record<string, string>;

const chainId = Number(args['chain-id'] ?? process.env.ROBINHOOD_TESTNET_CHAIN_ID ?? 46630);
const rpcUrl = args['rpc-url'] ?? process.env.ROBINHOOD_TESTNET_RPC_URL ?? process.env.MESH_EVM_RPC_URL ?? KNOWN_CHAINS[chainId]?.rpc;
const feeEth = args['fee-eth'] ?? '0.001';
const write = args['no-write'] !== 'true';
const dryRun = args['dry-run'] === 'true';
const pkRaw = process.env.MESH_EVM_PRIVATE_KEY;
if (!rpcUrl) fail(`no RPC for chain ${chainId}: pass --rpc-url or set ROBINHOOD_TESTNET_RPC_URL`);
if (!pkRaw) fail('MESH_EVM_PRIVATE_KEY is required (a THROWAWAY key funded with testnet ETH)');
if (chainId === 4663) fail('refusing to run the rehearsal against Robinhood Chain MAINNET (chainId 4663)');

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const OUT = resolve(root, 'contracts/evm/out');
function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) fail(`missing ${p}: run forge build in contracts/evm`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

const pk = (pkRaw!.startsWith('0x') ? pkRaw : `0x${pkRaw}`) as Hex;
const deployer = privateKeyToAccount(pk);
const chain = defineChain({ id: chainId, name: KNOWN_CHAINS[chainId]?.name ?? `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl!] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
const explorer = KNOWN_CHAINS[chainId]?.explorer;
const link = (kind: 'address' | 'tx', v: string) => (explorer ? `${explorer}/${kind}/${v}` : v);

async function deploy(name: string, deployArgs: unknown[]): Promise<{ address: Address; block: bigint; tx: Hex }> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args: deployArgs } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) fail(`${name} deploy reverted (${hash})`);
  console.log(`  ${name.padEnd(16)} ${r.contractAddress}  block ${r.blockNumber}  ${link('tx', hash)}`);
  return { address: r.contractAddress, block: r.blockNumber, tx: hash };
}
async function send(label: string, req: { address: Address; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }): Promise<Hex> {
  const hash = await wallet.writeContract({ ...req, account: deployer, chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') fail(`${label} reverted (${hash})`);
  console.log(`  ${label.padEnd(28)} ${link('tx', hash)}`);
  return hash;
}

async function main() {
  const onChainId = await pub.getChainId();
  if (onChainId !== chainId) fail(`RPC ${rpcUrl} is chain ${onChainId}, expected ${chainId}`);
  const bal = await pub.getBalance({ address: deployer.address });
  console.log(`Robinhood Chain testnet rehearsal · chain ${chainId} · rpc ${rpcUrl}`);
  console.log(`deployer/sweeper ${deployer.address}  balance ${formatEther(bal)} ETH`);
  if (bal < parseEther('0.005')) fail('fund the key with at least 0.005 testnet ETH');
  if (dryRun) {
    console.log('--dry-run: artifacts present, RPC reachable, key funded. Nothing deployed.');
    return;
  }

  // Fresh addresses for the roles the vault pays, so the flows are visible on the explorer.
  const creditPool = privateKeyToAccount(generatePrivateKey()).address;
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  const alice = privateKeyToAccount(generatePrivateKey());
  const curve = deployer.address; // the deployer plays the Pons bonding curve: it holds the supply and sells to holders

  console.log('\n1. deploy');
  const escrow = await deploy('MockPonsEscrow', []);
  const token = await deploy('MockERC20', ['Mesh test', 'MESH-test', parseEther('1000000000'), curve]);
  const vault = await deploy('PonsFeeVault', [
    { owner: deployer.address, sweeper: deployer.address, escrow: escrow.address, creditPool, treasury, stable: zeroAddress, weth: zeroAddress, holderShareBps: 5000, quoteTokens: [] },
  ]);
  const escrowAbi = artifact('MockPonsEscrow').abi;
  await send('escrow.setCreatorFeeRecipient', { address: escrow.address, abi: escrowAbi, functionName: 'setCreatorFeeRecipient', args: [token.address, vault.address] });

  console.log('\n2. holders (curve → alice 10,000; alice → creditPool 1,000 later excluded)');
  await send('transfer curve→alice', { address: token.address, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [alice.address, parseEther('10000')] });
  // give alice gas so she can move tokens (tests the transfer-out reset of holdSince)
  const gasTx = await wallet.sendTransaction({ to: alice.address, value: parseEther('0.0005'), account: deployer, chain });
  await pub.waitForTransactionReceipt({ hash: gasTx });
  const aliceWallet = createWalletClient({ account: alice, chain, transport: http(rpcUrl) });
  const h = await aliceWallet.writeContract({ address: token.address, abi: erc20Abi, functionName: 'transfer', args: [creditPool, parseEther('1000')], account: alice, chain });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  transfer alice→creditPool      ${link('tx', h)}`);

  console.log(`\n3. simulate fee accrual: ${feeEth} ETH into the escrow for the vault`);
  await send('escrow.accrue(vault)', { address: escrow.address, abi: escrowAbi, functionName: 'accrue', args: [vault.address], value: parseEther(feeEth) });

  console.log('\n4. adapter: one collectFees() in raw mode (fixed ETH price $3000)');
  const adapter = new PonsEvmAdapter({
    rpcUrl,
    chainId,
    tokenAddress: token.address,
    feeVault: vault.address,
    treasury,
    creditPool,
    ponsEscrow: escrow.address,
    quoteTokens: [zeroAddress],
    sweepMode: 'raw',
    fixedEthUsd: 3000,
    deployBlock: Number(token.block),
    excludeWallets: [curve],
    holderShareBps: 5000,
    privateKey: pk,
    stateStore: memoryStateStore(),
  });
  console.log(`  pendingFeesUsd before: $${await adapter.pendingFeesUsd()}`);
  const res = await adapter.collectFees();
  const d = adapter.lastSweep!;
  console.log(`  collectFees → $${res.amountUsd}  tx ${link('tx', res.txId)}`);
  for (const a of d.assets) console.log(`    ${a.asset === zeroAddress ? 'ETH' : a.asset}: gross ${a.grossIn} → holder ${a.holderOut} / treasury ${a.treasuryOut} (${a.mode}) $${a.usd}`);
  if (d.warnings.length) console.log(`  warnings: ${d.warnings.join('; ')}`);
  console.log(`  creditPool ${creditPool} balance ${formatEther(await pub.getBalance({ address: creditPool }))} ETH`);
  console.log(`  treasury   ${treasury} balance ${formatEther(await pub.getBalance({ address: treasury }))} ETH`);
  console.log(`  pendingFeesUsd after: $${await adapter.pendingFeesUsd()}`);

  console.log('\n5. holder balances (last 10 minutes, time-weighted)');
  await new Promise((r) => setTimeout(r, 2500)); // let a couple of seconds pass so the transfers above carry weight in the window
  const now = Math.floor(Date.now() / 1000);
  const holders = await adapter.getHolderBalances({ from: now - 600, to: now });
  for (const hb of holders) console.log(`  ${hb.wallet}  ${hb.timeWeightedBalance.toFixed(4)} MESH-test  holdSince ${hb.holdSinceTs ?? '-'}`);
  console.log(`  (curve ${curve}, vault, creditPool and treasury are excluded)`);

  console.log('\n6. check report');
  const report = await checkPonsConfig(
    { chainId, rpcUrl, token: token.address, feeVault: vault.address, creditPool, treasury, ponsEscrow: escrow.address, quoteTokens: [zeroAddress], curve, excludeWallets: [curve, escrow.address, vault.address, creditPool, treasury], deployBlock: Number(token.block), fixedEthUsd: 3000, sweepMode: 'raw' },
    { sweeperAddress: deployer.address },
  );
  for (const i of report.items) if (i.status !== 'skip') console.log(`  ${i.status.padEnd(4)} ${i.check.padEnd(28)} ${i.detail}`);
  console.log(`  ok=${report.ok}`);

  if (write) {
    const p = resolve(configDir(), 'deploy.robinhood-testnet.json');
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    Object.assign(j, {
      token: token.address,
      launchTx: token.tx,
      curve,
      deployBlock: Number(token.block),
      ponsEscrow: escrow.address,
      feeVault: vault.address,
      creditPool,
      treasury,
      excludeWallets: [curve],
      deployedAt: new Date().toISOString(),
      _comment_rehearsal: `written by scripts/chain/robinhood-testnet-rehearsal.ts; sweeper = ${deployer.address}`,
    });
    writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
    console.log(`\nwrote ${p}`);
  }
  console.log('\nDone. To run the gateway against this rehearsal:');
  console.log('  MESH_ADAPTER=evm MESH_DEPLOY_NETWORK=robinhood-testnet MESH_EVM_PRIVATE_KEY=<same key> pnpm dev:gateway   # /health → adapter "evm (pons)"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
