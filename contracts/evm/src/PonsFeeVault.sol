// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsFeeEscrow} from "./interfaces/IPonsFeeEscrow.sol";
import {IMeshSwapAdapter} from "./interfaces/IMeshSwapAdapter.sol";

/// @dev Uniswap v3 SwapRouter02 (no deadline in the struct). `exactInputSingle` is payable: with
///      tokenIn == WETH9 and msg.value == amountIn the router wraps the ETH itself.
interface ISwapRouter02 {
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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title PonsFeeVault
/// @notice The `creatorFeeRecipient` of a token launched on Pons (Robinhood Chain). Pons pays creator
///         fees (the creator's share of the fixed trading fee plus the whole optional creator tax) into
///         its Fee Escrow as a balance for this contract. Once an epoch the gateway's hot wallet
///         (`sweeper`) calls `pull()` to claim them here, then `sweep()` to convert each asset to the
///         configured stablecoin and split it: `holderShareBps` to `creditPool` (the gateway's pool
///         wallet, which becomes AI credits), the rest to `treasury`. When the chain has no stable route
///         yet, `sweepRaw()` forwards the asset itself with the same split.
///
///         Roles: `owner` (multisig) sets addresses, routes, shares and the pause; `sweeper` may only
///         move funds along the configured path (escrow → here → creditPool / treasury). Neither role
///         can send funds anywhere else except the owner's `rescue()`.
///
///         Not a MeshToken contract: the token itself is minted by the Pons factory (plain ERC-20).
contract PonsFeeVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice address(0) stands for native ETH everywhere in this contract.
    address public constant ETH = address(0);

    enum RouteKind {
        None, // no route: only sweepRaw works for this asset
        V3Single, // SwapRouter02.exactInputSingle(assetIn → stable) at `fee`
        V3Path, // SwapRouter02.exactInput(path) where path starts with assetIn (WETH for ETH) and ends with stable
        Adapter // IMeshSwapAdapter at `router`
    }

    struct Route {
        RouteKind kind;
        address router;
        uint24 fee;
        bytes path;
    }

    IPonsFeeEscrow public immutable escrow;
    address public sweeper;
    address public creditPool;
    address public treasury;
    /// @notice USDC-equivalent the sweep settles in (USDG / USDC on Robinhood Chain). Zero until a stable exists.
    address public stable;
    /// @notice WETH9 on this chain; what SwapRouter02 needs as tokenIn when the asset is ETH.
    address public weth;
    uint16 public holderShareBps;
    /// @notice Quote assets Pons may pay fees in (ETH is always claimed; this list is the ERC-20 ones, e.g. USDG).
    address[] private _quoteTokens;
    mapping(address => Route) private _routes;

    event SweeperUpdated(address indexed sweeper);
    event RecipientsUpdated(address indexed creditPool, address indexed treasury);
    event SharesUpdated(uint16 holderShareBps);
    event StableUpdated(address indexed stable, address indexed weth);
    event QuoteTokensUpdated(address[] tokens);
    event RouteUpdated(address indexed asset, RouteKind kind, address router, uint24 fee, bytes path);
    event Pulled(address indexed asset, uint256 amount);
    /// @notice One sweep of `asset`. Swapped: holderOut/treasuryOut are in `stable` units. Raw: in `asset` units.
    event Swept(address indexed asset, uint256 grossIn, uint256 holderOut, uint256 treasuryOut);
    event SweptRaw(address indexed asset, uint256 grossIn, uint256 holderOut, uint256 treasuryOut);
    event Rescued(address indexed asset, address indexed to, uint256 amount);

    error NotSweeper();
    error ZeroAddress();
    error BadBps();
    error NoRoute(address asset);
    error NothingToSweep(address asset);
    error Slippage(uint256 out, uint256 minOut);
    error EthTransferFailed();
    error StableNotSet();

