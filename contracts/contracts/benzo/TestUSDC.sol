// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test USD Coin
/// @notice Fuji-only demo stablecoin for Benzo converter-mode eERC deposits.
contract TestUSDC is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 24 hours;

    mapping(address account => uint256 timestamp) public lastFaucetAt;

    error FaucetCooldownActive(address account, uint256 nextAvailableAt);

    constructor(address initialOwner)
        ERC20("Test USD Coin", "tUSDC")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        uint256 lastMintedAt = lastFaucetAt[msg.sender];
        uint256 nextAvailableAt = lastMintedAt + FAUCET_COOLDOWN;

        if (lastMintedAt != 0 && block.timestamp < nextAvailableAt) {
            revert FaucetCooldownActive(msg.sender, nextAvailableAt);
        }

        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
