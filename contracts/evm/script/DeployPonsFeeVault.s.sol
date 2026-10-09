// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PonsFeeVault} from "../src/PonsFeeVault.sol";

/// Deploys PonsFeeVault (the Pons `creatorFeeRecipient`) and writes deployments/pons-<chainId>.json.
///
/// Env (signer from --private-key / --account; the deployer only pays gas, it holds no role unless you say so):
///   MESH_OWNER          multisig that owns the vault (default: deployer — move it afterwards)
///   MESH_SWEEPER        gateway hot wallet allowed to call pull()/sweep()  (required)
///   MESH_PONS_ESCROW    Pons Fee Escrow; default 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e (Robinhood mainnet)
///   MESH_CREDIT_POOL    gateway pool wallet (holder share lands here)       (required)
///   MESH_TREASURY       treasury wallet                                     (required)
///   MESH_STABLE         USDG/USDC on this chain (default: none → sweepRaw only until setStable)
///   MESH_WETH           WETH9 on this chain (default: none)
///   MESH_HOLDER_BPS     default 5000 (must match config/tokenomics.json holderShareBps)
///   MESH_QUOTE_TOKENS   comma list of ERC-20 quote assets Pons may pay in (default: empty = ETH only)
///   MESH_SWAP_ROUTER    optional Uniswap v3 SwapRouter02; with MESH_POOL_FEE sets a V3Single ETH→stable route
///   MESH_POOL_FEE       default 500 (ETH→stable pool fee)
///   MESH_QUOTE_POOL_FEES comma list parallel to MESH_QUOTE_TOKENS: v3 pool fee of each quote→stable route (0 = none)
contract DeployPonsFeeVault is Script {
    function run() external {
        // The broadcaster is only known once broadcasting starts (with --interactive, msg.sender before
        // that is Foundry's placeholder sender, which would end up owning the vault and the deployer's
        // setRoute calls would revert with OwnableUnauthorizedAccount).
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("MESH_OWNER", deployer);
        address sweeper = vm.envAddress("MESH_SWEEPER");
        address escrow = vm.envOr("MESH_PONS_ESCROW", address(0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e));
        address creditPool = vm.envAddress("MESH_CREDIT_POOL");
        address treasury = vm.envAddress("MESH_TREASURY");
        address stable = vm.envOr("MESH_STABLE", address(0));
        address weth = vm.envOr("MESH_WETH", address(0));
        uint256 holderBps = vm.envOr("MESH_HOLDER_BPS", uint256(5000));
        address[] memory quotes = _addrList(vm.envOr("MESH_QUOTE_TOKENS", string("")));
        address router = vm.envOr("MESH_SWAP_ROUTER", address(0));
        uint256 poolFee = vm.envOr("MESH_POOL_FEE", uint256(500));

        PonsFeeVault vault = new PonsFeeVault(
            PonsFeeVault.InitParams({
                owner: deployer, // configure routes first, then hand over below
                sweeper: sweeper,
                escrow: escrow,
                creditPool: creditPool,
                treasury: treasury,
                stable: stable,
                weth: weth,
                holderShareBps: uint16(holderBps),
                quoteTokens: quotes
            })
        );
        if (router != address(0) && stable != address(0) && weth != address(0)) {
            vault.setRoute(address(0), PonsFeeVault.RouteKind.V3Single, router, uint24(poolFee), "");
        }
        // One V3Single route per ERC-20 quote asset (e.g. a tokenised stock the launch is paired with):
        // MESH_QUOTE_POOL_FEES is a comma list parallel to MESH_QUOTE_TOKENS; 0 = no route for that asset.
        if (router != address(0) && stable != address(0) && quotes.length > 0) {
            uint256[] memory fees = _uintList(vm.envOr("MESH_QUOTE_POOL_FEES", string("")));
            for (uint256 i = 0; i < quotes.length && i < fees.length; i++) {
                if (fees[i] != 0) vault.setRoute(quotes[i], PonsFeeVault.RouteKind.V3Single, router, uint24(fees[i]), "");
            }
        }
        if (owner != deployer) vault.transferOwnership(owner); // Ownable2Step: the multisig must acceptOwnership()
        vm.stopBroadcast();

        console2.log("PonsFeeVault", address(vault));
        console2.log("owner (pending if != deployer)", owner);
        console2.log("sweeper", sweeper);
        console2.log("escrow", escrow);

        string memory json = "pons";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "feeVault", address(vault));
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "sweeper", sweeper);
        vm.serializeAddress(json, "ponsEscrow", escrow);
        vm.serializeAddress(json, "creditPool", creditPool);
        vm.serializeAddress(json, "treasury", treasury);
        vm.serializeAddress(json, "stable", stable);
        vm.serializeAddress(json, "weth", weth);
        vm.serializeAddress(json, "swapRouter", router);
        vm.serializeUint(json, "holderShareBps", holderBps);
        string memory out = vm.serializeUint(json, "deployBlock", block.number);
        vm.writeJson(out, string.concat("deployments/pons-", vm.toString(block.chainid), ".json"));
    }

    function _addrList(string memory csv) internal pure returns (address[] memory out) {
        bytes memory b = bytes(csv);
        if (b.length == 0) return out;
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) if (b[i] == ",") n++;
        out = new address[](n);
        uint256 k;
        uint256 start;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bytes memory part = new bytes(i - start);
                for (uint256 j = start; j < i; j++) part[j - start] = b[j];
                out[k++] = vm.parseAddress(string(part));
                start = i + 1;
            }
        }
    }

    function _uintList(string memory csv) internal pure returns (uint256[] memory out) {
        bytes memory b = bytes(csv);
        if (b.length == 0) return out;
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) if (b[i] == ",") n++;
        out = new uint256[](n);
        uint256 k;
        uint256 acc;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                out[k++] = acc;
                acc = 0;
            } else {
                require(b[i] >= "0" && b[i] <= "9", "MESH_QUOTE_POOL_FEES: digits only");
                acc = acc * 10 + (uint8(b[i]) - 48);
            }
        }
    }
}
