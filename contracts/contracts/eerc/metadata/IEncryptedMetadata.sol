// SPDX-License-Identifier: Ecosystem
pragma solidity 0.8.27;

// (c) 2025, Ava Labs, Inc. All rights reserved.
// See the file LICENSE for licensing terms.

// types
import {Metadata} from "../types/Types.sol";

/**
 * @title IEncryptedMetadata
 * @notice Interface for encrypted metadata functionality
 * @dev This interface defines the external functions that can be called on contracts
 *      that implement encrypted metadata capabilities.
 */
interface IEncryptedMetadata {
    ///////////////////////////////////////////////////
    ///                    Events                   ///
    ///////////////////////////////////////////////////

    /**
     * @notice Emitted when encrypted metadata is sent between users
     * @param from Address of the sender of the metadata
     * @param to Address of the receiver of the metadata
     * @param metadata Structured metadata containing message details and encrypted content
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
     */
    function sendEncryptedMetadata(address to, bytes calldata message) external;
}
