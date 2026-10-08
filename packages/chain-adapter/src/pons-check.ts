import { createPublicClient, defineChain, getAddress, http, isAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KNOWN_CHAINS } from './evm.js';
import { erc20Abi, erc20MetadataAbi, ponsEscrowAbi, ponsFeeVaultAbi } from './evm/abi.js';
import type { EvmDeployConfig } from './deploy-config.js';

export interface PonsCheckItem {
  check: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  value?: unknown;
}

export interface PonsCheckReport {
  ok: boolean;
  chainId: number;
  rpcUrl: string | null;
  rpcReachable: boolean;
  rpcChainId: number | null;
  items: PonsCheckItem[];
  checkedAt: number;
}

/**
 * Verify an EVM/Pons deploy config against the chain: the RPC answers for the right chainId, `token`
 * is an ERC-20, the Pons escrow holds a balance line for `feeVault`, `feeVault` is our PonsFeeVault
 * (owner / sweeper / recipients readable and consistent), and the exclusion list is sane. Never throws:
 * every problem is a `fail` / `warn` item so the admin panel can show the whole picture.
 */
export async function checkPonsConfig(
  cfg: Partial<EvmDeployConfig> & { chainId: number },
  opts: { rpcUrl?: string; sweeperAddress?: Address; publicClient?: PublicClient; timeoutMs?: number } = {},
): Promise<PonsCheckReport> {
  const items: PonsCheckItem[] = [];
  const known = KNOWN_CHAINS[cfg.chainId];
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl ?? known?.rpc ?? null;
  const report: PonsCheckReport = { ok: false, chainId: cfg.chainId, rpcUrl, rpcReachable: false, rpcChainId: null, items, checkedAt: Math.floor(Date.now() / 1000) };
  const push = (check: string, status: PonsCheckItem['status'], detail: string, value?: unknown) => items.push({ check, status, detail, ...(value !== undefined ? { value } : {}) });

  // ---- static checks (no RPC) ----
  const addrFields: Array<keyof EvmDeployConfig> = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed', 'ponsEscrow'];
  for (const f of addrFields) {
    const v = cfg[f] as string | undefined;
    if (v === undefined || v === null || v === '') {
      push(`field.${f}`, f === 'token' || f === 'feeVault' || f === 'treasury' || f === 'creditPool' ? 'fail' : 'skip', `${f} not set`);
      continue;
    }
    if (!isAddress(v, { strict: false })) push(`field.${f}`, 'fail', `${f} is not an address: ${v}`);
    else if (/[A-F]/.test(v.slice(2)) && /[a-f]/.test(v.slice(2)) && getAddress(v) !== v) push(`field.${f}`, 'fail', `${f} has a bad EIP-55 checksum (mixed case but not the canonical form)`, v);
    else push(`field.${f}`, 'ok', `${f} = ${v}`);
  }
  const excl = (cfg.excludeWallets ?? []).map((w) => w.toLowerCase());
  const dup = excl.filter((w, i) => excl.indexOf(w) !== i);
  if (dup.length) push('excludeWallets.duplicates', 'warn', `duplicates: ${Array.from(new Set(dup)).join(', ')}`);
  const badExcl = excl.filter((w) => !isAddress(w, { strict: false }));
  if (badExcl.length) push('excludeWallets.format', 'fail', `not addresses: ${badExcl.join(', ')}`);
  for (const [name, a] of [
    ['ponsEscrow', cfg.ponsEscrow],
    ['ponsFactory', cfg.ponsFactory],
    ['ponsHook', cfg.ponsHook],
    ['launchLocker', cfg.launchLocker],
    ['buybackVault', cfg.buybackVault],
    ['feeVault', cfg.feeVault],
    ['creditPool', cfg.creditPool],
    ['treasury', cfg.treasury],
  ] as Array<[string, string | undefined]>) {
    if (a && !excl.includes(a.toLowerCase())) push(`excludeWallets.${name}`, 'warn', `${name} ${a} is not in excludeWallets (the adapter excludes it implicitly, but list it so the file documents it)`);
  }
  if (cfg.curve && !excl.includes(cfg.curve.toLowerCase())) push('excludeWallets.curve', 'fail', `curve ${cfg.curve} must be excluded or the bonding curve earns credits`);
  if (!cfg.curve) push('excludeWallets.curve', 'warn', 'no `curve` address yet: add the Pons bonding-curve address (and the pool after graduation) to excludeWallets');
  if (cfg.deployBlock === undefined || cfg.deployBlock === null) push('deployBlock', 'warn', 'deployBlock not set: the first holder scan starts at block 0 (slow)');
  else push('deployBlock', 'ok', `scans start at block ${cfg.deployBlock}`);
  if (cfg.treasury && cfg.creditPool && cfg.treasury.toLowerCase() === cfg.creditPool.toLowerCase()) push('recipients.distinct', 'warn', 'treasury == creditPool: the holder share and the treasury share land in the same wallet');

  // ---- RPC checks ----
  if (!rpcUrl) {
    push('rpc', 'fail', 'no RPC URL (deploy json rpcUrl or MESH_EVM_RPC_URL)');
    report.ok = items.every((i) => i.status !== 'fail');
    return report;
  }
  const chain = defineChain({ id: cfg.chainId, name: known?.name ?? `chain-${cfg.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = opts.publicClient ?? createPublicClient({ chain, transport: http(rpcUrl, { timeout: opts.timeoutMs ?? 8000, retryCount: 0 }) });
  try {
    const id = await client.getChainId();
    report.rpcReachable = true;
    report.rpcChainId = id;
    if (id !== cfg.chainId) push('rpc.chainId', 'fail', `RPC reports chainId ${id}, config says ${cfg.chainId}`);
    else push('rpc.chainId', 'ok', `RPC ${rpcUrl} is chain ${id}${known ? ` (${known.name})` : ''}`);
  } catch (err) {
    push('rpc', 'fail', `RPC ${rpcUrl} unreachable: ${(err as Error).message.split('\n')[0]}`);
    report.ok = false;
    return report;
  }

  const read = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      push(label, 'fail', (err as Error).message.split('\n')[0]);
      return undefined;
    }
  };

  const token = cfg.token && isAddress(cfg.token, { strict: false }) ? (cfg.token as Address) : undefined;
  if (token) {
    const code = await read('token.code', () => client.getCode({ address: token }));
    if (code === undefined || code === '0x') push('token.code', 'fail', `no contract at token ${token}`);
    else {
      const [name, symbol, decimals, supply] = await Promise.all([
        read('token.name', () => client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'name' })),
        read('token.symbol', () => client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'symbol' })),
        read('token.decimals', () => client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
        read('token.totalSupply', () => client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })),
      ]);
      if (decimals !== undefined && supply !== undefined) {
        push('token.erc20', 'ok', `${name ?? '?'} (${symbol ?? '?'}), ${decimals} decimals, supply ${formatUnits(supply, decimals)}`, { name, symbol, decimals, totalSupply: supply.toString() });
      }
      if (cfg.decimals !== undefined && decimals !== undefined && cfg.decimals !== decimals) push('token.decimals.match', 'fail', `config decimals ${cfg.decimals} != on-chain ${decimals}`);
    }
  }

  const escrow = cfg.ponsEscrow && isAddress(cfg.ponsEscrow, { strict: false }) ? (cfg.ponsEscrow as Address) : undefined;
  const feeVault = cfg.feeVault && isAddress(cfg.feeVault, { strict: false }) ? (cfg.feeVault as Address) : undefined;
  if (escrow) {
    const code = await read('escrow.code', () => client.getCode({ address: escrow }));
    if (code === undefined || code === '0x') push('escrow.code', 'fail', `no contract at ponsEscrow ${escrow}`);
    else if (feeVault) {
      const bal = await read('escrow.balance', () => client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: 'balanceOf', args: [feeVault] }));
      if (bal !== undefined) push('escrow.balance', 'ok', `escrow holds ${formatUnits(bal, 18)} ETH for feeVault`, bal.toString());
      for (const q of cfg.quoteTokens ?? []) {
        if (q === zeroAddress) continue;
        const b = await read(`escrow.balanceOfToken.${q}`, () => client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: 'balanceOfToken', args: [feeVault, q] }));
        if (b !== undefined) push(`escrow.balanceOfToken.${q}`, 'ok', `escrow holds ${b.toString()} base units of ${q} for feeVault`, b.toString());
      }
    }
  }

  if (feeVault) {
    const code = await read('feeVault.code', () => client.getCode({ address: feeVault }));
    if (code === undefined || code === '0x') push('feeVault.code', 'fail', `no contract at feeVault ${feeVault}`);
    else {
      const [owner, sweeper, vEscrow, vPool, vTreasury, vStable, paused, bps] = await Promise.all([
        read('feeVault.owner', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'owner' })),
        read('feeVault.sweeper', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'sweeper' })),
        read('feeVault.escrow', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'escrow' })),
        read('feeVault.creditPool', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'creditPool' })),
        read('feeVault.treasury', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'treasury' })),
        read('feeVault.stable', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'stable' })),
        read('feeVault.paused', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'paused' })),
        read('feeVault.holderShareBps', () => client.readContract({ address: feeVault, abi: ponsFeeVaultAbi, functionName: 'holderShareBps' })),
      ]);
      if (owner) push('feeVault.owner', 'ok', `owner ${owner}`, owner);
      if (sweeper) {
        if (opts.sweeperAddress && sweeper.toLowerCase() !== opts.sweeperAddress.toLowerCase()) push('feeVault.sweeper', 'fail', `vault sweeper is ${sweeper}, the gateway signs as ${opts.sweeperAddress}`);
        else push('feeVault.sweeper', opts.sweeperAddress ? 'ok' : 'warn', `sweeper ${sweeper}${opts.sweeperAddress ? ' (matches MESH_EVM_PRIVATE_KEY)' : ' (MESH_EVM_PRIVATE_KEY not set: cannot confirm it is ours)'}`, sweeper);
      }
      if (vEscrow && escrow && vEscrow.toLowerCase() !== escrow.toLowerCase()) push('feeVault.escrow', 'fail', `vault points at escrow ${vEscrow}, config says ${escrow}`);
      if (vPool && cfg.creditPool && vPool.toLowerCase() !== cfg.creditPool.toLowerCase()) push('feeVault.creditPool', 'fail', `vault creditPool ${vPool} != config ${cfg.creditPool}`);
      else if (vPool) push('feeVault.creditPool', 'ok', `creditPool ${vPool}`);
      if (vTreasury && cfg.treasury && vTreasury.toLowerCase() !== cfg.treasury.toLowerCase()) push('feeVault.treasury', 'fail', `vault treasury ${vTreasury} != config ${cfg.treasury}`);
      else if (vTreasury) push('feeVault.treasury', 'ok', `treasury ${vTreasury}`);
      if (vStable !== undefined) {
        const stable = cfg.stable ?? cfg.usdc;
        if (vStable === zeroAddress) push('feeVault.stable', 'warn', `vault has no stable set: only sweepRaw works${cfg.sweepMode === 'raw' ? ' (sweepMode raw)' : ' and sweepMode "swap" will revert'} — call setStable + setRoute so fees settle in the stablecoin`);
        else if (stable && vStable.toLowerCase() !== stable.toLowerCase()) push('feeVault.stable', 'fail', `vault stable ${vStable} != config ${stable}`);
        else push('feeVault.stable', 'ok', `stable ${vStable}`);
      }
      if (paused) push('feeVault.paused', 'fail', 'vault is paused');
      if (bps !== undefined) push('feeVault.holderShareBps', 'ok', `holder share ${bps} bps`, bps);
    }
  }

  if (cfg.priceFeed && isAddress(cfg.priceFeed, { strict: false })) {
    const code = await read('priceFeed.code', () => client.getCode({ address: cfg.priceFeed as Address }));
    if (code === undefined || code === '0x') push('priceFeed.code', 'fail', `no contract at priceFeed ${cfg.priceFeed}`);
    else push('priceFeed.code', 'ok', 'price feed has code');
  } else if (cfg.fixedEthUsd) push('priceFeed', 'warn', `no Chainlink feed: ETH valued at fixed $${cfg.fixedEthUsd} (credits are minted against this number; set a feed before real fees flow)`);
  else push('priceFeed', 'warn', 'no priceFeed and no fixedEthUsd: ETH fees stay unswept (no credits minted) until one is set');
  // Raw sweeps leave the holder share in ETH while credits are fixed in USD: the pool carries the price risk.
  if (cfg.sweepMode === 'raw') push('sweepMode', 'warn', 'sweepMode is "raw": the holder share reaches the credit pool as ETH, not the stablecoin, so the reserve moves with the ETH price. Use "swap" in production.');
  else push('sweepMode', 'ok', 'sweepMode "swap": fees settle in the stablecoin on chain');

  report.ok = items.every((i) => i.status !== 'fail');
  return report;
}

function formatUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

/**
 * Validate an address as pasted by a human: lower-case / upper-case are accepted and returned checksummed;
 * a mixed-case string whose EIP-55 checksum is wrong is rejected (typo protection). Returns null when it
 * is not an address at all.
 */
export function checksumPastedAddress(input: string): { address: Address } | { error: string } {
  const s = input.trim();
  if (!isAddress(s, { strict: false })) return { error: `not a 0x address: ${s}` };
  const body = s.slice(2);
  const mixed = /[A-F]/.test(body) && /[a-f]/.test(body);
  if (mixed && getAddress(s) !== s) return { error: `bad EIP-55 checksum: ${s}` };
  return { address: getAddress(s) };
}

/** Address of the gateway's sweeper key (MESH_EVM_PRIVATE_KEY), or undefined when unset / malformed. */
export function sweeperAddressFromKey(pk: string | undefined): Address | undefined {
  if (!pk) return undefined;
  try {
    return privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`).address;
  } catch {
    return undefined;
  }
}
