/**
 * snarkjs Groth16 artifacts -> Soroban byte encodings.
 *
 *   Fr / Fq : 32-byte big-endian
 *   G1      : x || y                        (64 bytes)
 *   G2      : x.c1 || x.c0 || y.c1 || y.c0  (128 bytes; Soroban's c1||c0,
 *             while snarkjs JSON stores [c0, c1])
 */

export function feHex(dec: string | bigint): string {
  const v = BigInt(dec);
  if (v < 0n) throw new Error(`field element must be non-negative: ${dec}`);
  const h = v.toString(16);
  // A value >= 2^256 would emit >64 hex chars and silently shift every
  // downstream byte offset, corrupting the proof/VK/registry bytes sent
  // on-chain. Fail loud instead.
  if (h.length > 64) throw new Error(`field element exceeds 32 bytes: ${dec}`);
  return h.padStart(64, "0");
}

export function g1Hex(pt: string[]): string {
  if (!Array.isArray(pt) || pt.length < 3) throw new Error("G1 point malformed (expected [x, y, z])");
  if (BigInt(pt[2]) !== 1n) throw new Error("G1 point not affine (z != 1)");
  return feHex(pt[0]) + feHex(pt[1]);
}

export function g2Hex(pt: string[][]): string {
  if (!Array.isArray(pt) || pt.length < 3 || !pt[0] || !pt[1] || !pt[2]) {
    throw new Error("G2 point malformed (expected [[x0,x1],[y0,y1],[z0,z1]])");
  }
  if (BigInt(pt[2][0]) !== 1n || BigInt(pt[2][1]) !== 0n) {
    throw new Error("G2 point not affine (z != [1,0])");
  }
  return feHex(pt[0][1]) + feHex(pt[0][0]) + feHex(pt[1][1]) + feHex(pt[1][0]);
}

export interface SnarkjsVk {
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/** VerificationKeyBytes argument for BenzoVerifier.set_vk (CLI JSON form). */
export function vkToSoroban(vk: SnarkjsVk) {
  for (const f of ["vk_alpha_1", "vk_beta_2", "vk_gamma_2", "vk_delta_2", "IC"] as const) {
    if (!vk?.[f]) throw new Error(`verification_key.json missing ${f}`);
  }
  if (!Array.isArray(vk.IC) || vk.IC.length < 1) throw new Error("verification_key.json IC must be non-empty");
  return {
    alpha: g1Hex(vk.vk_alpha_1),
    beta: g2Hex(vk.vk_beta_2),
    gamma: g2Hex(vk.vk_gamma_2),
    delta: g2Hex(vk.vk_delta_2),
    ic: vk.IC.map(g1Hex),
  };
}

/** Groth16Proof argument (CLI JSON form). */
export function proofToSoroban(proof: SnarkjsProof) {
  for (const f of ["pi_a", "pi_b", "pi_c"] as const) {
    if (!proof?.[f]) throw new Error(`proof missing ${f}`);
  }
  return {
    a: g1Hex(proof.pi_a),
    b: g2Hex(proof.pi_b),
    c: g1Hex(proof.pi_c),
  };
}

/** Public inputs as decimal U256 strings (Bn254Fr CLI form). */
export function publicsToSoroban(publics: (string | bigint)[]): string[] {
  return publics.map((p) => BigInt(p).toString());
}
