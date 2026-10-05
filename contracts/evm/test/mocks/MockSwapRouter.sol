// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// Test-only stand-in for Uniswap v3 SwapRouter02 + QuoterV2: fixed price, same selectors.
/// price is USDC base units (6 dp) per 1e18 tokenIn, e.g. 20_000 = $0.02 per token.
/// Like the real SwapRouter02, `exactInputSingle` / `exactInput` are payable: ETH sent as msg.value
/// is taken as the input amount (the real router wraps it to WETH9 when tokenIn == WETH9).
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

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
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

    function _pull(address tokenIn, uint256 amountIn) internal returns (uint256 got) {
        if (msg.value > 0) {
            require(msg.value == amountIn, "value != amountIn");
            return msg.value;
        }
        // pull tokenIn (the fee-on-transfer token may deliver less; quote on what arrived)
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        got = IERC20(tokenIn).balanceOf(address(this)) - before;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(p.tokenOut == address(usdc), "tokenOut");
        uint256 got = _pull(p.tokenIn, p.amountIn);
        amountOut = _out(got);
        require(amountOut >= p.amountOutMinimum, "slippage");
        usdc.mint(p.recipient, amountOut);
    }

    /// Multi-hop path: first 20 bytes = tokenIn, last 20 bytes must be USDC. Priced like a single hop.
    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        bytes calldata path = p.path;
        require(path.length >= 43, "path");
        address tokenIn = address(bytes20(path[0:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        require(tokenOut == address(usdc), "tokenOut");
        uint256 got = _pull(tokenIn, p.amountIn);
        amountOut = _out(got);
        require(amountOut >= p.amountOutMinimum, "slippage");
        usdc.mint(p.recipient, amountOut);
    }
}
