// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

contract MockRegistrar {
    mapping(address user => bool registered) private _registered;
    mapping(address user => uint256[2] publicKey) private _publicKeys;

    function setUser(
        address user,
        uint256 pkX,
        uint256 pkY,
        bool registered
    ) external {
        _registered[user] = registered;
        _publicKeys[user] = [pkX, pkY];
    }

    function isUserRegistered(address user) external view returns (bool) {
        return _registered[user];
    }

    function getUserPublicKey(
        address user
    ) external view returns (uint256[2] memory publicKey) {
        return _publicKeys[user];
    }
}
