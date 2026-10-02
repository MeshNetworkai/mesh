// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title TeamLock
/// @notice TokenTimelock-style lock for the team allocation, released by milestones instead of
///         dates. Each milestone is "treasury has accumulated >= X USD of swept fees"; an oracle
///         (the gateway's sweeper key, which knows the treasury total) posts that number.
///
///         - owner = the team (beneficiary). The owner can only call release(); it cannot move
///           tokens any other way, change milestones, or set the oracle value.
///         - oracle = address allowed to post treasuryUsd (monotonic, in whole USD).
///         - fallbackReleaseTime = optional dead-man switch: after this unix time everything is
///           releasable regardless of milestones (0 disables), so tokens are never bricked.
contract TeamLock is Ownable2Step {
    using SafeERC20 for IERC20;

    struct Milestone {
        uint256 treasuryUsdThreshold; // whole USD
        uint256 amount; // token wei released once the threshold is met
        bool released;
    }

    IERC20 public immutable token;
    address public oracle;
    uint256 public treasuryUsd;
    uint64 public immutable fallbackReleaseTime;
    Milestone[] public milestones;

    event TreasuryUsdPosted(uint256 treasuryUsd);
    event MilestoneReleased(uint256 indexed index, uint256 amount);
    event OracleUpdated(address indexed oracle);

    error NotOracle();
    error NothingToRelease();
    error ZeroAddress();
    error LengthMismatch();
    error NotMonotonic(uint256 current, uint256 proposed);

    constructor(
        address token_,
        address beneficiary,
        address oracle_,
        uint256[] memory thresholdsUsd,
        uint256[] memory amounts,
        uint64 fallbackReleaseTime_
    ) Ownable(beneficiary) {
        if (token_ == address(0) || oracle_ == address(0)) revert ZeroAddress();
        if (thresholdsUsd.length != amounts.length) revert LengthMismatch();
        token = IERC20(token_);
        oracle = oracle_;
        fallbackReleaseTime = fallbackReleaseTime_;
        for (uint256 i = 0; i < amounts.length; i++) {
            milestones.push(Milestone({treasuryUsdThreshold: thresholdsUsd[i], amount: amounts[i], released: false}));
        }
    }

    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    /// @notice Oracle posts the cumulative USD swept to the treasury. Only ever goes up.
    function postTreasuryUsd(uint256 usd) external {
        if (msg.sender != oracle) revert NotOracle();
        if (usd < treasuryUsd) revert NotMonotonic(treasuryUsd, usd);
        treasuryUsd = usd;
        emit TreasuryUsdPosted(usd);
    }

    /// @notice The oracle can hand over to a new oracle (e.g. a rotated gateway key).
    function setOracle(address newOracle) external {
        if (msg.sender != oracle) revert NotOracle();
        if (newOracle == address(0)) revert ZeroAddress();
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    /// @notice Tokens the owner could release right now.
    function releasable() public view returns (uint256 total) {
        bool fallbackOpen = fallbackReleaseTime != 0 && block.timestamp >= fallbackReleaseTime;
        for (uint256 i = 0; i < milestones.length; i++) {
            Milestone storage m = milestones[i];
            if (!m.released && (fallbackOpen || treasuryUsd >= m.treasuryUsdThreshold)) total += m.amount;
        }
        uint256 bal = token.balanceOf(address(this));
        if (total > bal) total = bal;
    }

    /// @notice Release every milestone whose threshold is met (or everything after the fallback time).
    function release() external onlyOwner returns (uint256 total) {
        bool fallbackOpen = fallbackReleaseTime != 0 && block.timestamp >= fallbackReleaseTime;
        for (uint256 i = 0; i < milestones.length; i++) {
            Milestone storage m = milestones[i];
            if (!m.released && (fallbackOpen || treasuryUsd >= m.treasuryUsdThreshold)) {
                m.released = true;
                total += m.amount;
                emit MilestoneReleased(i, m.amount);
            }
        }
        if (total == 0) revert NothingToRelease();
        uint256 bal = token.balanceOf(address(this));
        if (total > bal) total = bal;
        token.safeTransfer(owner(), total);
    }
}
