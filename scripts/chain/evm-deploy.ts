#!/usr/bin/env tsx
/**
 * Deploy FeeVault + TeamLock + MeshToken with `forge script` and write config/deploy.<network>.json.
 *
 *   pnpm --filter @mesh/chain-adapter evm:deploy -- --network base-sepolia [--broadcast] [--verify]
 *   pnpm --filter @mesh/chain-adapter evm:deploy -- --network robinhood --broadcast
 *   pnpm --filter @mesh/chain-adapter evm:deploy -- --network anvil --broadcast      # local anvil on :8545
 *
 * Networks (override any with --rpc-url / --chain-id):
 *   base-sepolia      chainId 84532, RPC $BASE_SEPOLIA_RPC_URL or https://sepolia.base.org
 *   base              chainId 8453,  RPC $BASE_RPC_URL or https://mainnet.base.org
 *   robinhood         chainId 4663,  RPC $ROBINHOOD_RPC_URL or https://rpc.mainnet.chain.robinhood.com
 *   robinhood-testnet chainId 46630, RPC $ROBINHOOD_TESTNET_RPC_URL or https://rpc.testnet.chain.robinhood.com
 *
 * NOTE: with the Pons launch (docs/CHAIN_DECISION.md) this script is the FALLBACK path only — the token is
 * minted by the Pons factory, and our contract is PonsFeeVault (contracts/evm/script/DeployPonsFeeVault.s.sol).
 *   anvil             chainId 31337, RPC http://127.0.0.1:8545
 *
 * Env: MESH_EVM_PRIVATE_KEY (deployer; FeeVault owner + token owner unless MESH_OWNER is set),
 *      MESH_FEE_BPS defaults to tokenomics.tradeFeeBps, plus the MESH_* knobs listed in
 *      contracts/evm/script/Deploy.s.sol. Without --broadcast this is a simulation (no gas spent).
 *      FOUNDRY_SOLC=tools/solc-js-wrapper.mjs when solc binaries cannot be downloaded.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadTokenomics } from '../../packages/config/src/index.js';
import { KNOWN_CHAINS } from '../../packages/chain-adapter/src/evm.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : [])).filter((x) => x.length),
) as Record<string, string>;

const NETWORKS: Record<string, { chainId?: number; rpc?: string }> = {
  'base-sepolia': { chainId: 84532, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org' },
  base: { chainId: 8453, rpc: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org' },
  robinhood: { chainId: 4663, rpc: process.env.ROBINHOOD_RPC_URL ?? KNOWN_CHAINS[4663]?.rpc },
  'robinhood-testnet': {
    chainId: process.env.ROBINHOOD_TESTNET_CHAIN_ID ? Number(process.env.ROBINHOOD_TESTNET_CHAIN_ID) : 46630,
    rpc: process.env.ROBINHOOD_TESTNET_RPC_URL ?? KNOWN_CHAINS[46630]?.rpc,
  },
  anvil: { chainId: 31337, rpc: 'http://127.0.0.1:8545' },
};

const network = args.network ?? 'base-sepolia';
const net = NETWORKS[network] ?? {};
const rpc = args['rpc-url'] ?? net.rpc;
const chainId = args['chain-id'] ? Number(args['chain-id']) : net.chainId;
if (!rpc || !chainId) {
  console.error(`network "${network}" needs --rpc-url and --chain-id (or the env vars listed in the header)`);
  process.exit(2);
}
const pk = process.env.MESH_EVM_PRIVATE_KEY;
if (!pk) {
  console.error('MESH_EVM_PRIVATE_KEY is required (deployer)');
  process.exit(2);
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const contracts = resolve(root, 'contracts/evm');
const tokenomics = loadTokenomics();

const forgeArgs = ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', rpc, '--private-key', pk.startsWith('0x') ? pk : `0x${pk}`, '-vvv'];
if (args.broadcast === 'true') forgeArgs.push('--broadcast');
if (args.verify === 'true') forgeArgs.push('--verify');
if (args['legacy'] === 'true') forgeArgs.push('--legacy');

console.log(`forge ${forgeArgs.map((a) => (a.startsWith('0x') && a.length > 50 ? '0x***' : a)).join(' ')}`);
const r = spawnSync('forge', forgeArgs, {
  cwd: contracts,
  stdio: 'inherit',
  env: { ...process.env, MESH_FEE_BPS: process.env.MESH_FEE_BPS ?? String(tokenomics.tradeFeeBps) },
});
if (r.status !== 0) process.exit(r.status ?? 1);

const deploymentFile = resolve(contracts, 'deployments', `${chainId}.json`);
if (!existsSync(deploymentFile)) {
  console.error(`forge did not write ${deploymentFile}`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(deploymentFile, 'utf8')) as Record<string, string | number>;
const known = KNOWN_CHAINS[chainId];
const out = {
  chain: 'evm',
  network,
  chainId,
  rpcUrl: rpc,
  token: d.token,
  feeVault: d.feeVault,
  teamLock: d.teamLock,
  // MeshStaking when the script ran with MESH_STAKING=true (zero address otherwise → parsed as "no staking").
  staking: d.staking,
  treasury: d.treasury,
  owner: d.owner,
  deployBlock: Number(d.deployBlock),
  decimals: 18,
  feeBps: Number(d.feeBps),
  usdc: known?.usdc ?? '0x0000000000000000000000000000000000000000',
  swapRouter: known?.swapRouter ?? '0x0000000000000000000000000000000000000000',
  quoter: known?.quoter,
  poolFee: 3000,
  slippageBps: 100,
  logChunkBlocks: 5000,
  excludeWallets: [d.teamLock].filter((a) => a && a !== '0x0000000000000000000000000000000000000000'),
  deployedAt: new Date().toISOString(),
  simulated: args.broadcast !== 'true',
  _comment:
    'Fill usdc / swapRouter / quoter for this chain if zero, add the Uniswap pool address to excludeWallets and call MeshToken.setFeeExempt(pool, true) after creating it. Owner should be moved to a multisig (Ownable2Step: transferOwnership + acceptOwnership).',
};
const path = resolve(configDir(), `deploy.${network}.json`);
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${path}${out.simulated ? ' (SIMULATION — re-run with --broadcast to deploy)' : ''}`);
