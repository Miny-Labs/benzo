// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {CctpMessageV2} from "../libraries/CctpMessageV2.sol";

contract CctpMessageV2Harness {
    using CctpMessageV2 for bytes;

    function decodeHeader(
        bytes calldata message
    )
        external
        pure
        returns (
            uint32 version,
            uint32 sourceDomain,
            uint32 destinationDomain,
            bytes32 nonce,
            bytes32 sender,
            bytes32 recipient,
            bytes32 destinationCaller,
            uint32 minFinalityThreshold,
            uint32 finalityThresholdExecuted
        )
    {
        CctpMessageV2.Header memory header = message.decodeHeader();
        return (
            header.version,
            header.sourceDomain,
            header.destinationDomain,
            header.nonce,
            header.sender,
            header.recipient,
            header.destinationCaller,
            header.minFinalityThreshold,
            header.finalityThresholdExecuted
        );
    }

    function decodeBurnCore(
        bytes calldata body
    )
        external
        pure
        returns (
            uint32 version,
            address burnToken,
            address mintRecipient,
            uint256 amount,
            bytes32 messageSender
        )
    {
        CctpMessageV2.BurnMessage memory burnMessage = body.decodeBurnMessage();
        return (
            burnMessage.version,
            burnMessage.burnToken,
            burnMessage.mintRecipient,
            burnMessage.amount,
            burnMessage.messageSender
        );
    }

    function decodeBurnFees(
        bytes calldata body
    )
        external
        pure
        returns (
            uint256 maxFee,
            uint256 feeExecuted,
            uint256 expirationBlock,
            uint256 mintedAmount
        )
    {
        CctpMessageV2.BurnMessage memory burnMessage = body.decodeBurnMessage();
        return (
            burnMessage.maxFee,
            burnMessage.feeExecuted,
            burnMessage.expirationBlock,
            burnMessage.mintedAmount
        );
    }

    function burnHookData(
        bytes calldata body
    ) external pure returns (bytes memory) {
        return body.hookData();
    }

    function decodeHookData(
        bytes calldata hookData
    ) external pure returns (address user, uint256 pkX, uint256 pkY) {
        return hookData.decodeHookData();
    }
}
