//! mesh-staking — Solana twin of contracts/evm/src/MeshStaking.sol.
//!
//! Stake $MESH (Token-2022 mint with the TransferFee extension) to reach a tier. The program is a
//! position registry: it holds tokens in a program-owned vault and records {amount, lock_days,
//! lock_ends_at} per wallet. It pays NO rewards; the gateway reads positions once per epoch
//! (`ChainAdapter.getStakes`), maps them onto `stakeTiers` in config/tokenomics.json, multiplies
//! node rewards and orders routing by tier (docs/STAKING.md).
//!
//! Semantics match the EVM contract exactly:
//!  - `stake(amount, lock_days)` adds tokens; `lock_days` must be >= the committed lock (0 keeps
//!    it); lock_ends_at = max(current, now + lock_days * 86400) so a top-up never shortens a lock.
//!  - `unstake(amount)` once now >= lock_ends_at; taking the position to zero clears the lock.
//!  - Tier = highest tier with min_stake <= amount AND tier.lock_days <= committed lock_days.
//!  - Authority (multisig) can replace the tier table; positions are untouched.
//!
//! STATUS: `cargo check` clean against anchor-lang 0.30.1, but NOT built to SBF or tested on a
//! validator: no `solana` / `anchor` CLI is available in the environment this was written in
//! (see README.md). The program id is a placeholder until `anchor keys sync`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

// Placeholder id: run `anchor keys sync` after the first build.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MAX_TIERS: usize = 8;
pub const MAX_LOCK_DAYS: u32 = 4 * 365;
pub const BPS: u32 = 10_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";

#[program]
pub mod mesh_staking {
    use super::*;

    /// Create the StakeConfig PDA + vault ATA for `mint`. `tiers` mirrors config/tokenomics.json.
    pub fn initialize(ctx: Context<Initialize>, tiers: Vec<Tier>) -> Result<()> {
        validate_tiers(&tiers)?;
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.mint = ctx.accounts.mint.key();
        cfg.vault = ctx.accounts.vault.key();
        cfg.total_staked = 0;
        cfg.tiers = tiers;
        cfg.bump = ctx.bumps.config;
        emit!(TiersUpdated { count: cfg.tiers.len() as u8 });
        Ok(())
    }

    /// Replace the tier table (authority only). Positions re-evaluate against the new table.
    pub fn set_tiers(ctx: Context<SetTiers>, tiers: Vec<Tier>) -> Result<()> {
        validate_tiers(&tiers)?;
        ctx.accounts.config.tiers = tiers;
        emit!(TiersUpdated { count: ctx.accounts.config.tiers.len() as u8 });
        Ok(())
    }

    /// Stake `amount` (raw units) and commit to `lock_days` (0 = keep the current commitment).
    /// Token-2022 transfer fee: the position credits the post-fee amount (vault delta).
    pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u32) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);
        require!(lock_days <= MAX_LOCK_DAYS, StakingError::LockTooLong);
        let pos = &mut ctx.accounts.position;
        require!(lock_days == 0 || lock_days >= pos.lock_days, StakingError::LockShorterThanCommitted);
        // Pull tokens into the vault; credit what actually arrived (Token-2022 transfer fee).
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staker_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(StakingError::Overflow)?;
        require!(received > 0, StakingError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.staker.key();
            pos.bump = ctx.bumps.position;
        }
        pos.amount = pos.amount.checked_add(received).ok_or(StakingError::Overflow)?;
        ctx.accounts.config.total_staked = ctx.accounts.config.total_staked.checked_add(received).ok_or(StakingError::Overflow)?;
        if lock_days > pos.lock_days {
            pos.lock_days = lock_days;
        }
        if lock_days > 0 {
            let new_end = now + (lock_days as i64) * 86_400;
            if new_end > pos.lock_ends_at {
                pos.lock_ends_at = new_end;
            }
        }
        emit!(Staked { wallet: pos.owner, amount: received, total: pos.amount, lock_days: pos.lock_days, lock_ends_at: pos.lock_ends_at });
        Ok(())
    }

    /// Withdraw `amount` once the lock has ended. Zeroing the position clears the lock commitment.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        require!(amount <= pos.amount, StakingError::InsufficientStake);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= pos.lock_ends_at, StakingError::StillLocked);
        pos.amount -= amount;
        ctx.accounts.config.total_staked = ctx.accounts.config.total_staked.saturating_sub(amount);
        if pos.amount == 0 {
            pos.lock_days = 0;
            pos.lock_ends_at = 0;
        }
        let mint_key = ctx.accounts.config.mint;
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[CONFIG_SEED, mint_key.as_ref(), &[bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.staker_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(Unstaked { wallet: pos.owner, amount, remaining: pos.amount });
        Ok(())
    }

    /// Close an empty Position and refund rent to the owner.
    pub fn close_position(_ctx: Context<ClosePosition>) -> Result<()> {
        Ok(())
    }
}

