// SPDX-License-Identifier: MIT
// Vendored from ava-labs/subnet-evm (contracts/interfaces/IFeeManager.sol).
// Copyright (C) Ava Labs, Inc. Distributed under the MIT license these
// Subnet-EVM precompile interface files carry upstream.
pragma solidity 0.8.27;

import {IAllowList} from "./IAllowList.sol";

/// @title IFeeManager
/// @notice Fee Manager precompile at
/// 0x0200000000000000000000000000000000000003. Addresses with the Manager/Admin
/// role may retune the dynamic-fee config at runtime (Benzo keeps this on the
/// cold admin key). `getFeeConfig` is a read used by monitoring and the console
/// Network surface to display the live BGAS fee parameters.
interface IFeeManager is IAllowList {
    /// @notice Emitted when the fee config is changed.
    event FeeConfigChanged(
        address indexed sender,
        uint256 gasLimit,
        uint256 targetBlockRate,
        uint256 minBaseFee,
        uint256 targetGas,
        uint256 baseFeeChangeDenominator,
        uint256 minBlockGasCost,
        uint256 maxBlockGasCost,
        uint256 blockGasCostStep
    );

    /// @notice Set the dynamic-fee configuration (Manager/Admin only).
    function setFeeConfig(
        uint256 gasLimit,
        uint256 targetBlockRate,
        uint256 minBaseFee,
        uint256 targetGas,
        uint256 baseFeeChangeDenominator,
        uint256 minBlockGasCost,
        uint256 maxBlockGasCost,
        uint256 blockGasCostStep
    ) external;

    /// @notice Read the current dynamic-fee configuration.
    function getFeeConfig()
        external
        view
        returns (
            uint256 gasLimit,
            uint256 targetBlockRate,
            uint256 minBaseFee,
            uint256 targetGas,
            uint256 baseFeeChangeDenominator,
            uint256 minBlockGasCost,
            uint256 maxBlockGasCost,
            uint256 blockGasCostStep
        );

    /// @notice Block number at which the fee config was last changed.
    function getFeeConfigLastChangedAt()
        external
        view
        returns (uint256 blockNumber);
}
