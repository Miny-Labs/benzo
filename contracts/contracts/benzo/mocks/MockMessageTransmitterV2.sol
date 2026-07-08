// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {CctpMessageV2} from "../libraries/CctpMessageV2.sol";

interface IMockCctpMintable {
    function mint(address to, uint256 amount) external;
}

contract MockMessageTransmitterV2 {
    using CctpMessageV2 for bytes;

    mapping(bytes32 nonce => bool used) public usedNonces;
    bool public receiveResult = true;

    error CctpNonceAlreadyUsed(bytes32 nonce);

    function setReceiveResult(bool receiveResult_) external {
        receiveResult = receiveResult_;
    }

    function receiveMessage(
        bytes calldata message,
        bytes calldata
    ) external returns (bool success) {
        CctpMessageV2.Header memory header = message.decodeHeader();
        if (usedNonces[header.nonce]) {
            revert CctpNonceAlreadyUsed(header.nonce);
        }
        usedNonces[header.nonce] = true;

        CctpMessageV2.BurnMessage memory burnMessage = message
            .messageBody()
            .decodeBurnMessage();
        IMockCctpMintable(burnMessage.burnToken).mint(
            burnMessage.mintRecipient,
            burnMessage.mintedAmount
        );

        return receiveResult;
    }
}
