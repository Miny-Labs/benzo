/**
 * Browser/mobile/extension TEE attestation — verifies the enclave's Intel TDX
 * quote CLIENT-SIDE using @phala/dcap-qvl-web (WASM), so a phone or extension can
 * attest the prover enclave itself (no server trust) and then seal its witness to
 * the attested key. This is what makes TEE proving usable on weak devices: no
 * 22 MB zkey download and no multi-second on-device proving — the tiny witness is
 * sealed and proven in the enclave, the proof is still verified on-chain.
 *
 * Collateral (Intel-signed certs/CRL/TCB) is fetched from Phala's CORS-enabled
 * PCCS, so it works from a browser; the enclave may also serve it inline.
 */
import {
  DstackAttestationVerifier,
  type QuoteVerifier,
  type DstackVerifierOptions,
} from "./attestation.js";
import { type ProverPort, PhalaProver, WasmProver } from "./prover.js";

/** CORS-enabled PCCS suitable for browser collateral fetches. */
export const PHALA_PCCS_URL = "https://pccs.phala.network";

const fromHex = (s: string): Uint8Array => {
  const c = (s || "").replace(/^0x/, "");
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
};

type Qvl = typeof import("@phala/dcap-qvl-web");
let _wasm: Promise<Qvl> | null = null;

/**
 * Initialize the WASM verifier once (idempotent). In the browser call with no
 * args — the bundler resolves the packaged `.wasm`. In Node/tests, pass the
 * `.wasm` bytes or a compiled module.
 */
export function initWebAttestation(wasm?: BufferSource | WebAssembly.Module): Promise<Qvl> {
  if (!_wasm) {
    _wasm = (async () => {
      const mod = await import("@phala/dcap-qvl-web");
      // default() loads/instantiates the wasm; object form avoids the deprecation warning.
      await (mod.default as (a?: unknown) => Promise<unknown>)(wasm ? { module_or_path: wasm } : undefined);
      return mod;
    })();
  }
  return _wasm;
}

interface Td10Json {
  rt_mr3: string; mr_td: string; mr_config_id: string; report_data: string;
}

/** Quote verifier backed by @phala/dcap-qvl-web (WASM) — runs in the browser. */
export const webQuoteVerifier: QuoteVerifier = async (quoteHex, collateral) => {
  const mod = await initWebAttestation();
  const raw = fromHex(quoteHex);
  const col = collateral ?? (await mod.js_get_collateral(PHALA_PCCS_URL, raw));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const out = mod.js_verify(raw, col, now) as {
    status: string;
    report: { TD10?: Td10Json; TD15?: { base: Td10Json } };
  };
  const td = out.report.TD10 ?? out.report.TD15?.base;
  if (!td) throw new Error("quote is not a TDX (TD10/TD15) report");
  return {
    status: String(out.status),
    rtmr3: String(td.rt_mr3),
    mrtd: String(td.mr_td),
    mrConfigId: String(td.mr_config_id),
    reportData: fromHex(String(td.report_data)),
  };
};

/**
 * Browser TEE attestation verifier: verifies the live enclave's TDX quote
 * client-side (WASM) and returns the attested measurement + X25519 key so the
 * witness can be sealed to it. Drop-in for `DstackAttestationVerifier` in the
 * browser. Pair with `PhalaProver` for on-phone / extension proving.
 */
export function makeWebAttestationVerifier(
  opts: Omit<DstackVerifierOptions, "verifyQuote"> = {},
): DstackAttestationVerifier {
  return new DstackAttestationVerifier({ ...opts, verifyQuote: webQuoteVerifier });
}

/**
 * One-call browser/mobile/extension TEE prover: attests the live enclave
 * client-side (WASM) and seals witnesses to its attested key. The headline path
 * for weak devices — no zkey download, proving runs in the enclave, proof still
 * verified on-chain.
 *
 *   const prover = makeBrowserTeeProver(endpoint, composeHash);
 *   const client = new BenzoClient({ ..., prover });
 */
export function makeBrowserTeeProver(
  endpoint: string,
  measurement: string,
  opts: Omit<DstackVerifierOptions, "verifyQuote"> = {},
): PhalaProver {
  return new PhalaProver(endpoint, makeWebAttestationVerifier(opts), measurement);
}

export interface DeviceProfile {
  /** phone/tablet (from the user-agent) */
  isMobile?: boolean;
  /** navigator.deviceMemory (GB), if the browser exposes it */
  memoryGB?: number;
  /** navigator.hardwareConcurrency (logical cores), if known */
  cores?: number;
  /** WebAssembly available (on-device proving needs it) */
  hasWasm?: boolean;
}

export interface BrowserProverOptions {
  /** "tee" → always the enclave; "on-device" → always local WASM; "auto" (default)
   *  → capable desktops prove locally, everything else uses the TEE. */
  mode?: "tee" | "on-device" | "auto";
  /** Device hints; auto-detected from the browser when omitted. */
  device?: DeviceProfile;
  tee: { endpoint: string; measurement: string };
  /** Min logical cores to prove on-device (default 4). */
  minCores?: number;
  /** Min memory (GB) to prove on-device, when the browser reports it (default 8). */
  minMemoryGB?: number;
}

const DEFAULT_MIN_CORES = 4;
const DEFAULT_MIN_MEMORY_GB = 8;

/** Best-effort device profile from the browser (safe defaults off-browser). */
export function detectDevice(): DeviceProfile {
  const nav = (globalThis as { navigator?: { userAgent?: string; deviceMemory?: number; hardwareConcurrency?: number } }).navigator;
  const ua = nav?.userAgent ?? "";
  return {
    isMobile: /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua),
    memoryGB: nav?.deviceMemory,
    cores: nav?.hardwareConcurrency,
    hasWasm: typeof WebAssembly !== "undefined",
  };
}

/**
 * The simple capability gate: can this device prove ON-DEVICE (heavy WASM)?
 * TRUE only for a sufficiently-powered DESKTOP with WebAssembly. Any mobile, a
 * WASM-less browser, too few cores, or too little RAM → FALSE (use the TEE).
 * Unknown metrics are treated optimistically, except mobile and missing-WASM.
 */
export function canProveOnDevice(
  device: DeviceProfile,
  minCores = DEFAULT_MIN_CORES,
  minMemoryGB = DEFAULT_MIN_MEMORY_GB,
): boolean {
  if (device.isMobile) return false;                                          // any mobile → TEE
  if (device.hasWasm === false) return false;                                 // WASM unsupported → TEE
  if (device.cores != null && device.cores < minCores) return false;          // too few cores → TEE
  if (device.memoryGB != null && device.memoryGB < minMemoryGB) return false; // too little RAM → TEE
  return true;                                                                // capable desktop → on-device
}

/**
 * Auto-route browser proving: a capable desktop proves on-device with WasmProver
 * (witness never leaves the machine); any mobile / unsupported / under-powered
 * device proves in the attested TEE (no zkey download, no heavy CPU, witness
 * sealed to the enclave). Soundness is identical (on-chain proof) — only WHERE
 * the witness is handled differs.
 */
export function pickBrowserProver(opts: BrowserProverOptions): ProverPort {
  const mode = opts.mode ?? "auto";
  if (mode === "on-device") return new WasmProver();
  if (mode === "tee") return makeBrowserTeeProver(opts.tee.endpoint, opts.tee.measurement);
  const device = opts.device ?? detectDevice();
  return canProveOnDevice(device, opts.minCores, opts.minMemoryGB)
    ? new WasmProver()
    : makeBrowserTeeProver(opts.tee.endpoint, opts.tee.measurement);
}
