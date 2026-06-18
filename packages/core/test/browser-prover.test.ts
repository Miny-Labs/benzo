/**
 * Device-aware browser prover routing: a capable desktop proves on-device (WASM);
 * any mobile / no-WASM / under-powered device routes to the attested TEE.
 */
import { describe, it, expect } from "vitest";
import { canProveOnDevice, pickBrowserProver } from "../src/attestation-web.js";

const tee = { endpoint: "https://enclave.example", measurement: "0".repeat(64) };
const pick = (device: Parameters<typeof canProveOnDevice>[0]) =>
  pickBrowserProver({ mode: "auto", device, tee }).name;

describe("canProveOnDevice (capability gate)", () => {
  it("capable desktop → on-device", () => {
    expect(canProveOnDevice({ isMobile: false, cores: 8, memoryGB: 16, hasWasm: true })).toBe(true);
  });
  it("desktop with cores/mem unknown but not mobile → on-device (optimistic)", () => {
    expect(canProveOnDevice({ isMobile: false })).toBe(true);
  });
  it("any mobile → TEE", () => {
    expect(canProveOnDevice({ isMobile: true, cores: 8, memoryGB: 16 })).toBe(false);
  });
  it("WASM unsupported → TEE", () => {
    expect(canProveOnDevice({ isMobile: false, hasWasm: false, cores: 8 })).toBe(false);
  });
  it("too few cores → TEE", () => {
    expect(canProveOnDevice({ isMobile: false, cores: 2 })).toBe(false);
  });
  it("too little RAM → TEE", () => {
    expect(canProveOnDevice({ isMobile: false, cores: 8, memoryGB: 4 })).toBe(false);
  });
});

describe("pickBrowserProver", () => {
  it("auto: strong desktop → wasm", () => expect(pick({ isMobile: false, cores: 8, memoryGB: 16, hasWasm: true })).toBe("wasm"));
  it("auto: mobile → phala (TEE)", () => expect(pick({ isMobile: true })).toBe("phala"));
  it("auto: weak desktop → phala (TEE)", () => expect(pick({ isMobile: false, cores: 2 })).toBe("phala"));
  it("auto: no-WASM desktop → phala (TEE)", () => expect(pick({ isMobile: false, hasWasm: false })).toBe("phala"));
  it("mode tee always → phala", () => expect(pickBrowserProver({ mode: "tee", tee }).name).toBe("phala"));
  it("mode on-device always → wasm", () => expect(pickBrowserProver({ mode: "on-device", tee }).name).toBe("wasm"));
});
