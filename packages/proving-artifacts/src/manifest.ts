/**
 * Artifact manifest — the index a client uses to discover + verify circuit
 * proving artifacts (witness-generator WASM + proving zkey) for client-side
 * proving.
 *
 * `vkHash` is the cache key + invalidation signal: it's the hash of the
 * on-chain verification key, so when a circuit (and therefore its VK) changes,
 * the manifest entry changes and stale cached zkeys are abandoned automatically.
 * `zkeyHash`/`wasmHash` are SHA-256 content digests used for integrity on
 * download — NOT a trust anchor (the proving key is public; a corrupt key can
 * only ever produce a proof that fails on-chain), purely so we never burn
 * proving time on a truncated/garbled file.
 *
 * Compression is a *transport* concern (serve the zkey with
 * `Content-Encoding: br`); the client receives decompressed bytes
 * transparently, so there is no client-side decompression code here.
 */

export interface ArtifactRef {
  /** circuit id, e.g. "shield" | "joinsplit" | "passport_register_rsa256" */
  circuit: string;
  /** hash of the on-chain VK — cache key + auto-invalidation on circuit change */
  vkHash: string;
  zkeyUrl: string;
  wasmUrl: string;
  /** SHA-256 (hex) of the zkey bytes — download-integrity only */
  zkeyHash: string;
  /** SHA-256 (hex) of the wasm bytes — download-integrity only */
  wasmHash: string;
  /** raw zkey size in bytes (drives the prover-routing decision) */
  sizeBytes: number;
}

export interface ArtifactManifest {
  /** when the manifest was generated (ISO-8601), for cache diagnostics */
  generatedAt: string;
  circuits: Record<string, ArtifactRef>;
}

/** Look up a circuit's artifact ref, throwing a clear error if absent. */
export function getRef(manifest: ArtifactManifest, circuit: string): ArtifactRef {
  const ref = manifest.circuits[circuit];
  if (!ref) {
    throw new Error(
      `no artifact for circuit "${circuit}" (have: ${Object.keys(manifest.circuits).join(", ")})`,
    );
  }
  return ref;
}
