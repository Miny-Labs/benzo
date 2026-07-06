// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Public-token gift escrow for Benzo gift links.
/// @notice Escrows public tUSDC for a claim link whose bearer receives an ephemeral private key.
/// @dev This tier makes no amount, sender, or timing privacy claim: token amount, sender, claim, and refund activity are public on-chain. The claim secret is the only private component.
contract GiftEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        Created,
        Claimed,
        Refunded
    }

    struct Gift {
        address sender;
        address claimAddress;
        address recipient;
        uint256 amount;
        uint64 createdAt;
        uint64 expiry;
        Status status;
    }

    IERC20 public immutable token;

    uint256 private _nextGiftId = 1;
    mapping(uint256 id => Gift gift) private _gifts;

    event GiftCreated(
        uint256 indexed giftId,
        address indexed sender,
        address indexed claimAddress,
        uint256 amount,
        uint64 expiry
    );
    event GiftClaimed(
        uint256 indexed giftId,
        address indexed recipient,
        address indexed claimAddress
    );
    event GiftRefunded(uint256 indexed giftId, address indexed sender);

    error InvalidToken(address token);
    error InvalidClaimAddress(address claimAddress);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error InvalidExpiry(uint64 expiry, uint256 currentTimestamp);
    error GiftNotFound(uint256 giftId);
    error GiftNotCreated(uint256 giftId, Status status);
    error InvalidSignature(uint256 giftId, address recoveredSigner);
    error OnlySender(uint256 giftId, address caller);
    error GiftExpired(uint256 giftId, uint64 expiry, uint256 currentTimestamp);
    error GiftNotExpired(uint256 giftId, uint64 expiry, uint256 currentTimestamp);

    constructor(address token_) {
        if (token_ == address(0)) {
            revert InvalidToken(token_);
        }

        token = IERC20(token_);
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

    /// @notice Creates a public-token escrow gift.
    /// @param claimAddress Ephemeral EOA address whose private key is embedded in the off-chain gift link.
    /// @param amount Public tUSDC amount to escrow.
    /// @param expiry Timestamp after which only the sender may refund.
    /// @return giftId Newly assigned gift id.
    function createGift(
        address claimAddress,
        uint256 amount,
        uint64 expiry
    ) external returns (uint256 giftId) {
        if (claimAddress == address(0)) {
            revert InvalidClaimAddress(claimAddress);
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
            recipient: address(0),
            amount: amount,
            createdAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.Created
        });

        emit GiftCreated(giftId, msg.sender, claimAddress, amount, expiry);

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Claims a gift to `recipient` using a signature from the gift link's ephemeral key.
    /// @dev The signature is over `keccak256(abi.encode(address(this), block.chainid, giftId, recipient))`. Binding `recipient` avoids the stealable raw secret-reveal pattern where a mempool observer can copy the secret and claim to their own address.
    function claim(uint256 giftId, address recipient, bytes calldata sig) external {
        _requireCreated(giftId);
        if (recipient == address(0)) {
            revert InvalidRecipient(recipient);
        }

        Gift storage gift = _gifts[giftId];
        if (block.timestamp >= gift.expiry) {
            revert GiftExpired(giftId, gift.expiry, block.timestamp);
        }

        bytes32 digest = claimDigest(giftId, recipient);
        (address recoveredSigner, ECDSA.RecoverError error, ) = ECDSA.tryRecover(
            digest,
            sig
        );
        if (error != ECDSA.RecoverError.NoError || recoveredSigner != gift.claimAddress) {
            revert InvalidSignature(giftId, recoveredSigner);
        }

        gift.status = Status.Claimed;
        gift.recipient = recipient;

        emit GiftClaimed(giftId, recipient, gift.claimAddress);

        token.safeTransfer(recipient, gift.amount);
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

        emit GiftRefunded(giftId, msg.sender);

        token.safeTransfer(msg.sender, gift.amount);
    }

    /// @notice Returns the raw digest the claim link key must sign.
    function claimDigest(
        uint256 giftId,
        address recipient
    ) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, giftId, recipient));
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
