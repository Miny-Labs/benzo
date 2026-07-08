// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external returns (uint64 nonce);
}

/// @title Benzo source-chain CCTP onramp helper.
/// @notice Consumes an EIP-2612 permit, pulls a user's source-chain stablecoin,
/// and forwards it into Circle CCTP V2 for Benzo's Avalanche auto-deposit router.
/// @dev Deploy one helper per source chain/router pair. The permit is exact-amount
/// and the destination router is immutable so a relayer cannot redirect the burn.
contract BenzoOnrampHelper {
    using SafeERC20 for IERC20;

    struct PermitSignature {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable destinationDomain;
    bytes32 public immutable destinationRouter;

    error InvalidTokenMessenger(address tokenMessenger);
    error InvalidDestinationRouter(address destinationRouter);
    error InvalidOwner(address owner);
    error OnlyOwnerMayOnramp(address owner, address caller);
    error InvalidBurnToken(address burnToken);
    error InvalidAmount();
    error InvalidHookData();
    error HookUserMismatch(address owner, address hookUser);

    constructor(
        address tokenMessenger_,
        uint32 destinationDomain_,
        address destinationRouter_
    ) {
        if (tokenMessenger_ == address(0)) {
            revert InvalidTokenMessenger(tokenMessenger_);
        }
        if (destinationRouter_ == address(0)) {
            revert InvalidDestinationRouter(destinationRouter_);
        }

        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        destinationDomain = destinationDomain_;
        destinationRouter = _addressToBytes32(destinationRouter_);
    }

    function onrampWithPermit(
        address owner,
        address burnToken,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData,
        PermitSignature calldata permitSignature
    ) external returns (uint64 nonce) {
        if (owner == address(0)) {
            revert InvalidOwner(owner);
        }
        // The onramp is the owner's own source-chain action (they hold the funds
        // and pay gas). Requiring the caller to be the owner binds pkX/pkY, maxFee,
        // and minFinalityThreshold to the owner's own transaction, so a mempool
        // front-runner holding the permit signature can't re-submit with different
        // hook/fee params. This stays one-tap: the permit + burn happen in one call.
        if (msg.sender != owner) {
            revert OnlyOwnerMayOnramp(owner, msg.sender);
        }
        if (burnToken == address(0)) {
            revert InvalidBurnToken(burnToken);
        }
        if (amount == 0) {
            revert InvalidAmount();
        }

        address hookUser = _decodeHookUser(hookData);
        if (hookUser != owner) {
            revert HookUserMismatch(owner, hookUser);
        }

        IERC20Permit(burnToken).permit(
            owner,
            address(this),
            amount,
            permitSignature.deadline,
            permitSignature.v,
            permitSignature.r,
            permitSignature.s
        );

        IERC20 token = IERC20(burnToken);
        token.safeTransferFrom(owner, address(this), amount);
        token.forceApprove(address(tokenMessenger), amount);

        nonce = tokenMessenger.depositForBurnWithHook(
            amount,
            destinationDomain,
            destinationRouter,
            burnToken,
            destinationRouter,
            maxFee,
            minFinalityThreshold,
            hookData
        );

        token.forceApprove(address(tokenMessenger), 0);
    }

    function _decodeHookUser(bytes calldata hookData) private pure returns (address user) {
        if (hookData.length != 96) {
            revert InvalidHookData();
        }

        (user, , ) = abi.decode(hookData, (address, uint256, uint256));
    }

    function _addressToBytes32(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
