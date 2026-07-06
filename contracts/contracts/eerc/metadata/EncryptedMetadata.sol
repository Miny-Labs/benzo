// (c) 2025, Ava Labs, Inc. All rights reserved.
// See the file LICENSE for licensing terms.

// SPDX-License-Identifier: Ecosystem
pragma solidity 0.8.27;

// types
import {Metadata} from "../types/Types.sol";

/**
 * @title EncryptedMetadata
 * @notice A contract that handles encrypted metadata functionality for privacy-preserving operations
 * @dev This contract provides the core functionality for creating and emitting encrypted metadata
 *      associated with various operations. It can be inherited by other contracts that need
 *      metadata capabilities.
 *
 * Key features:
 * - Encrypted metadata creation and emission
 * - Structured metadata with sender, receiver, type, and encrypted message
 * - Privacy-preserving message transmission
 * - Reusable across different contract types
 */
contract EncryptedMetadata {
    ///////////////////////////////////////////////////
    ///                    Events                   ///
    ///////////////////////////////////////////////////

    /**
     * @notice Emitted when encrypted metadata is sent between users
     * @param from Address of the sender of the metadata
     * @param to Address of the receiver of the metadata
     * @param metadata Structured metadata containing message details and encrypted content
     * @dev This event is emitted when encrypted metadata is transmitted between registered users.
     *      The metadata includes the sender, receiver, message type, and encrypted message content.
     *      Only the intended receiver can decrypt the message using their private key.
     */
    event PrivateMessage(
        address indexed from,
        address indexed to,
        Metadata metadata
    );

    ///////////////////////////////////////////////////
    ///                   External                  ///
    ///////////////////////////////////////////////////

    /**
     * @notice Sends encrypted metadata to a registered user
     * @param to Address of the recipient of the encrypted metadata
     * @param message Encrypted message bytes to be sent
     * @dev This function allows any registered user to send encrypted metadata to another
     *      registered user. The message should be encrypted with the recipient's public key
     *      before calling this function.
     *
     * The function:
     *      1. Validates that both sender and recipient are registered users
     *      2. Creates a structured metadata object
     *      3. Emits the PrivateMessage event with the metadata
     *
     * Requirements:
     * - Caller must be a registered user
     * - Recipient must be a registered user
     * - Message should be properly encrypted with recipient's public key
     *
     */
    function _sendEncryptedMetadata(
        address to,
        bytes calldata message
    ) internal virtual {
        // Create and emit metadata
        address messageFrom = msg.sender;
        Metadata memory metadata = _createMetadata(
            messageFrom,
            to,
            "MESSAGE",
            message
        );
        emit PrivateMessage(messageFrom, to, metadata);
    }

    ///////////////////////////////////////////////////
    ///                   Internal                  ///
    ///////////////////////////////////////////////////

    /**
     * @notice Emits metadata for operation-specific events
     * @param from Address of the sender
     * @param to Address of the recipient
     * @param messageType Type of the operation (e.g., "PRIVATE_MINT", "PRIVATE_BURN")
     * @param message Encrypted message content
     * @dev This function is used internally by inheriting contracts to emit metadata
     *      for specific operations. It creates the metadata structure and emits the
     *      PrivateMessage event.
     */
    function _emitMetadata(
        address from,
        address to,
        string memory messageType,
        bytes memory message
    ) internal {
        if (message.length > 0) {
            Metadata memory metadata = _createMetadata(
                from,
                to,
                messageType,
                message
            );
            emit PrivateMessage(from, to, metadata);
        }
    }

    /**
     * @notice Creates a structured metadata object
     * @param messageFrom Address of the sender of the metadata
     * @param messageTo Address of the recipient of the metadata
     * @param messageType Type/category of the message (e.g., "PRIVATE_MINT", "TRANSFER", etc.)
     * @param encryptedMsg Encrypted message content
     * @return metadata Structured Metadata object containing all message details
     * @dev This internal function creates a standardized metadata structure that includes
     *      sender, recipient, message type, and encrypted content. The message type helps
     *      recipients categorize and process different types of metadata appropriately.
     */
    function _createMetadata(
        address messageFrom,
        address messageTo,
        string memory messageType,
        bytes memory encryptedMsg
    ) internal pure returns (Metadata memory metadata) {
        metadata.messageFrom = messageFrom;
        metadata.messageTo = messageTo;
        metadata.messageType = messageType;
        metadata.encryptedMsg = encryptedMsg;
        return metadata;
    }
}
