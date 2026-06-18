/**
 * `pickProver` — decide whether a given circuit proves ON-DEVICE (WasmProver)
 * or via a DELEGATED witness-hiding prover (PhalaProver, RA-TLS).
 *
 * The policy encodes the senior design stance:
 *   - On-device is the ZERO-TRUST DEFAULT. A capable device (desktop / strong
 *     phone) always proves locally — the witness never leaves.
 *   - Delegation is a CONFIDENTIALITY fallback for weak devices, used only when
 *     local proving is impractical: a "heavy" circuit (passport register,
 *     joinsplit) or an oversized artifact. Even then soundness is unchanged
 *     (Groth16); delegation only moves *where* the witness is sealed (the TEE).
 *
 * So a TEE outage can only ever degrade UX (fall back to on-device or fail
 * closed), never soundness — which is the invariant we never cross.
 */

export interface DeviceProfile {
  isMobile: boolean;
  /** navigator.deviceMemory (GB), if known */
  memoryGB?: number;
  /** navigator.hardwareConcurrency, if known */
  cores?: number;
}

export type ProverChoice = "wasm" | "delegated";

export interface RoutePolicy {
  /**
   * Route EVERYTHING to the delegated (attested TEE) prover. This is Benzo's
   * default: all proving + signing run in the Phala enclave, so clients never
   * download a zkey and the witness is sealed to the attested enclave (RA-TLS).
   * Soundness is unaffected — proofs are still verified on-chain — so a TEE
   * compromise can never mint or double-spend; it only ever touches witness
   * confidentiality / the keys the enclave holds.
   */
  teeOnly?: boolean;
  /** Force on-device proving (witness never leaves the device). */
  onDeviceOnly?: boolean;
  /** circuits too heavy to prove on-device on a weak device (only used when !teeOnly) */
  heavyCircuits: string[];
  /** zkey byte ceiling above which a weak device delegates (only used when !teeOnly) */
  maxOnDeviceBytes: number;
}

/** Benzo default: all proving in the attested TEE. */
export const TEE_ONLY_POLICY: RoutePolicy = {
  teeOnly: true,
  heavyCircuits: [],
  maxOnDeviceBytes: 0,
};

/** Force on-device proving (the user's witness never leaves their device). */
export const ON_DEVICE_POLICY: RoutePolicy = {
  onDeviceOnly: true,
  heavyCircuits: [],
  maxOnDeviceBytes: Number.MAX_SAFE_INTEGER,
};

/**
 * The user's proving preference. Benzo lets each user choose where their witness
 * is processed:
 *   - "tee"       → always the attested Phala enclave (zero local download; the
 *                   witness is sealed to the enclave; convenience + weak devices).
 *   - "on-device" → always local WasmProver (witness never leaves the device;
 *                   maximal privacy; requires the one-time artifact download).
 *   - "auto"      → on-device when the device can handle it, TEE for heavy/weak.
 * Soundness is identical in all three (proofs verified on-chain); only WHERE the
 * witness is handled differs.
 */
export type ProvingMode = "tee" | "on-device" | "auto";

export function policyForMode(mode: ProvingMode): RoutePolicy {
  switch (mode) {
    case "on-device":
      return ON_DEVICE_POLICY;
    case "auto":
      return HYBRID_POLICY;
    case "tee":
    default:
      return TEE_ONLY_POLICY;
  }
}

/** Hybrid policy (kept for environments that opt into on-device proving). */
export const HYBRID_POLICY: RoutePolicy = {
  heavyCircuits: [
    "joinsplit",
    "proof_of_balance",
    "proof_of_sum",
    "passport_register",
    "passport_register_rsa256",
    "passport_register_rsa1",
  ],
  maxOnDeviceBytes: 30 * 1024 * 1024, // 30 MB
};

/** Default policy = TEE-only (per the trusted-TEE architecture decision). */
export const DEFAULT_POLICY: RoutePolicy = TEE_ONLY_POLICY;

/** A device is "weak" if mobile, low-memory, or low-core. */
export function isWeakDevice(d: DeviceProfile): boolean {
  return (
    d.isMobile ||
    (d.memoryGB != null && d.memoryGB < 4) ||
    (d.cores != null && d.cores < 4)
  );
}

/**
 * Pick the prover for `circuit` (whose zkey is `sizeBytes`) on `device`.
 * Strong device → always on-device. Weak device → delegate heavy/oversized
 * circuits, prove the rest locally.
 */
export function pickProver(
  circuit: string,
  sizeBytes: number,
  device: DeviceProfile,
  policy: RoutePolicy = DEFAULT_POLICY,
): ProverChoice {
  if (policy.teeOnly) return "delegated"; // user chose TEE — all proving in the enclave
  if (policy.onDeviceOnly) return "wasm"; // user chose on-device — witness never leaves
  if (!isWeakDevice(device)) return "wasm"; // (auto/hybrid) on-device for capable devices
  if (policy.heavyCircuits.some((c) => circuit === c || circuit.startsWith(c))) {
    return "delegated";
  }
  if (sizeBytes > policy.maxOnDeviceBytes) return "delegated";
  return "wasm";
}
