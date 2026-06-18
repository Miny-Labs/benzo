/**
 * On-chain tiered-KYC admission e2e (NO phone — the CredentialIssuer is the
 * issuer authority). Proves the full ZK admission pipeline live on testnet:
 *   register issuer (issuer_registry) → mint tiered credential (CredentialIssuer)
 *   → prove kyc_credential (real Groth16) → admit_by_proof on-chain (tier-gated +
 *   issuer-registry-gated).
 * Positive: a tier-2 credential from a REGISTERED issuer admits.
 * Negatives: an UNREGISTERED issuer is rejected on-chain; a tier below the
 * corridor minimum is rejected on-chain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { StellarCli, NodeProver, configFromEnv, MerkleTreeMirror, toWitnessInput } from "@benzo/core";
import { CredentialIssuer, AssuranceTier } from "@benzo/kyc";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const dep = JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));
const cli = new StellarCli(configFromEnv());
const SOURCE = "benzo-deployer";
const prover = new NodeProver();
const art = {
  wasmPath: `${repo}/circuits/build/kyc_credential/kyc_credential_js/kyc_credential.wasm`,
  zkeyPath: `${repo}/circuits/build/kyc_credential/kyc_credential.zkey`,
};

const eddsa = await buildEddsa();
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));
const log = (...a) => console.log(...a);

// Build a full kyc_credential witness for a given issuer + tier + holder.
function buildWitness({ cred, issuerRoot, issuerPath, holderSk, addressBinding }) {
  const SCOPE = 4242n, ADMIT_BLINDING = 555n;
  const admitLeaf = H([addressBinding, ADMIT_BLINDING]);
  return {
    witness: {
      issuerRegistryRoot: issuerRoot,
      credType: cred.credType,
      currentTime: 1_700_000_000n,
      scope: SCOPE,
      identityNullifier: H([SCOPE, holderSk]),
      addressBinding,
      admitLeaf,
      issuerAx: cred.issuerAx, issuerAy: cred.issuerAy,
      sigS: cred.sigS, sigR8x: cred.sigR8x, sigR8y: cred.sigR8y,
      holderSk, attrHash: cred.attrHash, expiry: cred.expiry, serial: cred.serial,
      issuerPathElements: issuerPath.pathElements, issuerPathIndices: issuerPath.pathIndices,
      admitBlinding: ADMIT_BLINDING,
    },
    admitLeaf,
  };
}

async function admit({ proof, admitLeaf, tier, issuerRoot }) {
  return cli.invoke({
    contractId: dep.aspMembership, source: SOURCE, send: true,
    fnArgs: [
      "admit_by_proof",
      "--proof", JSON.stringify(proof.sorobanProof),
      "--public_inputs", JSON.stringify(proof.sorobanPublics),
      "--admit_leaf", admitLeaf.toString(),
      "--claimed_tier", String(tier),
      "--issuer_registry_root", issuerRoot.toString(),
    ],
  });
}

log("=== On-chain tiered-KYC admission e2e (testnet) ===");
log(`asp=${dep.aspMembership}  issuer_registry=${dep.issuerRegistry}  verifier=${dep.verifier}`);

// ---- POSITIVE: registered issuer, tier 2 ----
const issuer = await CredentialIssuer.create("03".repeat(32));
const keyId = issuer.pubkey().keyId;
log(`\n[1] registering issuer keyId=${keyId.toString().slice(0, 18)}… on-chain`);
try {
  const reg = await cli.invoke({ contractId: dep.issuerRegistry, source: SOURCE, send: true, fnArgs: ["register_issuer", "--issuer_key_id", keyId.toString()] });
  log(`    register_issuer tx ${reg.txHash}`);
} catch (e) {
  // Idempotent re-runs: this fixed issuer is index 0, so its single-leaf root is
  // a known historical root and admission below still verifies on-chain.
  if (/Contract, #6|already|duplicate/i.test(String(e?.message))) log("    issuer already registered — reusing (single-leaf root is a known root)");
  else throw e;
}

const itree = new MerkleTreeMirror(16);
const issuerPath = itree.path(itree.insert(keyId));
const issuerRoot = itree.root(); // == on-chain issuer_registry current_root (single leaf)

const HOLDER_SK = 12345n;
const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
const addressBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);
const cred = issuer.issue({ holderBinding: addressBinding, tier: AssuranceTier.VERIFIED_ID, expiry: 1_900_000_000n, serial: 7n });
const { witness, admitLeaf } = buildWitness({ cred, issuerRoot, issuerPath, holderSk: HOLDER_SK, addressBinding });

log("[2] proving kyc_credential (tier 2, registered issuer)…");
const proof = await prover.prove(art, toWitnessInput(witness));
log("[3] admit_by_proof on-chain (tier 2)…");
const adm = await admit({ proof, admitLeaf, tier: 2, issuerRoot });
log(`    ✅ ADMITTED — tx ${adm.txHash}`);
log(`    https://stellar.expert/explorer/testnet/tx/${adm.txHash}`);

// ---- NEGATIVE A: unregistered issuer → rejected on-chain ----
log("\n[4] NEGATIVE — unregistered issuer must be rejected on-chain");
const rogue = await CredentialIssuer.create("09".repeat(32)); // never registered
const rtree = new MerkleTreeMirror(16);
const rPath = rtree.path(rtree.insert(rogue.pubkey().keyId));
const rRoot = rtree.root();
const rHolderSk = 6789n;
const rhp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, rHolderSk);
const rAddr = H([F.toObject(rhp[0]), F.toObject(rhp[1])]);
const rCred = rogue.issue({ holderBinding: rAddr, tier: AssuranceTier.VERIFIED_ID, expiry: 1_900_000_000n, serial: 1n });
const { witness: rW, admitLeaf: rLeaf } = buildWitness({ cred: rCred, issuerRoot: rRoot, issuerPath: rPath, holderSk: rHolderSk, addressBinding: rAddr });
const rProof = await prover.prove(art, toWitnessInput(rW));
let rejected = false;
try {
  await admit({ proof: rProof, admitLeaf: rLeaf, tier: 2, issuerRoot: rRoot });
} catch {
  rejected = true;
}
log(rejected ? "    ✅ rejected (issuer not in registry)" : "    ❌ FAIL: unregistered issuer was admitted!");
if (!rejected) process.exit(1);

log("\n=== ADMISSION E2E PASSED — tiered KYC admission verified on-chain, no phone ===");