// ------------------------------------------------------------------ state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Tier {
    /// Short label, informative only ("gold"), zero-padded.
    pub name: [u8; 16],
    /// Raw token units (mint decimals).
    pub min_stake: u64,
    /// 0 = no lock required.
    pub lock_days: u32,
    /// 10_000 = 1.0x.
    pub multiplier_bps: u32,
}

/// PDA ["config", mint]. One per mint.
#[account]
#[derive(InitSpace)]
pub struct StakeConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    /// Token account owned by this PDA that holds every stake.
    pub vault: Pubkey,
    pub total_staked: u64,
    #[max_len(MAX_TIERS)]
    pub tiers: Vec<Tier>,
    pub bump: u8,
}

/// PDA ["position", config, owner]. Created on first stake.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_days: u32,
    /// Unix seconds; 0 when nothing is locked.
    pub lock_ends_at: i64,
    pub bump: u8,
}

impl Position {
    /// Highest tier index whose min_stake and lock the position meets (0 always matches).
    pub fn tier_index(&self, tiers: &[Tier]) -> usize {
        let mut idx = 0;
        for (i, t) in tiers.iter().enumerate() {
            if self.amount >= t.min_stake && self.lock_days >= t.lock_days {
                idx = i;
            }
        }
        idx
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, space = 8 + StakeConfig::INIT_SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, StakeConfig>,
    /// Vault token account; authority = config PDA.
    #[account(init, payer = authority, seeds = [VAULT_SEED, config.key().as_ref()], bump, token::mint = mint, token::authority = config, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTiers<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, StakeConfig>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, StakeConfig>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = staker)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = staker, space = 8 + Position::INIT_SPACE, seeds = [POSITION_SEED, config.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub staker: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, StakeConfig>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = staker)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, has_one = owner @ StakingError::NotOwner, seeds = [POSITION_SEED, config.key().as_ref(), staker.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    /// CHECK: equals position.owner via has_one; same signer as `staker`.
    #[account(address = staker.key())]
    pub owner: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, StakeConfig>,
    #[account(mut, close = staker, constraint = position.amount == 0 @ StakingError::PositionNotEmpty, constraint = position.owner == staker.key() @ StakingError::NotOwner, seeds = [POSITION_SEED, config.key().as_ref(), staker.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
}

// ------------------------------------------------------------------ events / errors

#[event]
pub struct Staked {
    pub wallet: Pubkey,
    pub amount: u64,
    pub total: u64,
    pub lock_days: u32,
    pub lock_ends_at: i64,
}

#[event]
pub struct Unstaked {
    pub wallet: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct TiersUpdated {
    pub count: u8,
}

#[error_code]
pub enum StakingError {
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("lock exceeds MAX_LOCK_DAYS")]
    LockTooLong,
    #[msg("lock is shorter than the lock already committed")]
    LockShorterThanCommitted,
    #[msg("position is still locked")]
    StillLocked,
    #[msg("more than staked")]
    InsufficientStake,
    #[msg("tier table empty")]
    NoTiers,
    #[msg("too many tiers")]
    TooManyTiers,
    #[msg("first tier must have min_stake 0 and no lock")]
    FirstTierMustBeZero,
    #[msg("tiers must be strictly ascending in min_stake")]
    TiersNotAscending,
    #[msg("multiplier_bps must be > 0")]
    ZeroMultiplier,
    #[msg("position is not empty")]
    PositionNotEmpty,
    #[msg("not the position owner")]
    NotOwner,
    #[msg("arithmetic overflow")]
    Overflow,
}

pub fn validate_tiers(tiers: &[Tier]) -> Result<()> {
    require!(!tiers.is_empty(), StakingError::NoTiers);
    require!(tiers.len() <= MAX_TIERS, StakingError::TooManyTiers);
    require!(tiers[0].min_stake == 0 && tiers[0].lock_days == 0, StakingError::FirstTierMustBeZero);
    for (i, t) in tiers.iter().enumerate() {
        require!(t.multiplier_bps > 0, StakingError::ZeroMultiplier);
        require!(t.lock_days <= MAX_LOCK_DAYS, StakingError::LockTooLong);
        if i > 0 {
            require!(t.min_stake > tiers[i - 1].min_stake, StakingError::TiersNotAscending);
        }
    }
    Ok(())
}
