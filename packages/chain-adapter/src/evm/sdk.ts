/**
 * Re-exports of the viem surface that scripts outside this package (scripts/chain/*.ts) need, so they
 * resolve `viem` through this package's node_modules (same trick as solana/sdk.ts).
 */
export { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, zeroAddress } from 'viem';
export type { Abi, Address, Hex } from 'viem';
export { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
