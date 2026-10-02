// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title FeeVault
/// @notice Receives the MeshToken transfer fee. The owner (the gateway's sweeper key, or a
///         multisig that delegates to it) withdraws the accrued balance once per epoch.
///         Holds any ERC-20 so a future fee-in-USDC design needs no redeploy.
contract FeeVault is Ownable {
    using SafeERC20 for IERC20;

    event Swept(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Current withdrawable balance of `token` (what the gateway reports as feesThisEpoch).
    function pending(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Transfer the whole balance of `token` to `to`. Returns the amount moved (0 is fine).
    function sweep(address token, address to) external onlyOwner returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    /// @notice Partial withdrawal, for when the sweep is split across several swaps.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }
}
