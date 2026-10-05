// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// Test / testnet-rehearsal stand-in for the Pons v2 Fee Escrow: anyone can `accrue` fees for a recipient
/// (what the Pons hook / curve would do on each trade); recipients `claim()` / `claimToken()` them.
/// Same selectors as IPonsFeeEscrow so PonsFeeVault needs no changes between mock and mainnet.
contract MockPonsEscrow {
    using SafeERC20 for IERC20;

    mapping(address => uint256) private _eth;
    mapping(address => mapping(address => uint256)) private _tokens;
    /// token launched → current creator-fee recipient (for transferCreatorFeeRecipient semantics)
    mapping(address => address) public creatorFeeRecipient;

    event Accrued(address indexed recipient, address indexed asset, uint256 amount);
    event Claimed(address indexed recipient, address indexed asset, uint256 amount);
    event CreatorFeeRecipientTransferred(address indexed token, address indexed from, address indexed to);

    /// @notice Simulate ETH fees accruing for `recipient` (send the ETH along).
    function accrue(address recipient) external payable {
        _eth[recipient] += msg.value;
        emit Accrued(recipient, address(0), msg.value);
    }

    /// @notice Simulate quote-token fees accruing for `recipient` (pulls `amount` from the caller).
    function accrueToken(address recipient, address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _tokens[recipient][token] += amount;
        emit Accrued(recipient, token, amount);
    }

    function setCreatorFeeRecipient(address token, address recipient) external {
        creatorFeeRecipient[token] = recipient;
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return _eth[recipient];
    }

    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return _tokens[recipient][token];
    }

    function claim() external {
        uint256 amount = _eth[msg.sender];
        _eth[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth send");
        emit Claimed(msg.sender, address(0), amount);
    }

    function claimToken(address quoteToken) external {
        uint256 amount = _tokens[msg.sender][quoteToken];
        _tokens[msg.sender][quoteToken] = 0;
        IERC20(quoteToken).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, quoteToken, amount);
    }

    function transferCreatorFeeRecipient(address token, address newRecipient) external {
        require(creatorFeeRecipient[token] == msg.sender, "not recipient");
        creatorFeeRecipient[token] = newRecipient;
        emit CreatorFeeRecipientTransferred(token, msg.sender, newRecipient);
    }
}
