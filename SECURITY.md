# Benzo — Security

Benzo is a private-payments product on Avalanche built on the eERC
(Encrypted ERC) standard. **Status: testnet-only (Fuji), fresh scaffold,
not externally audited. No mainnet funds are at risk.**

## Trust model (eERC)

- **Soundness** comes from eERC's audited Groth16 circuits and on-chain
  verifiers — value conservation, balance correctness, and transfer validity
  are proven, not trusted. Benzo does not modify the circuits.
- **Proof generation is client-side** (snarkjs in the browser / local Node).
  Private inputs never leave the user's device or Benzo-controlled runtime.
- **Auditor key:** the contract owner sets a rotatable auditor public key;
  the auditor can decrypt transaction history for compliance. Until an
  auditor key is set, private operations revert — fail closed.
- **Decryption keys** are derived from a deterministic wallet signature.
  Key custody is the wallet's; Benzo never stores raw private keys.

## Rules for this repo

- Never commit `.env`, private keys, or mnemonics. Only Fuji test keys —
  never a key that holds mainnet funds.
- Generated proving artifacts (`.zkey`, circuit `.wasm`, zkit output) are
  build products; regenerate rather than commit.
- New features that claim privacy must either rely on an eERC proof
  verified on-chain or fail clearly.

## Prior implementation

The retired Stellar/Soroban implementation (and its detailed threat model)
lives in git history at `fbb4d4e`.

## Responsible disclosure

Report security issues privately to the maintainer (see repo contact)
rather than via public issues.
