// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockTokenMessengerV2 {
    using SafeERC20 for IERC20;

    struct Deposit {
        address caller;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    uint64 public nextNonce = 1;
    Deposit public lastDeposit;

    event DepositForBurnWithHook(
        address indexed caller,
        uint64 indexed nonce,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address indexed burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes hookData
    );

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external returns (uint64 nonce) {
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);

        nonce = nextNonce++;
        lastDeposit = Deposit({
            caller: msg.sender,
            amount: amount,
            destinationDomain: destinationDomain,
            mintRecipient: mintRecipient,
            burnToken: burnToken,
            destinationCaller: destinationCaller,
            maxFee: maxFee,
            minFinalityThreshold: minFinalityThreshold,
            hookData: hookData
        });

        emit DepositForBurnWithHook(
            msg.sender,
            nonce,
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
    }
}
