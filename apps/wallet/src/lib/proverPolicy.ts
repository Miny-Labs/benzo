/**
 * Prover policy - WHERE a ZK proof gets generated, decided by the device.
 *
 * On-device proving (snarkjs WasmProver) is single-threaded and heavy (a transfer
 * proof is ~tens of seconds, and the proving key is 20–25 MB). That is fine on a
 * capable laptop but punishing on a phone or a weak machine. So:
 *
 *   - phones / tablets / touch-first devices  → NEVER prove on-device. Delegate
 *     to the attested enclave (TEE). If no TEE is wired, fail closed instead of
 *     falling back to a server-local prover.
 *   - low-power desktops (few CPU cores / little RAM) → same: delegate.
 *   - capable desktops only → prove on-device (witness never leaves the browser).
 *
 * `delegatedProverKind` then picks the delegate: the attested TEE. No server
 * local-prover fallback is allowed for weak devices.
 */
import type { ProverKind } from "./api";
import { TEE_CONFIG } from "./network";

export interface ProverPlan {
  onDevice: boolean;
  kind: ProverKind;
  reason: string;
}

/** Coarse pointer + touch points ⇒ a phone/tablet (no mouse). */
function isTouchFirst(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const ua = /Mobi|Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent || "");
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  return ua || (coarse && touch);
}

/** A desktop with enough muscle to prove on-device without a painful wait. */
function isPowerfulDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  // deviceMemory is Chromium-only; assume "enough" when the browser won't say.
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  return cores >= 4 && mem >= 4;
}

/**
 * True only when this device should grind the proof locally. Phones, tablets and
 * weak desktops return false → the caller must delegate (TEE / server).
 */
export function preferDeviceProving(): boolean {
  if (isTouchFirst()) return false; // mobile/tablet → always delegate
  return isPowerfulDesktop(); // desktop → only if it has the cores/RAM
}

/** Which delegate to use when we're NOT proving on-device: always the TEE. */
export function delegatedProverKind(teeAvailable: boolean): ProverKind {
  if (teeAvailable || TEE_CONFIG) return "tee";
  throw new Error("No attested TEE prover is configured for this build.");
}

/**
 * Any proof that crosses the wallet API boundary must be delegated to the TEE.
 * "local" means browser-local only; Vercel/serverless must never become the
 * machine grinding user witnesses.
 */
export function apiProverKind(kind: ProverKind, teeAvailable = false): ProverKind {
  if (kind === "tee") return "tee";
  return delegatedProverKind(teeAvailable);
}

/** One-liner for UI copy / telemetry: how this device will prove. */
export function proverPlan(teeAvailable: boolean): ProverPlan {
  if (preferDeviceProving()) return { onDevice: true, kind: "local", reason: "Capable device - proving on-device, witness stays here" };
  const kind = delegatedProverKind(teeAvailable);
  return {
    onDevice: false,
    kind,
    reason: "Low-power device - delegating to the attested secure enclave (TEE)",
  };
}

/**
 * UI copy for proofs that cross the wallet API boundary. Browser-local proving
 * is only true when the browser owns the whole proof+submit path; API-bound
 * actions delegate to the attested TEE so Vercel/serverless never handles a
 * user witness.
 */
export function apiBoundaryProverPlan(plan: ProverPlan, teeAvailable = false): ProverPlan {
  const kind = apiProverKind(plan.kind, teeAvailable);
  if (kind === "tee") {
    return {
      onDevice: false,
      kind,
      reason: "Proof runs in the attested secure enclave (TEE); Vercel never proves with your witness",
    };
  }
  return { ...plan, kind };
}
