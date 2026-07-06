// SPDX-License-Identifier: BSD-3-Clause
// Vendored from ava-labs/subnet-evm (contracts/interfaces/INativeMinter.sol).
pragma solidity 0.8.27;

import {IAllowList} from "./IAllowList.sol";

/// @title INativeMinter
/// @notice Contract Native Minter precompile at
/// 0x0200000000000000000000000000000000000001. Addresses with the Enabled role
/// (Benzo's `benzo-dripper` key) may mint the native gas coin (BGAS) to fund
/// allowlisted wallets. Minting is the only way BGAS enters circulation.
interface INativeMinter is IAllowList {
    /// @notice Emitted when `sender` mints `amount` wei of native coin to `recipient`.
    event NativeCoinMinted(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Mint `amount` (wei) of the native coin to `addr`.
    /// @dev Reverts unless the caller holds the Enabled/Manager/Admin role.
    function mintNativeCoin(address addr, uint256 amount) external;
}
