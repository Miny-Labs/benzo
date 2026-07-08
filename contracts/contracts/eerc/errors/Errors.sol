// (c) 2025, Ava Labs, Inc. All rights reserved.
// See the file LICENSE for licensing terms.

// SPDX-License-Identifier: Ecosystem

pragma solidity 0.8.27;

error UserAlreadyRegistered();
error UserNotRegistered();
error UnauthorizedAccess();
error AuditorKeyNotSet();
error InvalidProof();
error InvalidOperation();
error TransferFailed();
error UnknownToken();
error InvalidChainId();
error InvalidNullifier();
error InvalidSender();
error InvalidRegistrationHash();
error ZeroAddress();
error TokenBlacklisted(address token);
// BENZO PATCH (upstream v0.0.4): raised when an address that is not owner-authorized
// calls depositFor (deposit-on-behalf). See EncryptedERC.authorizedDepositors.
error NotAuthorizedDepositor();
