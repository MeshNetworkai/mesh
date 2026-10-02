// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeshToken} from "../src/MeshToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MeshStaking} from "../src/MeshStaking.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Re-enters stake()/unstake() from the token transfer hook to prove the guard holds.
contract ReentrantToken is MockUSDC {
    MeshStaking public staking;
    bool public attack;

    function setStaking(MeshStaking s) external {
        staking = s;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attack && address(staking) != address(0) && to != address(staking)) {
            attack = false;
            staking.unstake(1);
        }
    }

    function arm() external {
        attack = true;
    }
}

contract MeshStakingTest is Test {
    MeshToken token;
    FeeVault vault;
    MeshStaking staking;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SUPPLY = 1_000_000_000e18;

    function _tiers() internal pure returns (MeshStaking.Tier[] memory t) {
        t = new MeshStaking.Tier[](3);
        t[0] = MeshStaking.Tier({name: "none", minStake: 0, lockDays: 0, multiplierBps: 10_000});
        t[1] = MeshStaking.Tier({name: "silver", minStake: 10_000e18, lockDays: 0, multiplierBps: 15_000});
        t[2] = MeshStaking.Tier({name: "gold", minStake: 50_000e18, lockDays: 30, multiplierBps: 20_000});
    }

    function setUp() public {
        vault = new FeeVault(owner);
        token = new MeshToken(
            MeshToken.InitParams({
                name: "Mesh",
                symbol: "MESH",
                totalSupply: SUPPLY,
                feeBps: 150,
                owner: owner,
                feeVault: address(vault),
                treasury: treasury,
                teamLock: address(0),
                teamAllocation: 0
            })
        );
        staking = new MeshStaking(address(token), owner, _tiers());
        vm.prank(owner);
        token.setFeeExempt(address(staking), true);
        vm.startPrank(treasury);
        token.transfer(alice, 1_000_000e18);
        token.transfer(bob, 1_000_000e18);
        vm.stopPrank();
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
    }

    // ------------------------------------------------------------ tiers

    function test_tiersFromConstructor() public view {
        assertEq(staking.tierCount(), 3);
        MeshStaking.Tier memory g = staking.tier(2);
        assertEq(g.name, bytes32("gold"));
        assertEq(g.minStake, 50_000e18);
        assertEq(g.lockDays, 30);
        assertEq(g.multiplierBps, 20_000);
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 0);
        assertEq(staking.multiplierOf(alice), 10_000);
    }

    function test_constructorRejectsBadTiers() public {
        MeshStaking.Tier[] memory t = _tiers();
        t[0].minStake = 1;
        vm.expectRevert(MeshStaking.FirstTierMustBeZero.selector);
        new MeshStaking(address(token), owner, t);

        t = _tiers();
        t[2].minStake = 5_000e18; // below silver
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.TiersNotAscending.selector, 2));
        new MeshStaking(address(token), owner, t);

        t = _tiers();
        t[1].multiplierBps = 0;
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.ZeroMultiplier.selector, 1));
        new MeshStaking(address(token), owner, t);

        vm.expectRevert(MeshStaking.NoTiers.selector);
        new MeshStaking(address(token), owner, new MeshStaking.Tier[](0));
    }

    // ------------------------------------------------------------ stake

    function test_stakeMovesTokensAndReachesSilver() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit MeshStaking.Staked(alice, 10_000e18, 10_000e18, 0, 0);
        staking.stake(10_000e18, 0);
        assertEq(staking.stakedOf(alice), 10_000e18);
        assertEq(staking.totalStaked(), 10_000e18);
        assertEq(token.balanceOf(address(staking)), 10_000e18);
        assertEq(token.balanceOf(alice), 990_000e18);
        (uint256 idx, MeshStaking.Tier memory t) = staking.tierOf(alice);
        assertEq(idx, 1);
        assertEq(t.multiplierBps, 15_000);
        assertEq(staking.lockEndsAt(alice), 0);
    }

    function test_goldNeedsLockCommitmentNotJustAmount() public {
        vm.prank(alice);
        staking.stake(60_000e18, 0);
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 1, "amount alone is silver");

        // commit to the 30 day lock with a small top-up
        vm.prank(alice);
        staking.stake(1e18, 30);
        (idx,) = staking.tierOf(alice);
        assertEq(idx, 2, "lock commitment unlocks gold");
        assertEq(staking.lockEndsAt(alice), block.timestamp + 30 days);
        assertEq(staking.multiplierOf(alice), 20_000);
    }

    function test_topUpNeverShortensLock() public {
        vm.startPrank(alice);
        staking.stake(50_000e18, 30);
        uint64 end = staking.lockEndsAt(alice);
        vm.warp(block.timestamp + 10 days);
        staking.stake(1e18, 0); // lockDays 0 = keep commitment, do not extend
        assertEq(staking.lockEndsAt(alice), end);
        staking.stake(1e18, 30); // re-committing extends from now
        assertEq(staking.lockEndsAt(alice), block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.LockShorterThanCommitted.selector, uint32(7), uint32(30)));
        staking.stake(1e18, 7);
        vm.stopPrank();
    }

    function test_stakeRejectsZeroAndTooLongLock() public {
        vm.startPrank(alice);
        vm.expectRevert(MeshStaking.ZeroAmount.selector);
        staking.stake(0, 0);
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.LockTooLong.selector, uint32(5000), uint32(1460)));
        staking.stake(1e18, 5000);
        vm.stopPrank();
    }

    function test_feeOnTransferCreditsReceivedAmount() public {
        // un-exempt the staking contract: MeshToken takes 1.5% on the way in
        vm.prank(owner);
        token.setFeeExempt(address(staking), false);
        vm.prank(alice);
        staking.stake(10_000e18, 0);
        uint256 expected = 10_000e18 - (10_000e18 * 150) / 10_000;
        assertEq(staking.stakedOf(alice), expected);
        assertEq(token.balanceOf(address(staking)), expected);
        // 9,850 < 10,000: the fee pushed alice under silver
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 0);
    }

    // ------------------------------------------------------------ unstake

    function test_unstakeWithoutLockIsImmediate() public {
        vm.startPrank(alice);
        staking.stake(10_000e18, 0);
        vm.expectEmit(true, false, false, true);
        emit MeshStaking.Unstaked(alice, 4_000e18, 6_000e18);
        staking.unstake(4_000e18);
        vm.stopPrank();
        assertEq(staking.stakedOf(alice), 6_000e18);
        assertEq(token.balanceOf(alice), 994_000e18);
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 0, "dropped below silver");
    }

    function test_unstakeBlockedUntilLockEnds() public {
        vm.startPrank(alice);
        staking.stake(50_000e18, 30);
        uint64 end = staking.lockEndsAt(alice);
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.StillLocked.selector, end));
        staking.unstake(1e18);
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.StillLocked.selector, end));
        staking.unstake(1e18);
        vm.warp(end);
        staking.unstake(50_000e18);
        vm.stopPrank();
        assertEq(staking.stakedOf(alice), 0);
        assertEq(staking.totalStaked(), 0);
        // position fully cleared: lock commitment gone
        MeshStaking.Position memory p = staking.positionOf(alice);
        assertEq(p.lockDays, 0);
        assertEq(p.lockEndsAt, 0);
    }

    function test_tierKeptAfterLockExpiresWhileStaked() public {
        vm.prank(alice);
        staking.stake(50_000e18, 30);
        vm.warp(block.timestamp + 90 days);
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 2, "gold stays while tokens stay");
        vm.prank(alice);
        staking.unstake(10_000e18);
        (idx,) = staking.tierOf(alice);
        assertEq(idx, 1, "40k with lock commitment is silver");
    }

    function test_unstakeRejectsMoreThanStaked() public {
        vm.startPrank(alice);
        staking.stake(1_000e18, 0);
        vm.expectRevert(abi.encodeWithSelector(MeshStaking.InsufficientStake.selector, 2_000e18, 1_000e18));
        staking.unstake(2_000e18);
        vm.expectRevert(MeshStaking.ZeroAmount.selector);
        staking.unstake(0);
        vm.stopPrank();
    }

    function test_positionsAreIndependent() public {
        vm.prank(alice);
        staking.stake(10_000e18, 0);
        vm.prank(bob);
        staking.stake(60_000e18, 30);
        (uint256 a,) = staking.tierOf(alice);
        (uint256 b,) = staking.tierOf(bob);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(staking.totalStaked(), 70_000e18);
        vm.prank(alice);
        staking.unstake(10_000e18);
        assertEq(staking.stakedOf(bob), 60_000e18);
    }

    // ------------------------------------------------------------ admin

    function test_ownerUpdatesTiersAndPositionsReevaluate() public {
        vm.prank(alice);
        staking.stake(10_000e18, 0);
        (uint256 idx,) = staking.tierOf(alice);
        assertEq(idx, 1);

        MeshStaking.Tier[] memory t = new MeshStaking.Tier[](2);
        t[0] = MeshStaking.Tier({name: "none", minStake: 0, lockDays: 0, multiplierBps: 10_000});
        t[1] = MeshStaking.Tier({name: "silver", minStake: 20_000e18, lockDays: 0, multiplierBps: 12_500});
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit MeshStaking.TiersUpdated(2);
        staking.setTiers(t);
        assertEq(staking.tierCount(), 2);
        (idx,) = staking.tierOf(alice);
        assertEq(idx, 0, "raised threshold drops alice to none");
        assertEq(staking.stakedOf(alice), 10_000e18, "position untouched");
    }

    function test_onlyOwnerSetsTiers() public {
        vm.prank(alice);
        vm.expectRevert();
        staking.setTiers(_tiers());
    }

    function test_recoverTokenNeverTouchesStake() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(staking), 5e6);
        vm.startPrank(owner);
        staking.recoverToken(address(usdc), owner, 5e6);
        assertEq(usdc.balanceOf(owner), 5e6);
        vm.expectRevert(MeshStaking.CannotRecoverStakeToken.selector);
        staking.recoverToken(address(token), owner, 1);
        vm.stopPrank();
    }

    function test_noOwnerPathMovesStakedMesh() public {
        vm.prank(alice);
        staking.stake(10_000e18, 0);
        // no withdraw/sweep selector exists
        (bool ok,) = address(staking).call(abi.encodeWithSignature("withdraw(address,uint256)", owner, 1));
        assertFalse(ok);
        (ok,) = address(staking).call(abi.encodeWithSignature("sweep(address,address)", address(token), owner));
        assertFalse(ok);
        assertEq(token.balanceOf(address(staking)), 10_000e18);
    }

    // ------------------------------------------------------------ reentrancy

    function test_reentrancyGuardOnUnstake() public {
        ReentrantToken rt = new ReentrantToken();
        MeshStaking s = new MeshStaking(address(rt), owner, _tiers());
        rt.setStaking(s);
        rt.mint(address(this), 100e18);
        rt.approve(address(s), type(uint256).max);
        s.stake(100e18, 0);
        rt.arm();
        // unstake → transfer → hook re-enters unstake → ReentrancyGuardReentrantCall bubbles up
        vm.expectRevert();
        s.unstake(50e18);
        assertEq(s.stakedOf(address(this)), 100e18, "nothing moved");
    }
}
