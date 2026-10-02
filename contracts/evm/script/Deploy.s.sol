// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MeshToken} from "../src/MeshToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {TeamLock} from "../src/TeamLock.sol";
import {MeshStaking} from "../src/MeshStaking.sol";

/// Deploys FeeVault -> TeamLock -> MeshToken (-> MeshStaking) and writes deployments/<chainId>.json.
///
/// Env (all optional; the signer comes from --private-key / --account):
///   MESH_NAME, MESH_SYMBOL          default "Mesh" / "MESH"
///   MESH_TOTAL_SUPPLY               whole tokens, default 1_000_000_000
///   MESH_FEE_BPS                    default 150 (must match config/tokenomics.json tradeFeeBps)
///   MESH_OWNER                      multisig; default deployer
///   MESH_TREASURY                   default deployer
///   MESH_ORACLE                     TeamLock oracle (gateway sweeper key); default deployer
///   MESH_TEAM                       TeamLock beneficiary; default deployer
///   MESH_TEAM_ALLOCATION            whole tokens, default 100_000_000 (0 skips the lock)
///   MESH_MILESTONES_USD             comma list, default "100000,500000,2000000"
///   MESH_MILESTONE_AMOUNTS          comma list of whole tokens, default "20000000,30000000,50000000"
///   MESH_LOCK_FALLBACK_SECONDS      dead-man switch, default 4 years
///   MESH_STAKING                    "true" also deploys MeshStaking (fee-exempt) and writes `staking`; default false
///   MESH_STAKE_TIER_NAMES           comma list, default "none,silver,gold"   (mirror config/tokenomics.json stakeTiers)
///   MESH_STAKE_MIN                  comma list of whole tokens, default "0,10000,50000"
///   MESH_STAKE_LOCK_DAYS            comma list, default "0,0,30"
///   MESH_STAKE_MULTIPLIER_BPS       comma list, default "10000,15000,20000"
contract Deploy is Script {
    struct Params {
        string name;
        string symbol;
        uint256 totalSupply;
        uint16 feeBps;
        address owner;
        address treasury;
        address oracle;
        address team;
        uint256 teamAllocation;
        uint256[] thresholds;
        uint256[] amounts;
        uint64 fallbackAt;
        bool staking;
        string[] tierNames;
        uint256[] tierMin;
        uint256[] tierLockDays;
        uint256[] tierMultBps;
    }

    function _params(address deployer) internal view returns (Params memory p) {
        p.name = vm.envOr("MESH_NAME", string("Mesh"));
        p.symbol = vm.envOr("MESH_SYMBOL", string("MESH"));
        p.totalSupply = vm.envOr("MESH_TOTAL_SUPPLY", uint256(1_000_000_000)) * 1e18;
        p.feeBps = uint16(vm.envOr("MESH_FEE_BPS", uint256(150)));
        p.owner = vm.envOr("MESH_OWNER", deployer);
        p.treasury = vm.envOr("MESH_TREASURY", deployer);
        p.oracle = vm.envOr("MESH_ORACLE", deployer);
        p.team = vm.envOr("MESH_TEAM", deployer);
        p.teamAllocation = vm.envOr("MESH_TEAM_ALLOCATION", uint256(100_000_000)) * 1e18;
        uint256[] memory defTh = new uint256[](3);
        defTh[0] = 100_000;
        defTh[1] = 500_000;
        defTh[2] = 2_000_000;
        uint256[] memory defAm = new uint256[](3);
        defAm[0] = 20_000_000;
        defAm[1] = 30_000_000;
        defAm[2] = 50_000_000;
        p.thresholds = vm.envOr("MESH_MILESTONES_USD", ",", defTh);
        p.amounts = vm.envOr("MESH_MILESTONE_AMOUNTS", ",", defAm);
        for (uint256 i = 0; i < p.amounts.length; i++) p.amounts[i] *= 1e18;
        p.fallbackAt = uint64(block.timestamp + vm.envOr("MESH_LOCK_FALLBACK_SECONDS", uint256(4 * 365 days)));

        p.staking = vm.envOr("MESH_STAKING", false);
        string[] memory defNames = new string[](3);
        defNames[0] = "none";
        defNames[1] = "silver";
        defNames[2] = "gold";
        uint256[] memory defMin = new uint256[](3);
        defMin[1] = 10_000;
        defMin[2] = 50_000;
        uint256[] memory defLock = new uint256[](3);
        defLock[2] = 30;
        uint256[] memory defMult = new uint256[](3);
        defMult[0] = 10_000;
        defMult[1] = 15_000;
        defMult[2] = 20_000;
        p.tierNames = vm.envOr("MESH_STAKE_TIER_NAMES", ",", defNames);
        p.tierMin = vm.envOr("MESH_STAKE_MIN", ",", defMin);
        p.tierLockDays = vm.envOr("MESH_STAKE_LOCK_DAYS", ",", defLock);
        p.tierMultBps = vm.envOr("MESH_STAKE_MULTIPLIER_BPS", ",", defMult);
        require(
            p.tierNames.length == p.tierMin.length && p.tierMin.length == p.tierLockDays.length && p.tierMin.length == p.tierMultBps.length,
            "stake tier lists must have the same length"
        );
    }

    function _tiers(Params memory p) internal pure returns (MeshStaking.Tier[] memory t) {
        t = new MeshStaking.Tier[](p.tierMin.length);
        for (uint256 i = 0; i < t.length; i++) {
            t[i] = MeshStaking.Tier({
                name: bytes32(bytes(p.tierNames[i])),
                minStake: p.tierMin[i] * 1e18,
                lockDays: uint32(p.tierLockDays[i]),
                multiplierBps: uint32(p.tierMultBps[i])
            });
        }
    }

    function run() external {
        address deployer = msg.sender;
        Params memory p = _params(deployer);

        vm.startBroadcast();
        FeeVault vault = new FeeVault(p.owner);
        address lockAddr;
        if (p.teamAllocation > 0) {
            // TeamLock needs the token address: the deployer's nonce after the lock itself.
            address predictedToken = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
            lockAddr = address(new TeamLock(predictedToken, p.team, p.oracle, p.thresholds, p.amounts, p.fallbackAt));
        }
        MeshToken token = new MeshToken(
            MeshToken.InitParams({
                name: p.name,
                symbol: p.symbol,
                totalSupply: p.totalSupply,
                feeBps: p.feeBps,
                owner: p.owner,
                feeVault: address(vault),
                treasury: p.treasury,
                teamLock: lockAddr,
                teamAllocation: p.teamAllocation
            })
        );
        address stakingAddr;
        if (p.staking) {
            stakingAddr = address(new MeshStaking(address(token), p.owner, _tiers(p)));
            // Staking deposits/withdrawals must not pay the trade fee. Only possible here while the
            // deployer is still the owner; with MESH_OWNER set to a multisig, call setFeeExempt from it.
            if (p.owner == deployer) token.setFeeExempt(stakingAddr, true);
        }
        vm.stopBroadcast();
        if (lockAddr != address(0)) {
            require(address(TeamLock(lockAddr).token()) == address(token), "token address prediction failed");
        }

        console2.log("MeshToken ", address(token));
        console2.log("FeeVault  ", address(vault));
        console2.log("TeamLock  ", lockAddr);
        console2.log("Staking   ", stakingAddr);
        _write(address(token), address(vault), lockAddr, stakingAddr, p);
    }

    function _write(address token, address vault, address lock, address staking, Params memory p) internal {
        string memory json = "deploy";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "token", token);
        vm.serializeAddress(json, "feeVault", vault);
        vm.serializeAddress(json, "teamLock", lock);
        vm.serializeAddress(json, "staking", staking);
        vm.serializeAddress(json, "treasury", p.treasury);
        vm.serializeAddress(json, "owner", p.owner);
        vm.serializeUint(json, "feeBps", p.feeBps);
        vm.serializeUint(json, "deployBlock", block.number);
        string memory out = vm.serializeUint(json, "totalSupply", p.totalSupply);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
