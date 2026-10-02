// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeshToken} from "../src/MeshToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {TeamLock} from "../src/TeamLock.sol";

contract MeshTokenTest is Test {
    MeshToken token;
    FeeVault vault;
    TeamLock lock;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address team = makeAddr("team");
    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address pool = makeAddr("pool");

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant TEAM = 100_000_000e18;

    function setUp() public {
        vault = new FeeVault(owner);
        // lock needs the token address; precompute via nonce
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        uint256[] memory th = new uint256[](3);
        th[0] = 100_000;
        th[1] = 500_000;
        th[2] = 2_000_000;
        uint256[] memory am = new uint256[](3);
        am[0] = 20_000_000e18;
        am[1] = 30_000_000e18;
        am[2] = 50_000_000e18;
        lock = new TeamLock(predicted, team, oracle, th, am, uint64(block.timestamp + 4 * 365 days));
        token = new MeshToken(
            MeshToken.InitParams({
                name: "Mesh",
                symbol: "MESH",
                totalSupply: SUPPLY,
                feeBps: 150,
                owner: owner,
                feeVault: address(vault),
                treasury: treasury,
                teamLock: address(lock),
                teamAllocation: TEAM
            })
        );
        assertEq(address(lock.token()), address(token), "lock points at token");
        vm.prank(treasury);
        token.transfer(alice, 1_000_000e18); // treasury exempt: no fee
    }

    function test_supplyAndAllocation() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(lock)), TEAM);
        assertEq(token.balanceOf(treasury), SUPPLY - TEAM - 1_000_000e18);
        assertEq(token.balanceOf(alice), 1_000_000e18);
    }

    function test_feeOnPlainTransfer() public {
        vm.prank(alice);
        token.transfer(bob, 10_000e18);
        uint256 fee = (10_000e18 * 150) / 10_000;
        assertEq(token.balanceOf(bob), 10_000e18 - fee);
        assertEq(token.balanceOf(address(vault)), fee);
        assertEq(vault.pending(address(token)), fee);
    }

    function test_exemptSkipsFee() public {
        vm.prank(owner);
        token.setFeeExempt(pool, true);
        vm.prank(alice);
        token.transfer(pool, 10_000e18);
        assertEq(token.balanceOf(pool), 10_000e18);
        assertEq(token.balanceOf(address(vault)), 0);
        vm.prank(pool);
        token.transfer(bob, 5_000e18);
        assertEq(token.balanceOf(bob), 5_000e18);
    }

    function test_transferFromAlsoPaysFee() public {
        vm.prank(alice);
        token.approve(bob, 1_000e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 1_000e18);
        assertEq(token.balanceOf(bob), 1_000e18 - 15e18);
        assertEq(token.balanceOf(address(vault)), 15e18);
    }

    function test_setFeeCapped() public {
        vm.startPrank(owner);
        token.setFeeBps(300);
        assertEq(token.feeBps(), 300);
        vm.expectRevert(abi.encodeWithSelector(MeshToken.FeeTooHigh.selector, uint16(301), uint16(300)));
        token.setFeeBps(301);
        vm.stopPrank();
    }

    function test_onlyOwnerSetsFee() public {
        vm.prank(alice);
        vm.expectRevert();
        token.setFeeBps(10);
    }

    function test_disableFeeForever() public {
        vm.startPrank(owner);
        token.disableFeeForever();
        assertTrue(token.feeDisabledForever());
        assertEq(token.feeBps(), 0);
        vm.expectRevert(MeshToken.FeeIsDisabled.selector);
        token.setFeeBps(50);
        vm.stopPrank();
        vm.prank(alice);
        token.transfer(bob, 100e18);
        assertEq(token.balanceOf(bob), 100e18);
    }

    function test_constructorRejectsHighFee() public {
        vm.expectRevert(abi.encodeWithSelector(MeshToken.FeeTooHigh.selector, uint16(301), uint16(300)));
        new MeshToken(
            MeshToken.InitParams({
                name: "x",
                symbol: "x",
                totalSupply: 1e18,
                feeBps: 301,
                owner: owner,
                feeVault: address(vault),
                treasury: treasury,
                teamLock: address(0),
                teamAllocation: 0
            })
        );
    }

    function test_noMintFunction() public {
        // selector of mint(address,uint256) must not exist
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        assertFalse(ok);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_vaultSweepOnlyOwner() public {
        vm.prank(alice);
        token.transfer(bob, 10_000e18);
        uint256 fee = token.balanceOf(address(vault));
        vm.prank(alice);
        vm.expectRevert();
        vault.sweep(address(token), alice);
        vm.prank(owner);
        uint256 got = vault.sweep(address(token), owner);
        assertEq(got, fee);
        assertEq(token.balanceOf(owner), fee); // owner is exempt so no fee on the sweep itself
        assertEq(vault.pending(address(token)), 0);
    }

    function test_vaultSweepEmptyIsNoop() public {
        vm.prank(owner);
        assertEq(vault.sweep(address(token), owner), 0);
    }

    // ------------------------------------------------------------- TeamLock

    function test_lockNothingBeforeMilestone() public {
        assertEq(lock.releasable(), 0);
        vm.prank(team);
        vm.expectRevert(TeamLock.NothingToRelease.selector);
        lock.release();
    }

    function test_lockReleasesByMilestone() public {
        vm.prank(oracle);
        lock.postTreasuryUsd(120_000);
        assertEq(lock.releasable(), 20_000_000e18);
        vm.prank(team);
        uint256 got = lock.release();
        assertEq(got, 20_000_000e18);
        assertEq(token.balanceOf(team), 20_000_000e18); // lock exempt: no fee
        // second call: nothing new
        vm.prank(team);
        vm.expectRevert(TeamLock.NothingToRelease.selector);
        lock.release();
        // cross two milestones at once
        vm.prank(oracle);
        lock.postTreasuryUsd(2_500_000);
        vm.prank(team);
        assertEq(lock.release(), 80_000_000e18);
        assertEq(token.balanceOf(address(lock)), 0);
    }

    function test_lockOracleOnlyAndMonotonic() public {
        vm.prank(alice);
        vm.expectRevert(TeamLock.NotOracle.selector);
        lock.postTreasuryUsd(1);
        vm.startPrank(oracle);
        lock.postTreasuryUsd(10);
        vm.expectRevert(abi.encodeWithSelector(TeamLock.NotMonotonic.selector, 10, 5));
        lock.postTreasuryUsd(5);
        vm.stopPrank();
    }

    function test_lockOnlyBeneficiaryReleases() public {
        vm.prank(oracle);
        lock.postTreasuryUsd(10_000_000);
        vm.prank(alice);
        vm.expectRevert();
        lock.release();
    }

    function test_lockFallbackTime() public {
        vm.warp(block.timestamp + 4 * 365 days);
        assertEq(lock.releasable(), TEAM);
        vm.prank(team);
        assertEq(lock.release(), TEAM);
    }

    function testFuzz_feeNeverExceedsBps(uint96 amount) public {
        vm.assume(amount <= 1_000_000e18);
        uint256 before = token.balanceOf(address(vault));
        vm.prank(alice);
        token.transfer(bob, amount);
        uint256 fee = token.balanceOf(address(vault)) - before;
        assertLe(fee, (uint256(amount) * 150) / 10_000);
        assertEq(token.balanceOf(bob) + fee, amount);
    }
}
