/**
 * In-enclave Groth16 phase-2 ceremony contribution (snarkjs).
 *
 * Runs INSIDE the Phala dstack (Intel TDX) CVM. The contribution entropy (the
 * "toxic waste") is generated from the OS CSPRNG inside the sealed enclave and is
 * never written out or returned — only the new zkey (PUBLIC) leaves. The caller
 * gets a TDX quote whose report_data binds (inputZkeyHash ‖ outputZkeyHash), so
 * anyone can verify the contribution was produced in *this* attested enclave and
 * that the entropy lived only inside it. That makes a SOLO contribution credibly
 * "1-of-N honest": the enclave is the independent honest party.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";

const ARTIFACT_ROOT = process.env.BENZO_ARTIFACT_ROOT || join(import.meta.dirname, "..", "artifacts");
const sha256 = (buf) => createHash("sha256").update(buf).digest();

/**
 * Contribute to `<circuit>.zkey`, writing `<circuit>.contrib.zkey`.
 * Returns the input/output hashes + the contribution name (the entropy stays inside).
 */
export async function contributeCircuit(circuit, name = "benzo-tee-contributor") {
  const inPath = join(ARTIFACT_ROOT, circuit, `${circuit}.zkey`);
  const outPath = join(ARTIFACT_ROOT, circuit, `${circuit}.contrib.zkey`);
  if (!existsSync(inPath)) throw new Error(`no baked zkey for '${circuit}' at ${inPath}`);

  const inputHash = sha256(readFileSync(inPath));
  // 64 bytes of CSPRNG entropy from inside the enclave — the toxic waste. snarkjs
  // mixes it into the phase-2 contribution; it is never persisted or returned.
  const entropy = randomBytes(64);
  await snarkjs.zKey.contribute(inPath, outPath, name, entropy.toString("hex"));
  const outputHash = sha256(readFileSync(outPath));

  return {
    circuit,
    name,
    inputZkeyHash: inputHash.toString("hex"),
    outputZkeyHash: outputHash.toString("hex"),
    outPath,
  };
}

/** 64-byte report_data for the TDX quote = sha256(inputHash) ‖ sha256(outputHash). */
export function ceremonyReportData(inputZkeyHashHex, outputZkeyHashHex) {
  return Buffer.concat([
    sha256(Buffer.from(inputZkeyHashHex, "hex")),
    sha256(Buffer.from(outputZkeyHashHex, "hex")),
  ]); // exactly 64 bytes
}
