// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title MeshToken ($MESH)
/// @notice Fixed-supply ERC-20 with a transfer fee (in basis points) routed to a FeeVault.
///         - Supply is minted once in the constructor; there is no mint function.
///         - Fee is skipped when either side is exempt (pool, treasury, vault, lock).
///         - Owner can lower/raise the fee up to MAX_FEE_BPS (3%) and can switch it off forever.
///         - Owner is intended to be a multisig; Ownable2Step prevents fat-finger transfers.
contract MeshToken is ERC20, ERC20Permit, Ownable2Step {
    uint16 public constant MAX_FEE_BPS = 300; // 3%
    uint16 public constant BPS = 10_000;

    uint16 public feeBps;
    bool public feeDisabledForever;
    address public feeVault;
    mapping(address => bool) public isFeeExempt;

    event FeeBpsUpdated(uint16 feeBps);
    event FeeDisabledForever();
    event FeeVaultUpdated(address indexed vault);
    event FeeExemptUpdated(address indexed account, bool exempt);
    event FeeTaken(address indexed from, address indexed to, uint256 fee);

    error FeeTooHigh(uint16 feeBps, uint16 max);
    error FeeIsDisabled();
    error ZeroAddress();
    error AllocationExceedsSupply();

    struct InitParams {
        string name;
        string symbol;
        uint256 totalSupply; // in wei (18 decimals)
        uint16 feeBps;
        address owner; // multisig
        address feeVault; // FeeVault contract
        address treasury; // receives totalSupply - teamAllocation
        address teamLock; // TeamLock contract, receives teamAllocation (may be address(0) when teamAllocation == 0)
        uint256 teamAllocation;
    }

    constructor(InitParams memory p) ERC20(p.name, p.symbol) ERC20Permit(p.name) Ownable(p.owner) {
        if (p.feeVault == address(0) || p.treasury == address(0) || p.owner == address(0)) revert ZeroAddress();
        if (p.feeBps > MAX_FEE_BPS) revert FeeTooHigh(p.feeBps, MAX_FEE_BPS);
        if (p.teamAllocation > p.totalSupply) revert AllocationExceedsSupply();
        if (p.teamAllocation > 0 && p.teamLock == address(0)) revert ZeroAddress();

        feeBps = p.feeBps;
        feeVault = p.feeVault;
        emit FeeBpsUpdated(p.feeBps);
        emit FeeVaultUpdated(p.feeVault);

        _setExempt(p.feeVault, true);
        _setExempt(p.treasury, true);
        _setExempt(p.owner, true);
        if (p.teamLock != address(0)) _setExempt(p.teamLock, true);

        _mint(p.treasury, p.totalSupply - p.teamAllocation);
        if (p.teamAllocation > 0) _mint(p.teamLock, p.teamAllocation);
    }

    // ---------------------------------------------------------------- admin

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (feeDisabledForever) revert FeeIsDisabled();
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    /// @notice One-way switch. After this the token is a plain ERC-20 forever.
    function disableFeeForever() external onlyOwner {
        feeDisabledForever = true;
        feeBps = 0;
        emit FeeBpsUpdated(0);
        emit FeeDisabledForever();
    }

    function setFeeVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        feeVault = newVault;
        _setExempt(newVault, true);
        emit FeeVaultUpdated(newVault);
    }

    function setFeeExempt(address account, bool exempt) external onlyOwner {
        _setExempt(account, exempt);
    }

    function setFeeExemptBatch(address[] calldata accounts, bool exempt) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) _setExempt(accounts[i], exempt);
    }

    // ---------------------------------------------------------------- views

    /// @notice Fee that a transfer of `amount` between two non-exempt accounts would pay.
    function feeFor(uint256 amount) public view returns (uint256) {
        return (amount * feeBps) / BPS;
    }

    // ---------------------------------------------------------------- internals

    function _setExempt(address account, bool exempt) internal {
        isFeeExempt[account] = exempt;
        emit FeeExemptUpdated(account, exempt);
    }

    /// @dev OZ5 funnels mint/burn/transfer through _update. Fee only on real transfers.
    function _update(address from, address to, uint256 value) internal override {
        if (
            feeBps == 0 || from == address(0) || to == address(0) || isFeeExempt[from] || isFeeExempt[to]
                || from == feeVault || to == feeVault
        ) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = feeFor(value);
        if (fee > 0) {
            super._update(from, feeVault, fee);
            emit FeeTaken(from, to, fee);
        }
        super._update(from, to, value - fee);
    }
}
