// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

contract MockCctpHookDataDecoder {
    function decode(
        bytes calldata hookData
    ) external pure returns (address user, uint256 pkX, uint256 pkY) {
        return abi.decode(hookData, (address, uint256, uint256));
    }
}
