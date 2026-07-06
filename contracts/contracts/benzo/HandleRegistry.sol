// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

/// @title Benzo Handle Registry
/// @notice First-come-first-served registry for public @handle to address resolution.
/// @dev The handle -> address mapping is fully public by design; claiming a handle deliberately links a human-readable identity to an address. eERC keeps that address's balances and transfer amounts encrypted, but its transaction graph (who it interacted with, when) remains public metadata. The contract makes no privacy claim beyond what eERC provides to the underlying address.
/// @dev Squatting is an accepted demo tradeoff: there is no admin, fee, reservation, or dispute process.
contract HandleRegistry {
    uint256 private constant MIN_HANDLE_LENGTH = 3;
    uint256 private constant MAX_HANDLE_LENGTH = 32;

    mapping(bytes32 => address) public ownerOf;
    mapping(address => string) public handleOf;

    event HandleClaimed(bytes32 indexed handleHash, string handle, address indexed owner);
    event HandleReleased(bytes32 indexed handleHash, string handle, address indexed owner);
    event HandleTransferred(
        bytes32 indexed handleHash,
        string handle,
        address indexed from,
        address indexed to
    );

    error InvalidHandleLength(uint256 length);
    error InvalidHandleCharacter(bytes1 character);
    error HandleTaken(bytes32 handleHash);
    error CallerAlreadyHasHandle(address owner);
    error CallerHasNoHandle(address owner);
    error InvalidRecipient(address recipient);
    error RecipientAlreadyHasHandle(address recipient);

    /// @notice Claim an unclaimed handle for the caller.
    /// @param handle Lowercase handle without the leading @. Allowed bytes are [a-z0-9_], length 3-32.
    function claim(string calldata handle) external {
        bytes32 handleHash = _validateAndHash(handle);

        if (ownerOf[handleHash] != address(0)) {
            revert HandleTaken(handleHash);
        }
        if (bytes(handleOf[msg.sender]).length != 0) {
            revert CallerAlreadyHasHandle(msg.sender);
        }

        ownerOf[handleHash] = msg.sender;
        handleOf[msg.sender] = handle;

        emit HandleClaimed(handleHash, handle, msg.sender);
    }

    /// @notice Release the caller's current handle so another address can claim it.
    function release() external {
        string memory handle = handleOf[msg.sender];
        if (bytes(handle).length == 0) {
            revert CallerHasNoHandle(msg.sender);
        }

        bytes32 handleHash = keccak256(bytes(handle));

        delete ownerOf[handleHash];
        delete handleOf[msg.sender];

        emit HandleReleased(handleHash, handle, msg.sender);
    }

    /// @notice Move the caller's handle to a new address for wallet rotation.
    /// @param to Address that will own the caller's handle.
    function transferHandle(address to) external {
        if (to == address(0)) {
            revert InvalidRecipient(to);
        }

        string memory handle = handleOf[msg.sender];
        if (bytes(handle).length == 0) {
            revert CallerHasNoHandle(msg.sender);
        }
        if (bytes(handleOf[to]).length != 0) {
            revert RecipientAlreadyHasHandle(to);
        }

        bytes32 handleHash = keccak256(bytes(handle));

        delete handleOf[msg.sender];
        handleOf[to] = handle;
        ownerOf[handleHash] = to;

        emit HandleTransferred(handleHash, handle, msg.sender, to);
    }

    /// @notice Resolve a handle to its current owner address.
    /// @param handle Lowercase handle without the leading @.
    function resolve(string calldata handle) external view returns (address) {
        return ownerOf[_validateAndHash(handle)];
    }

    function _validateAndHash(string calldata handle) private pure returns (bytes32) {
        bytes calldata handleBytes = bytes(handle);
        uint256 length = handleBytes.length;

        if (length < MIN_HANDLE_LENGTH || length > MAX_HANDLE_LENGTH) {
            revert InvalidHandleLength(length);
        }

        for (uint256 i = 0; i < length; ++i) {
            bytes1 char = handleBytes[i];
            bool isLowercaseLetter = char >= 0x61 && char <= 0x7a;
            bool isDigit = char >= 0x30 && char <= 0x39;

            if (!isLowercaseLetter && !isDigit && char != 0x5f) {
                revert InvalidHandleCharacter(char);
            }
        }

        return keccak256(handleBytes);
    }
}
