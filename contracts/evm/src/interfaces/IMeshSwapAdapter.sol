// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMeshSwapAdapter
/// @notice Escape hatch for DEXes PonsFeeVault does not speak natively (Uniswap v4 universal router,
///         an aggregator...). A tiny adapter contract implements this one function; the vault approves /
///         sends `amountIn` of `assetIn` (address(0) = native ETH, sent as msg.value) and expects at least
///         `minOut` of `assetOut` delivered to `recipient`.
interface IMeshSwapAdapter {
    function swap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 amountOut);
}
