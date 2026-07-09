// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {EncryptedERC} from "../eerc/EncryptedERC.sol";
import {Registrar} from "../eerc/Registrar.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";
import {CctpMessageV2} from "./libraries/CctpMessageV2.sol";

/// @title Benzo CCTP auto-deposit router.
/// @notice Receives Circle CCTP V2 mints and deposits the minted token into a registered user's eERC balance.
contract BenzoCCTPRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CctpMessageV2 for bytes;

    IMessageTransmitterV2 public immutable messageTransmitter;
    EncryptedERC public immutable eerc;
    Registrar public immutable registrar;

    mapping(address token => bool allowed) public allowedTokens;
    mapping(address remoteToken => address localToken) public remoteTokenToLocal;
    mapping(address relayer => bool allowed) public relayers;

    event AllowedTokenSet(address indexed token, bool allowed);
    event RemoteTokenSet(address indexed remoteToken, address indexed localToken);
    event RelayerSet(address indexed relayer, bool allowed);
    event OnrampSettled(
        address indexed user,
        address indexed token,
        uint256 amount,
        bytes32 indexed cctpNonce
    );
    event Rescue(address indexed token, address indexed to, uint256 amount);
    event MessageReceivedForRescue(address indexed by);

    error ZeroAddress();
    error NotRelayer(address caller);
    error MessageReceiveFailed();
    error TokenNotAllowed(address token);
    error MintRecipientMismatch(address expected, address actual);
    error RecipientNotRegistered(address user);
    error PublicKeyMismatch(
        address user,
        uint256 expectedPkX,
        uint256 expectedPkY,
        uint256 actualPkX,
        uint256 actualPkY
    );

    constructor(
        IMessageTransmitterV2 messageTransmitter_,
        EncryptedERC converter_,
        Registrar registrar_
    ) Ownable(msg.sender) {
        if (
            address(messageTransmitter_) == address(0) ||
            address(converter_) == address(0) ||
            address(registrar_) == address(0)
        ) {
            revert ZeroAddress();
        }

        messageTransmitter = messageTransmitter_;
        eerc = converter_;
        registrar = registrar_;
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) {
            revert ZeroAddress();
        }

        allowedTokens[token] = allowed;
        emit AllowedTokenSet(token, allowed);
    }

    function setRemoteToken(
        address remoteToken,
        address localToken
    ) external onlyOwner {
        if (remoteToken == address(0)) {
            revert ZeroAddress();
        }

        remoteTokenToLocal[remoteToken] = localToken;
        emit RemoteTokenSet(remoteToken, localToken);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) {
            revert ZeroAddress();
        }

        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function settleDeposit(
        bytes calldata message,
        bytes calldata attestation,
        uint256[7] calldata amountPCT
    ) external nonReentrant {
        if (!relayers[msg.sender]) {
            revert NotRelayer(msg.sender);
        }

        if (!messageTransmitter.receiveMessage(message, attestation)) {
            revert MessageReceiveFailed();
        }

        (bytes32 nonce, address user, address token, uint256 amount) = _decodeAndValidate(
            message
        );

        IERC20(token).forceApprove(address(eerc), amount);
        eerc.depositFor(user, amount, token, amountPCT, message);

        emit OnrampSettled(user, token, amount, nonce);
    }

    /// @notice Owner-only recovery for a CCTP message that mints to this router but
    /// cannot be settled as a Benzo onramp — e.g. a plain depositForBurn or a burn
    /// carrying malformed/empty hookData that {settleDeposit}'s decoder would reject.
    /// This receives the message (minting the token to the router) WITHOUT attempting
    /// an eERC deposit, so the funds land here and are recoverable via {rescue}
    /// instead of being stranded on CCTP. Does not credit any encrypted balance.
    function receiveForRescue(bytes calldata message, bytes calldata attestation)
        external
        onlyOwner
        nonReentrant
    {
        if (!messageTransmitter.receiveMessage(message, attestation)) {
            revert MessageReceiveFailed();
        }

        emit MessageReceivedForRescue(msg.sender);
    }

    function rescue(address token, address to) external onlyOwner {
        if (token == address(0) || to == address(0)) {
            revert ZeroAddress();
        }

        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);

        emit Rescue(token, to, amount);
    }

    function _decodeAndValidate(
        bytes calldata message
    )
        private
        view
        returns (bytes32 nonce, address user, address token, uint256 amount)
    {
        CctpMessageV2.Header memory header = message.decodeHeader();
        bytes calldata body = message.messageBody();
        CctpMessageV2.BurnMessage memory burnMessage = body.decodeBurnMessage();
        (address hookUser, uint256 pkX, uint256 pkY) = body
            .hookData()
            .decodeHookData();

        if (burnMessage.mintRecipient != address(this)) {
            revert MintRecipientMismatch(address(this), burnMessage.mintRecipient);
        }

        address localToken = remoteTokenToLocal[burnMessage.burnToken];
        if (localToken == address(0) || !allowedTokens[localToken]) {
            revert TokenNotAllowed(burnMessage.burnToken);
        }

        _requireRegisteredPublicKey(hookUser, pkX, pkY);

        return (
            header.nonce,
            hookUser,
            localToken,
            burnMessage.mintedAmount
        );
    }

    function _requireRegisteredPublicKey(
        address user,
        uint256 pkX,
        uint256 pkY
    ) private view {
        if (!registrar.isUserRegistered(user)) {
            revert RecipientNotRegistered(user);
        }

        uint256[2] memory registeredPublicKey = registrar.getUserPublicKey(user);
        if (registeredPublicKey[0] != pkX || registeredPublicKey[1] != pkY) {
            revert PublicKeyMismatch(
                user,
                registeredPublicKey[0],
                registeredPublicKey[1],
                pkX,
                pkY
            );
        }
    }
}
