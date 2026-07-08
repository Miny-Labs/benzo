// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IRegistrar} from "../eerc/interfaces/IRegistrar.sol";

interface IPrivateGiftEscrowEerc {
    function depositFor(
        address to,
        uint256 amount,
        address tokenAddress,
        uint256[7] memory amountPCT,
        bytes calldata message
    ) external;

    function registrar() external view returns (IRegistrar);
}

/// @title Private-token gift escrow for Benzo gift links.
/// @notice Escrows public ERC20 funds, then credits a registered recipient's eERC balance on claim.
/// @dev This is a workflow privacy feature. Funds are credited privately through eERC, but escrow creation/refund timing, sender, token, and amount remain public on-chain.
contract PrivateGiftEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        Created,
        Claimed,
        Refunded
    }

    struct Gift {
        address sender;
        address claimAddress;
        address token;
        address recipient;
        uint256 amount;
        uint64 createdAt;
        uint64 expiry;
        Status status;
    }

    IPrivateGiftEscrowEerc public immutable eerc;
    IRegistrar public immutable registrar;

    uint256 private _nextGiftId = 1;
    mapping(uint256 id => Gift gift) private _gifts;

    event GiftCreated(
        uint256 indexed giftId,
        address indexed sender,
        address indexed claimAddress,
        address token,
        uint256 amount,
        uint64 expiry
    );
    event GiftClaimed(
        uint256 indexed giftId,
        address indexed recipient,
        address indexed claimAddress,
        address token,
        uint256 amount
    );
    event GiftRefunded(
        uint256 indexed giftId,
        address indexed sender,
        address token,
        uint256 amount
    );

    error InvalidEerc(address eerc);
    error InvalidToken(address token);
    error InvalidClaimAddress(address claimAddress);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error InvalidExpiry(uint64 expiry, uint256 currentTimestamp);
    error GiftNotFound(uint256 giftId);
    error GiftNotCreated(uint256 giftId, Status status);
    error InvalidSignature(uint256 giftId, address recoveredSigner);
    error RecipientNotRegistered(uint256 giftId, address recipient);
    error OnlySender(uint256 giftId, address caller);
    error GiftExpired(uint256 giftId, uint64 expiry, uint256 currentTimestamp);
    error GiftNotExpired(uint256 giftId, uint64 expiry, uint256 currentTimestamp);

    constructor(address eerc_) {
        if (eerc_ == address(0)) {
            revert InvalidEerc(eerc_);
        }

        eerc = IPrivateGiftEscrowEerc(eerc_);
        registrar = IPrivateGiftEscrowEerc(eerc_).registrar();
    }

    /// @notice Returns the number of gifts created so far.
    function giftCount() external view returns (uint256) {
        return _nextGiftId - 1;
    }

    /// @notice Returns the stored gift record.
    function getGift(uint256 giftId) external view returns (Gift memory gift) {
        _requireExists(giftId);
        return _gifts[giftId];
    }

    /// @notice Creates a private escrow gift for any token accepted by the eERC converter.
    /// @param claimAddress Ephemeral EOA address whose private key is embedded in the off-chain gift link.
    /// @param token ERC20 token to escrow.
    /// @param amount Public ERC20 amount to escrow.
    /// @param expiry Timestamp after which only the sender may refund.
    /// @return giftId Newly assigned gift id.
    function createGift(
        address claimAddress,
        address token,
        uint256 amount,
        uint64 expiry
    ) external returns (uint256 giftId) {
        if (claimAddress == address(0)) {
            revert InvalidClaimAddress(claimAddress);
        }
        if (token == address(0)) {
            revert InvalidToken(token);
        }
        if (amount == 0) {
            revert InvalidAmount();
        }
        if (expiry <= block.timestamp) {
            revert InvalidExpiry(expiry, block.timestamp);
        }

        giftId = _nextGiftId++;
        _gifts[giftId] = Gift({
            sender: msg.sender,
            claimAddress: claimAddress,
            token: token,
            recipient: address(0),
            amount: amount,
            createdAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.Created
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit GiftCreated(giftId, msg.sender, claimAddress, token, amount, expiry);
    }

    /// @notice Claims a gift into `recipient`'s encrypted eERC balance using a signature from the gift link's ephemeral key.
    /// @dev The signature is over `keccak256(abi.encode(address(this), block.chainid, giftId, recipient, keccak256(abi.encode(amountPCT))))`. Binding `recipient` and `amountPCT` avoids stealing or replaying a raw secret with different claim data.
    function claim(
        uint256 giftId,
        address recipient,
        bytes calldata sig,
        uint256[7] calldata amountPCT
    ) external {
        _requireCreated(giftId);
        if (recipient == address(0)) {
            revert InvalidRecipient(recipient);
        }

        Gift storage gift = _gifts[giftId];
        if (block.timestamp >= gift.expiry) {
            revert GiftExpired(giftId, gift.expiry, block.timestamp);
        }
        if (!registrar.isUserRegistered(recipient)) {
            revert RecipientNotRegistered(giftId, recipient);
        }

        bytes32 digest = claimDigest(giftId, recipient, amountPCT);
        (address recoveredSigner, ECDSA.RecoverError error, ) = ECDSA.tryRecover(
            digest,
            sig
        );
        if (error != ECDSA.RecoverError.NoError || recoveredSigner != gift.claimAddress) {
            revert InvalidSignature(giftId, recoveredSigner);
        }

        gift.status = Status.Claimed;
        gift.recipient = recipient;

        IERC20 token = IERC20(gift.token);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.forceApprove(address(eerc), gift.amount);
        eerc.depositFor(recipient, gift.amount, gift.token, amountPCT, bytes(""));

        uint256 expectedBalance = balanceBefore - gift.amount;
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter > expectedBalance) {
            token.safeTransfer(gift.sender, balanceAfter - expectedBalance);
        }

        emit GiftClaimed(
            giftId,
            recipient,
            gift.claimAddress,
            gift.token,
            gift.amount
        );
    }

    /// @notice Refunds an unclaimed gift to the original sender after expiry.
    function refund(uint256 giftId) external {
        _requireCreated(giftId);

        Gift storage gift = _gifts[giftId];
        if (msg.sender != gift.sender) {
            revert OnlySender(giftId, msg.sender);
        }
        if (block.timestamp < gift.expiry) {
            revert GiftNotExpired(giftId, gift.expiry, block.timestamp);
        }

        gift.status = Status.Refunded;

        emit GiftRefunded(giftId, msg.sender, gift.token, gift.amount);

        IERC20(gift.token).safeTransfer(msg.sender, gift.amount);
    }

    /// @notice Returns the raw digest the claim link key must sign.
    function claimDigest(
        uint256 giftId,
        address recipient,
        uint256[7] memory amountPCT
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    address(this),
                    block.chainid,
                    giftId,
                    recipient,
                    keccak256(abi.encode(amountPCT))
                )
            );
    }

    function _requireExists(uint256 giftId) private view {
        if (giftId == 0 || giftId >= _nextGiftId) {
            revert GiftNotFound(giftId);
        }
    }

    function _requireCreated(uint256 giftId) private view {
        _requireExists(giftId);

        Status status = _gifts[giftId].status;
        if (status != Status.Created) {
            revert GiftNotCreated(giftId, status);
        }
    }
}
