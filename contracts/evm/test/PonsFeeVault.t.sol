// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PonsFeeVault} from "../src/PonsFeeVault.sol";
import {IMeshSwapAdapter} from "../src/interfaces/IMeshSwapAdapter.sol";
import {MockPonsEscrow} from "./mocks/MockPonsEscrow.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Adapter that forwards to the mock router, to exercise RouteKind.Adapter.
contract MockAdapter is IMeshSwapAdapter {
    MockSwapRouter immutable router;
    address immutable weth;

    constructor(MockSwapRouter r, address w) {
        router = r;
        weth = w;
    }

    function swap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut, address recipient) external payable returns (uint256) {
        require(assetIn == address(0) && msg.value == amountIn, "eth only in this mock");
        return router.exactInputSingle{value: amountIn}(
            MockSwapRouter.ExactInputSingleParams(weth, assetOut, 500, recipient, amountIn, minOut, 0)
        );
    }
}

/// Recipient that refuses ETH (to test the EthTransferFailed path).
contract Rejector {
    receive() external payable {
        revert("no");
    }
}

contract PonsFeeVaultTest is Test {
    PonsFeeVault vault;
    MockPonsEscrow escrow;
    MockSwapRouter router;
    MockUSDC usdc;
    MockERC20 usdg; // ERC-20 quote asset
    MockERC20 weth; // only an address for the router call
    MockERC20 meshToken; // the Pons-launched token (just for transferCreatorFeeRecipient)

    address owner = makeAddr("owner");
    address sweeper = makeAddr("sweeper");
    address creditPool = makeAddr("creditPool");
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");

    uint256 constant ETH_PRICE = 3_000e6; // router: 3000 USDC per 1e18 wei

    function setUp() public {
        escrow = new MockPonsEscrow();
        usdc = new MockUSDC();
        usdg = new MockERC20("Global Dollar", "USDG", 0, address(this));
        weth = new MockERC20("Wrapped Ether", "WETH", 0, address(this));
        meshToken = new MockERC20("Mesh", "MESH", 1_000_000_000e18, address(this));
        router = new MockSwapRouter(usdc, ETH_PRICE);
        address[] memory quotes = new address[](1);
        quotes[0] = address(usdg);
        vault = new PonsFeeVault(
            PonsFeeVault.InitParams({
                owner: owner,
                sweeper: sweeper,
                escrow: address(escrow),
                creditPool: creditPool,
                treasury: treasury,
                stable: address(usdc),
                weth: address(weth),
                holderShareBps: 5000,
                quoteTokens: quotes
            })
        );
        vm.prank(owner);
        vault.setRoute(address(0), PonsFeeVault.RouteKind.V3Single, address(router), 500, "");
        escrow.setCreatorFeeRecipient(address(meshToken), address(vault));
        vm.deal(address(this), 100 ether);
    }

    function _accrueEth(uint256 amount) internal {
        escrow.accrue{value: amount}(address(vault));
    }

    function _accrueUsdg(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(escrow), amount);
        escrow.accrueToken(address(vault), address(usdg), amount);
    }

    // ------------------------------------------------------------ pull

    function test_pullClaimsEthAndQuoteTokens() public {
        _accrueEth(1 ether);
        _accrueUsdg(500e18);
        (address[] memory assets, uint256[] memory amounts) = vault.pendingInEscrow();
        assertEq(assets.length, 2);
        assertEq(amounts[0], 1 ether);
        assertEq(amounts[1], 500e18);

        vm.prank(sweeper);
        uint256 pulled = vault.pull();
        assertEq(pulled, 1 ether);
        assertEq(address(vault).balance, 1 ether);
        assertEq(usdg.balanceOf(address(vault)), 500e18);
        assertEq(escrow.balanceOf(address(vault)), 0);
        assertEq(escrow.balanceOfToken(address(vault), address(usdg)), 0);
        assertEq(vault.held(address(0)), 1 ether);
        assertEq(vault.held(address(usdg)), 500e18);
    }

    function test_pullWithNothingPendingIsNoop() public {
        vm.prank(sweeper);
        assertEq(vault.pull(), 0);
    }

    function test_pullOnlySweeperOrOwner() public {
        vm.prank(stranger);
        vm.expectRevert(PonsFeeVault.NotSweeper.selector);
        vault.pull();
        vm.prank(owner);
        vault.pull(); // owner may drive the path too
    }

    // ------------------------------------------------------------ sweep (swap)

    function test_sweepEthSwapsAndSplits() public {
        _accrueEth(2 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectEmit(true, false, false, true);
        emit PonsFeeVault.Swept(address(0), 2 ether, 3_000e6, 3_000e6);
        (uint256 grossIn, uint256 holderOut, uint256 treasuryOut) = vault.sweep(address(0), 5_900e6);
        vm.stopPrank();
        assertEq(grossIn, 2 ether);
        assertEq(holderOut, 3_000e6);
        assertEq(treasuryOut, 3_000e6);
        assertEq(usdc.balanceOf(creditPool), 3_000e6);
        assertEq(usdc.balanceOf(treasury), 3_000e6);
        assertEq(address(vault).balance, 0);
    }

    function test_sweepUnevenShare() public {
        vm.prank(owner);
        vault.setHolderShareBps(7000);
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vault.sweep(address(0), 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(creditPool), 2_100e6);
        assertEq(usdc.balanceOf(treasury), 900e6);
    }

    function test_sweepSlippageReverts() public {
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectRevert(); // the mock router reverts "slippage" before our own check
        vault.sweep(address(0), 3_001e6);
        vm.stopPrank();
        assertEq(address(vault).balance, 1 ether); // nothing moved
    }

    function test_sweepStableItselfSkipsSwap() public {
        // Pons paid fees in the stable: no route needed, straight split.
        vm.prank(owner);
        vault.setStable(address(usdc), address(weth));
        usdc.mint(address(vault), 100e6);
        vm.prank(sweeper);
        (uint256 g, uint256 h, uint256 t) = vault.sweep(address(usdc), 0);
        assertEq(g, 100e6);
        assertEq(h, 50e6);
        assertEq(t, 50e6);
        assertEq(usdc.balanceOf(creditPool), 50e6);
    }

    function test_sweepErc20QuoteViaV3Path() public {
        // USDG → (path) → USDC
        bytes memory path = abi.encodePacked(address(usdg), uint24(100), address(usdc));
        vm.prank(owner);
        vault.setRoute(address(usdg), PonsFeeVault.RouteKind.V3Path, address(router), 0, path);
        router.setPrice(1e6); // 1 USDC per 1e18 USDG
        _accrueUsdg(400e18);
        vm.startPrank(sweeper);
        vault.pull();
        (uint256 g, uint256 h, uint256 t) = vault.sweep(address(usdg), 399e6);
        vm.stopPrank();
        assertEq(g, 400e18);
        assertEq(h + t, 400e6);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    function test_sweepViaAdapterRoute() public {
        MockAdapter ad = new MockAdapter(router, address(weth));
        vm.prank(owner);
        vault.setRoute(address(0), PonsFeeVault.RouteKind.Adapter, address(ad), 0, "");
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vault.sweep(address(0), 2_999e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(creditPool) + usdc.balanceOf(treasury), 3_000e6);
    }

    function test_sweepNoRouteReverts() public {
        vm.prank(owner);
        vault.setRoute(address(0), PonsFeeVault.RouteKind.None, address(0), 0, "");
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectRevert(abi.encodeWithSelector(PonsFeeVault.NoRoute.selector, address(0)));
        vault.sweep(address(0), 0);
        vm.stopPrank();
    }

    function test_sweepNothingHeldReverts() public {
        vm.prank(sweeper);
        vm.expectRevert(abi.encodeWithSelector(PonsFeeVault.NothingToSweep.selector, address(0)));
        vault.sweep(address(0), 0);
    }

    function test_sweepWithoutStableReverts() public {
        vm.prank(owner);
        vault.setStable(address(0), address(0));
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectRevert(PonsFeeVault.StableNotSet.selector);
        vault.sweep(address(0), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ sweepRaw

    function test_sweepRawForwardsEthSplit() public {
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectEmit(true, false, false, true);
        emit PonsFeeVault.SweptRaw(address(0), 1 ether, 0.5 ether, 0.5 ether);
        vault.sweepRaw(address(0));
        vm.stopPrank();
        assertEq(creditPool.balance, 0.5 ether);
        assertEq(treasury.balance, 0.5 ether);
    }

    function test_sweepRawForwardsErc20() public {
        _accrueUsdg(10e18);
        vm.startPrank(sweeper);
        vault.pull();
        vault.sweepRaw(address(usdg));
        vm.stopPrank();
        assertEq(usdg.balanceOf(creditPool), 5e18);
        assertEq(usdg.balanceOf(treasury), 5e18);
    }

    function test_sweepRawRejectingRecipientReverts() public {
        Rejector r = new Rejector();
        vm.prank(owner);
        vault.setRecipients(address(r), treasury);
        _accrueEth(1 ether);
        vm.startPrank(sweeper);
        vault.pull();
        vm.expectRevert(PonsFeeVault.EthTransferFailed.selector);
        vault.sweepRaw(address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ pause / roles / config

    function test_pauseBlocksSweeperPath() public {
        _accrueEth(1 ether);
        vm.prank(owner);
        vault.pause();
        vm.startPrank(sweeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pull();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.sweepRaw(address(0));
        vm.stopPrank();
        vm.prank(owner);
        vault.unpause();
        vm.prank(sweeper);
        vault.pull();
    }

    function test_onlyOwnerConfig() public {
        vm.startPrank(sweeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sweeper));
        vault.setSweeper(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sweeper));
        vault.setRecipients(stranger, stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sweeper));
        vault.setRoute(address(0), PonsFeeVault.RouteKind.None, address(0), 0, "");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sweeper));
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sweeper));
        vault.rescue(address(0), sweeper, 1);
        vm.stopPrank();
    }

    function test_configValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(PonsFeeVault.ZeroAddress.selector);
        vault.setSweeper(address(0));
        vm.expectRevert(PonsFeeVault.BadBps.selector);
        vault.setHolderShareBps(10_001);
        vm.expectRevert(PonsFeeVault.ZeroAddress.selector);
        vault.setRoute(address(0), PonsFeeVault.RouteKind.V3Single, address(0), 500, "");
        vault.setSweeper(stranger);
        assertEq(vault.sweeper(), stranger);
        vm.stopPrank();
    }

    function test_constructorValidation() public {
        address[] memory none;
        PonsFeeVault.InitParams memory p = PonsFeeVault.InitParams(owner, sweeper, address(escrow), creditPool, treasury, address(0), address(0), 5000, none);
        p.sweeper = address(0);
        vm.expectRevert(PonsFeeVault.ZeroAddress.selector);
        new PonsFeeVault(p);
        p.sweeper = sweeper;
        p.holderShareBps = 10_001;
        vm.expectRevert(PonsFeeVault.BadBps.selector);
        new PonsFeeVault(p);
    }

    function test_rescueAndTransferRecipient() public {
        vm.deal(address(vault), 1 ether);
        vm.prank(owner);
        vault.rescue(address(0), stranger, 0.25 ether);
        assertEq(stranger.balance, 0.25 ether);

        vm.prank(owner);
        vault.transferFeeRecipient(address(meshToken), treasury);
        assertEq(escrow.creatorFeeRecipient(address(meshToken)), treasury);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        vault.transferOwnership(stranger);
        assertEq(vault.owner(), owner);
        vm.prank(stranger);
        vault.acceptOwnership();
        assertEq(vault.owner(), stranger);
    }

    function test_quoteTokensAndRouteViews() public view {
        address[] memory q = vault.quoteTokens();
        assertEq(q.length, 1);
        assertEq(q[0], address(usdg));
        PonsFeeVault.Route memory r = vault.routeOf(address(0));
        assertEq(uint8(r.kind), uint8(PonsFeeVault.RouteKind.V3Single));
        assertEq(r.router, address(router));
        assertEq(r.fee, 500);
    }
}