    struct InitParams {
        address owner;
        address sweeper;
        address escrow;
        address creditPool;
        address treasury;
        address stable; // may be zero: sweepRaw only until set
        address weth; // may be zero until a v3 route is configured
        uint16 holderShareBps;
        address[] quoteTokens;
    }

    constructor(InitParams memory p) Ownable(p.owner) {
        if (p.sweeper == address(0) || p.escrow == address(0) || p.creditPool == address(0) || p.treasury == address(0)) revert ZeroAddress();
        if (p.holderShareBps > 10_000) revert BadBps();
        escrow = IPonsFeeEscrow(p.escrow);
        sweeper = p.sweeper;
        creditPool = p.creditPool;
        treasury = p.treasury;
        stable = p.stable;
        weth = p.weth;
        holderShareBps = p.holderShareBps;
        _quoteTokens = p.quoteTokens;
    }

    modifier onlySweeper() {
        if (msg.sender != sweeper && msg.sender != owner()) revert NotSweeper();
        _;
    }

    /// @dev Escrow `claim()` pays native ETH here; swap routers may refund dust.
    receive() external payable {}

    // ------------------------------------------------------------------ owner config

    function setSweeper(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        sweeper = s;
        emit SweeperUpdated(s);
    }

    function setRecipients(address creditPool_, address treasury_) external onlyOwner {
        if (creditPool_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        creditPool = creditPool_;
        treasury = treasury_;
        emit RecipientsUpdated(creditPool_, treasury_);
    }

    function setHolderShareBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert BadBps();
        holderShareBps = bps;
        emit SharesUpdated(bps);
    }

    function setStable(address stable_, address weth_) external onlyOwner {
        stable = stable_;
        weth = weth_;
        emit StableUpdated(stable_, weth_);
    }

    function setQuoteTokens(address[] calldata tokens) external onlyOwner {
        _quoteTokens = tokens;
        emit QuoteTokensUpdated(tokens);
    }

