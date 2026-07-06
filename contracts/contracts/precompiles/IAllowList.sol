// SPDX-License-Identifier: BSD-3-Clause
// Vendored from ava-labs/subnet-evm (contracts/interfaces/IAllowList.sol).
// The Subnet-EVM AllowList precompile stateful contract shares this ABI across
// the deployer-allowlist (0x02..00), native-minter (0x02..01), tx-allowlist
// (0x02..02) and fee-manager (0x02..03) precompiles. Kept as one source so
// Benzo app contracts and CLI scripts import a single interface definition.
pragma solidity 0.8.27;

/// @title IAllowList
/// @notice Role management surface exposed by every Subnet-EVM AllowList
/// precompile. Roles form a total order: None(0) < Enabled(1) < Manager(2) <
/// Admin(3). Only Admin may grant/revoke Admin or Manager; Manager may grant
/// Enabled/None. A caller with no role cannot change the list.
interface IAllowList {
    /// @notice Emitted when `sender` changes `account`'s role from `oldRole`.
    event RoleSet(
        uint256 indexed role,
        address indexed account,
        address indexed sender,
        uint256 oldRole
    );

    /// @notice Grant `addr` the Admin role (Admin-only).
    function setAdmin(address addr) external;

    /// @notice Grant `addr` the Manager role (Admin-only).
    function setManager(address addr) external;

    /// @notice Grant `addr` the Enabled role (Admin or Manager).
    function setEnabled(address addr) external;

    /// @notice Revoke all roles from `addr` (Admin or Manager).
    function setNone(address addr) external;

    /// @notice Read the role assigned to `addr`.
    /// @return role 0=None, 1=Enabled, 2=Manager, 3=Admin.
    function readAllowList(address addr) external view returns (uint256 role);
}
