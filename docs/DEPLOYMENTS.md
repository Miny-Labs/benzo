# Benzo Deployments

Human-readable record of Benzo's live deployments across all three networks. The
**source of truth** is the machine-readable manifests, not this page — if they ever
disagree, the manifests win:

- Avalanche mainnet — [`contracts/deployments/avalanche.json`](../contracts/deployments/avalanche.json) · [`packages/config/src/deployments/avalanche.json`](../packages/config/src/deployments/avalanche.json)
- Fuji testnet — [`contracts/deployments/fuji.json`](../contracts/deployments/fuji.json) · [`packages/config/src/deployments/fuji.json`](../packages/config/src/deployments/fuji.json)
- BenzoNet L1 — [`contracts/deployments/benzonet.json`](../contracts/deployments/benzonet.json) · [`packages/config/src/deployments/benzonet.json`](../packages/config/src/deployments/benzonet.json)

| Network | Chain id | Tier | Explorer | Wraps |
| --- | --- | --- | --- | --- |
| Avalanche C-Chain | `43114` | production (mainnet) | [snowtrace.io](https://snowtrace.io) | real Circle USDC + EURC |
| Avalanche Fuji | `43113` | staging (testnet) | [testnet.snowtrace.io](https://testnet.snowtrace.io) | Circle testnet USDC + EURC |
| BenzoNet L1 | `68420` | staging (testnet) | [explorer.benzo.space](https://explorer.benzo.space) | faucet `tUSDC` |

Mainnet is **C-Chain converter only** — there is deliberately **no mainnet BenzoNet**.
Mainnet is a fresh, unaudited deployment whose `Ownable` admin is still the hot deploy
key (`0x09b67991141146e2A43651C72CF6786eeb579846`). See
[`MAINNET_GO_NO_GO.md`](MAINNET_GO_NO_GO.md) for the go/no-go record and remaining
post-deploy work.

## Avalanche C-Chain mainnet (`43114`) — live

The "Verified" column reflects the manifest's Routescan verification status; some
contracts are verified and the rest are being finalized.

| Contract | Address | Verified |
| --- | --- | --- |
| `EncryptedERC` converter | [`0x708d0b83461973F46041a36f588b8760dbC0Db0e`](https://snowtrace.io/address/0x708d0b83461973F46041a36f588b8760dbC0Db0e) | finalizing |
| `Registrar` | [`0x902B8D5585A5124C9B9c001A95b7f520C07a79F2`](https://snowtrace.io/address/0x902B8D5585A5124C9B9c001A95b7f520C07a79F2) | finalizing |
| `BabyJubJub` library | [`0x91eb19da5A7486b4AAb4a0e452299B7E6F3821F4`](https://snowtrace.io/address/0x91eb19da5A7486b4AAb4a0e452299B7E6F3821F4) | yes |
| Registration verifier | [`0x35b4C4227082f67c01656A39aC47F6c5D6005CaA`](https://snowtrace.io/address/0x35b4C4227082f67c01656A39aC47F6c5D6005CaA) | yes |
| Mint verifier | [`0xb0ea11Bf58ad83F1027E476cbA7B8E196Cc0C972`](https://snowtrace.io/address/0xb0ea11Bf58ad83F1027E476cbA7B8E196Cc0C972) | finalizing |
| Transfer verifier | [`0x4A716026a0C1F7158165520B6DF2009fFeB79f01`](https://snowtrace.io/address/0x4A716026a0C1F7158165520B6DF2009fFeB79f01) | yes |
| Withdraw verifier | [`0xDf3caC632d70365cEb5CD1DD72E5de741936fdb7`](https://snowtrace.io/address/0xDf3caC632d70365cEb5CD1DD72E5de741936fdb7) | finalizing |
| Burn verifier | [`0xCb59d38DA7F1E4cA11BfFa6BEd383624fa49bc3d`](https://snowtrace.io/address/0xCb59d38DA7F1E4cA11BfFa6BEd383624fa49bc3d) | yes |
| `PrivateGiftEscrow` | [`0xb22c366e000165683A51C2630F6Ab818e5227C94`](https://snowtrace.io/address/0xb22c366e000165683A51C2630F6Ab818e5227C94) | finalizing |
| `BenzoCCTPRouter` | [`0x83F26C562082e3c455938fd48162e990494a4caE`](https://snowtrace.io/address/0x83F26C562082e3c455938fd48162e990494a4caE) | finalizing |

Wrapped assets and Circle/CCTP contracts (external, verified by Circle):

| Thing | Address | Notes |
| --- | --- | --- |
| USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | `tokenId 1` |
| EURC | `0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD` | `tokenId 2` |
| CCTP `TokenMessengerV2` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | domain `1` |
| CCTP `MessageTransmitterV2` | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | domain `1` |
| Auditor account | `0x5ba6F05b245C06c3a4C05e7bC4486dE3661393ea` | public key set on-chain |

- **Ceremony:** Groth16 phase-2, drand quicknet **round 30261477** — transcript at
  [`ceremony/transcript.md`](ceremony/transcript.md).
- **CCTP onramp:** proven end-to-end by a single **0.1 USDC** Base→Avalanche burn,
  settle tx `0xc479b7c8d7a62fde5189d5c03b7f7fe8b5b4ad44afd42eea1aaf194c7556f8a3`.
  `BenzoCCTPRouter` allow-lists USDC + EURC with source maps for Ethereum / Base /
  Arbitrum / Optimism USDC and Ethereum / Base EURC.

## Avalanche Fuji testnet (`43113`)

Where the 17/17 real-funds flows run. Wraps Circle **testnet** USDC + EURC.

| Contract | Address |
| --- | --- |
| `EncryptedERC` converter | [`0x9E16eD3B799541B4929f7E2014904C65E81035b1`](https://testnet.snowtrace.io/address/0x9E16eD3B799541B4929f7E2014904C65E81035b1) |
| `Registrar` | [`0x9a63FEa9851097DBAf3757b636217fdde50ABaF0`](https://testnet.snowtrace.io/address/0x9a63FEa9851097DBAf3757b636217fdde50ABaF0) |
| `BabyJubJub` library | [`0x04513c37Fca1FBABA5Bb6Ff9547658b00B35697B`](https://testnet.snowtrace.io/address/0x04513c37Fca1FBABA5Bb6Ff9547658b00B35697B) |
| Registration verifier | [`0x4250bD1eb89Ef78469f94da2fE7738DCdcb09Ef7`](https://testnet.snowtrace.io/address/0x4250bD1eb89Ef78469f94da2fE7738DCdcb09Ef7) |
| Mint verifier | [`0x0fE395F5E97Ee02c961DE3d035E5De2D9019D15E`](https://testnet.snowtrace.io/address/0x0fE395F5E97Ee02c961DE3d035E5De2D9019D15E) |
| Transfer verifier | [`0x4bF3DBD3fF57943dC402ec1F280589E1032A32A5`](https://testnet.snowtrace.io/address/0x4bF3DBD3fF57943dC402ec1F280589E1032A32A5) |
| Withdraw verifier | [`0x7E194cb8A575d23f74EEDbEf1b519B281B29c30e`](https://testnet.snowtrace.io/address/0x7E194cb8A575d23f74EEDbEf1b519B281B29c30e) |
| Burn verifier | [`0x1BDfD6cB772D5F882622BaFD7B19898Da9F61d34`](https://testnet.snowtrace.io/address/0x1BDfD6cB772D5F882622BaFD7B19898Da9F61d34) |
| `PrivateGiftEscrow` | [`0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d`](https://testnet.snowtrace.io/address/0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d) |
| `BenzoCCTPRouter` | [`0x4b4f0dc760115DB356Cdfa89b4950E3418a3d98d`](https://testnet.snowtrace.io/address/0x4b4f0dc760115DB356Cdfa89b4950E3418a3d98d) |
| `HandleRegistry` | [`0xC74EcCDE4D9A1F48D560de9A96521D28D58B474b`](https://testnet.snowtrace.io/address/0xC74EcCDE4D9A1F48D560de9A96521D28D58B474b) |
| USDC (`tokenId 1`) | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| EURC (`tokenId 2`) | `0x5E44db7996c682E92a960b65AC713a54AD815c6B` |
| Auditor account | `0x13b8d12414dd468a9eCbA24d0a162C17affd6D32` |

## BenzoNet L1 (`68420`)

Benzo's permissioned Avalanche L1 (Subnet-EVM, gas token BGAS), single validator.
The same eERC stack runs inside the `txAllowList`-gated chain — encrypted amounts
*and* gated access at once. Wraps a faucet `tUSDC`.

| Contract | Address |
| --- | --- |
| `EncryptedERC` converter | [`0xEE46418e5EeFE6f74EFaa9beb370B59251BFFb02`](https://explorer.benzo.space/address/0xEE46418e5EeFE6f74EFaa9beb370B59251BFFb02) |
| `Registrar` | [`0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d`](https://explorer.benzo.space/address/0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d) |
| `BabyJubJub` library | [`0xbADeF08FE085928c36cF1301CfAa4d8061DA2469`](https://explorer.benzo.space/address/0xbADeF08FE085928c36cF1301CfAa4d8061DA2469) |
| Registration verifier | [`0x4c9CF63e688D08c633bEB4CcB1cfAbc73DA0Ea88`](https://explorer.benzo.space/address/0x4c9CF63e688D08c633bEB4CcB1cfAbc73DA0Ea88) |
| Mint verifier | [`0xE0A5d3d93D28551546c7D7584dfA6C63C6A01e85`](https://explorer.benzo.space/address/0xE0A5d3d93D28551546c7D7584dfA6C63C6A01e85) |
| Transfer verifier | [`0x1F6C733F5d4B5fe828BA7bCDf1d7657cD9fcE8c4`](https://explorer.benzo.space/address/0x1F6C733F5d4B5fe828BA7bCDf1d7657cD9fcE8c4) |
| Withdraw verifier | [`0x052100fC561F699fC56e57C1FD4A7468FbB78267`](https://explorer.benzo.space/address/0x052100fC561F699fC56e57C1FD4A7468FbB78267) |
| Burn verifier | [`0xfFB661949498C9A028dF80021eD57D3eF535B025`](https://explorer.benzo.space/address/0xfFB661949498C9A028dF80021eD57D3eF535B025) |
| `TestUSDC` (`tUSDC`, `tokenId 1`) | [`0x25B6a6bcF1aea52CE27A302E521aF9dBDD27D2E7`](https://explorer.benzo.space/address/0x25B6a6bcF1aea52CE27A302E521aF9dBDD27D2E7) |
| tx-allowlist precompile | `0x0200000000000000000000000000000000000002` |
| Auditor account | `0x13b8d12414dd468a9eCbA24d0a162C17affd6D32` |
