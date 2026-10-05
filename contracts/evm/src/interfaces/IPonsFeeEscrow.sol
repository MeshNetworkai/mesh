// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPonsFeeEscrow
/// @notice The subset of the Pons v2 Fee Escrow (0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e on Robinhood
///         Chain) that PonsFeeVault talks to. Creator fees from the bonding curve and, after graduation,
///         from the Uniswap v4 hook accrue here as a balance for `creatorFeeRecipient`.
///
///         ASSUMPTION (docs.ponsfamily.com/docs/v2 + bitquery, no ABI published): the selectors below are
///         taken from the documented function names. Verify them against the escrow on Blockscout before
///         mainnet (scripts/chain/robinhood-testnet-rehearsal.md step 0) — a wrong selector shows up as a
///         revert on the first `pull()`, nothing is lost.
interface IPonsFeeEscrow {
    /// @notice Native-ETH fees claimable by `recipient`.
    function balanceOf(address recipient) external view returns (uint256);

    /// @notice ERC-20 `token` (a quote asset such as USDG) fees claimable by `recipient`.
    function balanceOfToken(address recipient, address token) external view returns (uint256);

    /// @notice Pay out the caller's native-ETH balance to the caller.
    function claim() external;

    /// @notice Pay out the caller's `quoteToken` balance to the caller.
    function claimToken(address quoteToken) external;

    /// @notice The current recipient of `token`'s creator fees hands the role to `newRecipient`.
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}
