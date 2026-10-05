// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test-only plain 18-decimal ERC-20 with open mint: stands in for the Pons-minted token ("MESH-test")
/// in the testnet rehearsal and for a WETH9-shaped quote token in unit tests.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 initialSupply, address to) ERC20(name_, symbol_) {
        if (initialSupply > 0) _mint(to, initialSupply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
