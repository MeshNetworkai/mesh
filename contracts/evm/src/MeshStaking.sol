// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title MeshStaking
/// @notice Stake $MESH to reach a tier. Tiers mirror `stakeTiers` in config/tokenomics.json:
///         a minimum stake, an optional lock (days) and a reward multiplier in basis points.
///
///         The contract pays NO rewards. It is a registry the gateway reads: a wallet's tier
///         multiplies its node rewards off-chain and moves its nodes to the front of the queue.
///
///         Model
///         - One position per wallet: {amount, lockDays, lockEndsAt}.
///         - `stake(amount, lockDays)` adds tokens and may raise the lock commitment. The lock end
///           becomes max(current lock end, now + lockDays) so topping up never shortens a lock.
///         - `tierOf(wallet)` is the highest tier whose minStake <= amount AND whose lockDays <=
///           the wallet's committed lockDays. Committing to a lock is what unlocks a locked tier;
///           the tier is kept after the lock expires for as long as the tokens stay staked.
///         - `unstake(amount)` is allowed once block.timestamp >= lockEndsAt. Taking the position
///           to zero clears the lock commitment.
///         - Owner (multisig) can replace the tier table; positions are untouched and simply
///           re-evaluate against the new table.
///
///         MeshToken charges a transfer fee unless one side is exempt: the deployer should call
///         MeshToken.setFeeExempt(staking, true). The contract credits what it actually received
///         so a non-exempt deployment still stays solvent.
contract MeshStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tier {
        bytes32 name; // short label ("silver"), informative only
        uint256 minStake; // token wei
        uint32 lockDays; // 0 = no lock required
        uint32 multiplierBps; // 10_000 = 1.0x
    }

    struct Position {
        uint256 amount;
        uint32 lockDays; // committed lock
        uint64 lockEndsAt; // unix seconds; 0 when no lock
    }

    uint32 public constant BPS = 10_000;
    uint32 public constant MAX_LOCK_DAYS = 4 * 365;
    uint256 public constant MAX_TIERS = 16;

    IERC20 public immutable token;
    uint256 public totalStaked;
    Tier[] private _tiers;
    mapping(address => Position) private _positions;

    event Staked(address indexed wallet, uint256 amount, uint256 total, uint32 lockDays, uint64 lockEndsAt);
    event Unstaked(address indexed wallet, uint256 amount, uint256 remaining);
    event TiersUpdated(uint256 count);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error LockTooLong(uint32 lockDays, uint32 max);
    error LockShorterThanCommitted(uint32 lockDays, uint32 committed);
    error StillLocked(uint64 lockEndsAt);
    error InsufficientStake(uint256 requested, uint256 staked);
    error NoTiers();
    error TooManyTiers();
    error FirstTierMustBeZero();
    error TiersNotAscending(uint256 index);
    error ZeroMultiplier(uint256 index);
    error CannotRecoverStakeToken();

    constructor(address token_, address owner_, Tier[] memory tiers_) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        _setTiers(tiers_);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Stake `amount` MESH (needs prior approval). `lockDays` is the lock the wallet commits
    ///         to; it must be >= the lock already committed (0 keeps the current commitment).
    function stake(uint256 amount, uint32 lockDays) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (lockDays > MAX_LOCK_DAYS) revert LockTooLong(lockDays, MAX_LOCK_DAYS);
        Position storage p = _positions[msg.sender];
        if (lockDays != 0 && lockDays < p.lockDays) revert LockShorterThanCommitted(lockDays, p.lockDays);

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        p.amount += received;
        totalStaked += received;
        if (lockDays > p.lockDays) p.lockDays = lockDays;
        if (lockDays > 0) {
            uint64 newEnd = uint64(block.timestamp + uint256(lockDays) * 1 days);
            if (newEnd > p.lockEndsAt) p.lockEndsAt = newEnd;
        }
        emit Staked(msg.sender, received, p.amount, p.lockDays, p.lockEndsAt);
    }

    /// @notice Withdraw `amount` staked MESH once the lock (if any) has ended.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = _positions[msg.sender];
        if (amount > p.amount) revert InsufficientStake(amount, p.amount);
        if (block.timestamp < p.lockEndsAt) revert StillLocked(p.lockEndsAt);

        p.amount -= amount;
        totalStaked -= amount;
        if (p.amount == 0) {
            p.lockDays = 0;
            p.lockEndsAt = 0;
        }
        emit Unstaked(msg.sender, amount, p.amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function stakedOf(address wallet) external view returns (uint256) {
        return _positions[wallet].amount;
    }

    function lockEndsAt(address wallet) external view returns (uint64) {
        return _positions[wallet].lockEndsAt;
    }

    function positionOf(address wallet) external view returns (Position memory) {
        return _positions[wallet];
    }

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    function tier(uint256 index) external view returns (Tier memory) {
        return _tiers[index];
    }

    /// @notice Highest tier the wallet qualifies for: minStake met and the lock it requires committed.
    ///         Tier 0 (minStake 0, no lock) always matches, so every wallet has a tier.
    function tierOf(address wallet) public view returns (uint256 index, Tier memory t) {
        Position storage p = _positions[wallet];
        uint256 n = _tiers.length;
        index = 0;
        for (uint256 i = 0; i < n; i++) {
            Tier storage c = _tiers[i];
            if (p.amount >= c.minStake && p.lockDays >= c.lockDays) index = i;
        }
        t = _tiers[index];
    }

    /// @notice Reward multiplier for `wallet` in basis points (10_000 = 1.0x).
    function multiplierOf(address wallet) external view returns (uint32) {
        (, Tier memory t) = tierOf(wallet);
        return t.multiplierBps;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Replace the tier table. Must be non-empty, start at minStake 0 with no lock, and be
    ///         strictly ascending in minStake. Positions are not modified.
    function setTiers(Tier[] calldata tiers_) external onlyOwner {
        _setTiers(tiers_);
    }

    /// @notice Recover tokens sent here by mistake. The stake token itself can never be moved by the owner.
    function recoverToken(address erc20, address to, uint256 amount) external onlyOwner {
        if (erc20 == address(token)) revert CannotRecoverStakeToken();
        if (to == address(0)) revert ZeroAddress();
        IERC20(erc20).safeTransfer(to, amount);
        emit Recovered(erc20, to, amount);
    }

    function _setTiers(Tier[] memory tiers_) internal {
        uint256 n = tiers_.length;
        if (n == 0) revert NoTiers();
        if (n > MAX_TIERS) revert TooManyTiers();
        if (tiers_[0].minStake != 0 || tiers_[0].lockDays != 0) revert FirstTierMustBeZero();
        for (uint256 i = 0; i < n; i++) {
            if (tiers_[i].multiplierBps == 0) revert ZeroMultiplier(i);
            if (tiers_[i].lockDays > MAX_LOCK_DAYS) revert LockTooLong(tiers_[i].lockDays, MAX_LOCK_DAYS);
            if (i > 0 && tiers_[i].minStake <= tiers_[i - 1].minStake) revert TiersNotAscending(i);
        }
        delete _tiers;
        for (uint256 i = 0; i < n; i++) _tiers.push(tiers_[i]);
        emit TiersUpdated(n);
    }
}
