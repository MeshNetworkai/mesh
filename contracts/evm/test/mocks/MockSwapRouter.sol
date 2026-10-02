// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// Test-only stand-in for Uniswap v3 SwapRouter02 + QuoterV2: fixed price, same selectors.
/// price is USDC base units (6 dp) per 1e18 tokenIn, e.g. 20_000 = $0.02 per token.
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    MockUSDC public immutable usdc;
    uint256 public price;

    constructor(MockUSDC usdc_, uint256 price_) {
        usdc = usdc_;
        price = price_;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function _out(uint256 amountIn) internal view returns (uint256) {
        return (amountIn * price) / 1e18;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata p)
        external
        view
        returns (uint256 amountOut, uint160, uint32, uint256)
    {
        return (_out(p.amountIn), 0, 0, 0);
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(p.tokenOut == address(usdc), "tokenOut");
        // pull tokenIn (the fee-on-transfer token may deliver less; quote on what arrived)
        uint256 before = IERC20(p.tokenIn).balanceOf(address(this));
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 got = IERC20(p.tokenIn).balanceOf(address(this)) - before;
        amountOut = _out(got);
        require(amountOut >= p.amountOutMinimum, "slippage");
        usdc.mint(p.recipient, amountOut);
    }
}
