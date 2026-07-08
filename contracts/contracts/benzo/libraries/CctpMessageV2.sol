// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

/// @title Circle CCTP V2 message decoder.
/// @notice Fixed-offset decoder for Circle MessageV2 + BurnMessageV2 packed bytes.
/// @dev Offsets match Circle's published V2 contracts:
///      MessageV2 header is 148 bytes; BurnMessageV2 fixed prefix is 228 bytes.
library CctpMessageV2 {
    uint256 internal constant MESSAGE_BODY_INDEX = 148;
    uint256 internal constant BURN_MESSAGE_HOOK_DATA_INDEX = 228;
    uint256 internal constant HOOK_DATA_LENGTH = 96;

    uint256 private constant SOURCE_DOMAIN_INDEX = 4;
    uint256 private constant DESTINATION_DOMAIN_INDEX = 8;
    uint256 private constant NONCE_INDEX = 12;
    uint256 private constant SENDER_INDEX = 44;
    uint256 private constant RECIPIENT_INDEX = 76;
    uint256 private constant DESTINATION_CALLER_INDEX = 108;
    uint256 private constant MIN_FINALITY_THRESHOLD_INDEX = 140;
    uint256 private constant FINALITY_THRESHOLD_EXECUTED_INDEX = 144;

    uint256 private constant BURN_TOKEN_INDEX = 4;
    uint256 private constant MINT_RECIPIENT_INDEX = 36;
    uint256 private constant AMOUNT_INDEX = 68;
    uint256 private constant MESSAGE_SENDER_INDEX = 100;
    uint256 private constant MAX_FEE_INDEX = 132;
    uint256 private constant FEE_EXECUTED_INDEX = 164;
    uint256 private constant EXPIRATION_BLOCK_INDEX = 196;

    struct Header {
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        uint32 minFinalityThreshold;
        uint32 finalityThresholdExecuted;
    }

    struct BurnMessage {
        uint32 version;
        address burnToken;
        address mintRecipient;
        uint256 amount;
        bytes32 messageSender;
        uint256 maxFee;
        uint256 feeExecuted;
        uint256 expirationBlock;
        uint256 mintedAmount;
    }

    error CctpMessageTooShort(uint256 length);
    error CctpBurnMessageTooShort(uint256 length);
    error CctpInvalidAddressBytes32(bytes32 value);
    error CctpFeeExceedsAmount(uint256 amount, uint256 feeExecuted);
    error CctpInvalidHookDataLength(uint256 length);

    function decodeHeader(
        bytes calldata message
    ) internal pure returns (Header memory header) {
        if (message.length < MESSAGE_BODY_INDEX) {
            revert CctpMessageTooShort(message.length);
        }

        header = Header({
            version: _uint32At(message, 0),
            sourceDomain: _uint32At(message, SOURCE_DOMAIN_INDEX),
            destinationDomain: _uint32At(message, DESTINATION_DOMAIN_INDEX),
            nonce: _bytes32At(message, NONCE_INDEX),
            sender: _bytes32At(message, SENDER_INDEX),
            recipient: _bytes32At(message, RECIPIENT_INDEX),
            destinationCaller: _bytes32At(message, DESTINATION_CALLER_INDEX),
            minFinalityThreshold: _uint32At(
                message,
                MIN_FINALITY_THRESHOLD_INDEX
            ),
            finalityThresholdExecuted: _uint32At(
                message,
                FINALITY_THRESHOLD_EXECUTED_INDEX
            )
        });
    }

    function messageBody(
        bytes calldata message
    ) internal pure returns (bytes calldata) {
        if (message.length < MESSAGE_BODY_INDEX) {
            revert CctpMessageTooShort(message.length);
        }

        return message[MESSAGE_BODY_INDEX:];
    }

    function decodeBurnMessage(
        bytes calldata body
    ) internal pure returns (BurnMessage memory burnMessage) {
        if (body.length < BURN_MESSAGE_HOOK_DATA_INDEX) {
            revert CctpBurnMessageTooShort(body.length);
        }

        uint256 amount = _uint256At(body, AMOUNT_INDEX);
        uint256 feeExecuted = _uint256At(body, FEE_EXECUTED_INDEX);
        if (feeExecuted >= amount) {
            revert CctpFeeExceedsAmount(amount, feeExecuted);
        }

        burnMessage = BurnMessage({
            version: _uint32At(body, 0),
            burnToken: _bytes32ToAddress(_bytes32At(body, BURN_TOKEN_INDEX)),
            mintRecipient: _bytes32ToAddress(
                _bytes32At(body, MINT_RECIPIENT_INDEX)
            ),
            amount: amount,
            messageSender: _bytes32At(body, MESSAGE_SENDER_INDEX),
            maxFee: _uint256At(body, MAX_FEE_INDEX),
            feeExecuted: feeExecuted,
            expirationBlock: _uint256At(body, EXPIRATION_BLOCK_INDEX),
            mintedAmount: amount - feeExecuted
        });
    }

    function hookData(
        bytes calldata body
    ) internal pure returns (bytes calldata) {
        if (body.length < BURN_MESSAGE_HOOK_DATA_INDEX) {
            revert CctpBurnMessageTooShort(body.length);
        }

        return body[BURN_MESSAGE_HOOK_DATA_INDEX:];
    }

    function decodeHookData(
        bytes calldata data
    ) internal pure returns (address user, uint256 pkX, uint256 pkY) {
        if (data.length != HOOK_DATA_LENGTH) {
            revert CctpInvalidHookDataLength(data.length);
        }

        return abi.decode(data, (address, uint256, uint256));
    }

    function _uint32At(
        bytes calldata data,
        uint256 offset
    ) private pure returns (uint32 value) {
        assembly ("memory-safe") {
            value := shr(224, calldataload(add(data.offset, offset)))
        }
    }

    function _uint256At(
        bytes calldata data,
        uint256 offset
    ) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := calldataload(add(data.offset, offset))
        }
    }

    function _bytes32At(
        bytes calldata data,
        uint256 offset
    ) private pure returns (bytes32 value) {
        assembly ("memory-safe") {
            value := calldataload(add(data.offset, offset))
        }
    }

    function _bytes32ToAddress(
        bytes32 value
    ) private pure returns (address addr) {
        if (uint256(value) > type(uint160).max) {
            revert CctpInvalidAddressBytes32(value);
        }

        addr = address(uint160(uint256(value)));
    }
}