    /// @notice Configure how `asset` (ETH = address(0)) is converted to `stable`. `kind == None` removes the route.
    function setRoute(address asset, RouteKind kind, address router, uint24 fee, bytes calldata path) external onlyOwner {
        if (kind != RouteKind.None && router == address(0)) revert ZeroAddress();
        _routes[asset] = Route({kind: kind, router: router, fee: fee, path: path});
        emit RouteUpdated(asset, kind, router, fee, path);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Hand the Pons creator-fee recipient role for `token` to `newRecipient` (migration / wind-down).
    function transferFeeRecipient(address token, address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        escrow.transferCreatorFeeRecipient(token, newRecipient);
    }

    /// @notice Owner-only recovery of anything stuck here (wrong token sent, route broken for weeks...).
    function rescue(address asset, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _send(asset, to, amount);
        emit Rescued(asset, to, amount);
    }

    // ------------------------------------------------------------------ views

    function quoteTokens() external view returns (address[] memory) {
        return _quoteTokens;
    }

    function routeOf(address asset) external view returns (Route memory) {
        return _routes[asset];
    }

    /// @notice Fees waiting in the Pons escrow for this vault: ETH plus each configured quote token.
    function pendingInEscrow() external view returns (address[] memory assets, uint256[] memory amounts) {
        uint256 n = _quoteTokens.length;
        assets = new address[](n + 1);
        amounts = new uint256[](n + 1);
        assets[0] = ETH;
        amounts[0] = escrow.balanceOf(address(this));
        for (uint256 i = 0; i < n; i++) {
            assets[i + 1] = _quoteTokens[i];
            amounts[i + 1] = escrow.balanceOfToken(address(this), _quoteTokens[i]);
        }
    }

    /// @notice What `sweep` / `sweepRaw` would move right now for `asset` (already pulled from escrow).
    function held(address asset) public view returns (uint256) {
        return asset == ETH ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    // ------------------------------------------------------------------ sweeper path

    /// @notice Claim every pending balance from the Pons escrow into this contract. Safe to call with nothing pending.
    function pull() external onlySweeper whenNotPaused nonReentrant returns (uint256 ethPulled) {
        ethPulled = escrow.balanceOf(address(this));
        if (ethPulled > 0) {
            escrow.claim();
            emit Pulled(ETH, ethPulled);
        }
        uint256 n = _quoteTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address t = _quoteTokens[i];
            uint256 bal = escrow.balanceOfToken(address(this), t);
            if (bal > 0) {
                escrow.claimToken(t);
                emit Pulled(t, bal);
            }
        }
    }

    /// @notice Convert the whole held balance of `asset` to `stable` via its route and split it. `minOut` is the
    ///         slippage floor in `stable` units (0 = caller accepts the route's price). When `asset == stable`
    ///         no swap happens and the split is applied directly.
    function sweep(address asset, uint256 minOut) external onlySweeper whenNotPaused nonReentrant returns (uint256 grossIn, uint256 holderOut, uint256 treasuryOut) {
        if (stable == address(0)) revert StableNotSet();
        grossIn = held(asset);
        if (grossIn == 0) revert NothingToSweep(asset);
        uint256 out;
        if (asset == stable) {
            out = grossIn;
        } else {
            out = _swapToStable(asset, grossIn, minOut);
        }
        (holderOut, treasuryOut) = _split(stable, out);
        emit Swept(asset, grossIn, holderOut, treasuryOut);
    }

    /// @notice No-swap variant: forward the held `asset` itself, split holder / treasury. For chains without a
    ///         stable route yet (the gateway values the amount off-chain with a price feed).
    function sweepRaw(address asset) external onlySweeper whenNotPaused nonReentrant returns (uint256 grossIn, uint256 holderOut, uint256 treasuryOut) {
        grossIn = held(asset);
        if (grossIn == 0) revert NothingToSweep(asset);
        (holderOut, treasuryOut) = _split(asset, grossIn);
        emit SweptRaw(asset, grossIn, holderOut, treasuryOut);
    }

    // ------------------------------------------------------------------ internals

    function _swapToStable(address asset, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        Route memory r = _routes[asset];
        if (r.kind == RouteKind.None) revert NoRoute(asset);
        uint256 before = IERC20(stable).balanceOf(address(this));
        if (r.kind == RouteKind.Adapter) {
            if (asset == ETH) {
                IMeshSwapAdapter(r.router).swap{value: amountIn}(ETH, stable, amountIn, minOut, address(this));
            } else {
                IERC20(asset).forceApprove(r.router, amountIn);
                IMeshSwapAdapter(r.router).swap(asset, stable, amountIn, minOut, address(this));
            }
        } else {
            uint256 value = 0;
            address tokenIn = asset;
            if (asset == ETH) {
                if (weth == address(0)) revert NoRoute(asset);
                tokenIn = weth;
                value = amountIn;
            } else {
                IERC20(asset).forceApprove(r.router, amountIn);
            }
            if (r.kind == RouteKind.V3Single) {
                ISwapRouter02(r.router).exactInputSingle{value: value}(
                    ISwapRouter02.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: stable,
                        fee: r.fee,
                        recipient: address(this),
                        amountIn: amountIn,
                        amountOutMinimum: minOut,
                        sqrtPriceLimitX96: 0
                    })
                );
            } else {
                ISwapRouter02(r.router).exactInput{value: value}(
                    ISwapRouter02.ExactInputParams({path: r.path, recipient: address(this), amountIn: amountIn, amountOutMinimum: minOut})
                );
            }
        }
        out = IERC20(stable).balanceOf(address(this)) - before;
        if (out < minOut) revert Slippage(out, minOut);
    }

    function _split(address asset, uint256 amount) internal returns (uint256 holderOut, uint256 treasuryOut) {
        holderOut = (amount * holderShareBps) / 10_000;
        treasuryOut = amount - holderOut;
        if (holderOut > 0) _send(asset, creditPool, holderOut);
        if (treasuryOut > 0) _send(asset, treasury, treasuryOut);
    }

    function _send(address asset, address to, uint256 amount) internal {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
