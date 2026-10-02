import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export const meshTokenAbi = parseAbi([
  'function feeBps() view returns (uint16)',
  'function feeVault() view returns (address)',
  'function isFeeExempt(address) view returns (bool)',
  'function setFeeExempt(address account, bool exempt)',
  'event FeeTaken(address indexed from, address indexed to, uint256 fee)',
]);

export const feeVaultAbi = parseAbi([
  'function pending(address token) view returns (uint256)',
  'function sweep(address token, address to) returns (uint256)',
  'function withdraw(address token, address to, uint256 amount)',
  'function owner() view returns (address)',
  'event Swept(address indexed token, address indexed to, uint256 amount)',
]);

export const teamLockAbi = parseAbi([
  'function postTreasuryUsd(uint256 usd)',
  'function treasuryUsd() view returns (uint256)',
  'function releasable() view returns (uint256)',
  'function release() returns (uint256)',
]);

export const meshStakingAbi = parseAbi([
  'struct Tier { bytes32 name; uint256 minStake; uint32 lockDays; uint32 multiplierBps; }',
  'struct Position { uint256 amount; uint32 lockDays; uint64 lockEndsAt; }',
  'function stake(uint256 amount, uint32 lockDays)',
  'function unstake(uint256 amount)',
  'function stakedOf(address wallet) view returns (uint256)',
  'function lockEndsAt(address wallet) view returns (uint64)',
  'function positionOf(address wallet) view returns (Position)',
  'function tierOf(address wallet) view returns (uint256 index, Tier t)',
  'function multiplierOf(address wallet) view returns (uint32)',
  'function tiers() view returns (Tier[])',
  'function tierCount() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'event Staked(address indexed wallet, uint256 amount, uint256 total, uint32 lockDays, uint64 lockEndsAt)',
  'event Unstaked(address indexed wallet, uint256 amount, uint256 remaining)',
  'event TiersUpdated(uint256 count)',
]);

/** Uniswap v3 SwapRouter02 (no deadline in the struct) and QuoterV2. */
export const swapRouter02Abi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

export const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
