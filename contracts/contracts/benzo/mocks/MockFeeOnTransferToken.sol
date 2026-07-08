// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock ERC20 that burns a fixed basis-point fee on every transfer.
/// @dev Used to exercise fee-on-transfer handling in escrow tests. Mints and
///      burns bypass the fee so balances are easy to set up.
contract MockFeeOnTransferToken is ERC20 {
    uint8 private immutable _decimals;
    uint256 public immutable feeBps;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        if (fee > 0) {
            super._update(from, address(0), fee);
        }
        super._update(from, to, value - fee);
    }
}
