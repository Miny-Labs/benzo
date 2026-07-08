// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockPermitToken is ERC20 {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    uint8 private immutable _tokenDecimals;

    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(address owner => uint256 nonce) public nonces;

    error PermitExpired(uint256 deadline);
    error InvalidPermitSignature(address owner, address recovered);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 tokenDecimals_
    ) ERC20(name_, symbol_) {
        _tokenDecimals = tokenDecimals_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name_)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }

        uint256 nonce = nonces[owner]++;
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != owner) {
            revert InvalidPermitSignature(owner, recovered);
        }

        _approve(owner, spender, value);
    }
}
