/**
 * pickProver — Benzo's default is TEE-ONLY (all proving in the attested enclave;
 * no on-device path). The hybrid policy (on-device for capable devices) is kept
 * for environments that opt into it, and is tested explicitly here.
 */
import { describe, it, expect } from "vitest";
import { pickProver, isWeakDevice, HYBRID_POLICY, TEE_ONLY_POLICY, policyForMode } from "../src/router.js";

const desktop = { isMobile: false, memoryGB: 16, cores: 8 };
const phone = { isMobile: true, memoryGB: 3, cores: 4 };
const SMALL = 5 * 1024 * 1024;
const HUGE = 50 * 1024 * 1024;

describe("pickProver — TEE-only (default)", () => {
  it("routes everything to the delegated TEE, regardless of device or size", () => {
    expect(pickProver("shield", SMALL, desktop)).toBe("delegated");
    expect(pickProver("joinsplit", HUGE, desktop)).toBe("delegated");
    expect(pickProver("shield", SMALL, phone)).toBe("delegated");
    // explicit policy too
    expect(pickProver("shield", SMALL, desktop, TEE_ONLY_POLICY)).toBe("delegated");
  });
});

describe("pickProver — user choice (self / tee / auto)", () => {
  it("'tee' → always delegated; 'on-device' → always wasm; 'auto' → device-based", () => {
    // user picks TEE
    expect(pickProver("joinsplit", HUGE, desktop, policyForMode("tee"))).toBe("delegated");
    // user picks on-device (self) — even a heavy circuit on a phone stays local
    expect(pickProver("joinsplit", HUGE, phone, policyForMode("on-device"))).toBe("wasm");
    // auto: strong device local, weak device delegates heavy
    expect(pickProver("joinsplit", HUGE, desktop, policyForMode("auto"))).toBe("wasm");
    expect(pickProver("joinsplit", SMALL, phone, policyForMode("auto"))).toBe("delegated");
  });
});

describe("pickProver — hybrid (opt-in)", () => {
  it("strong device proves on-device", () => {
    expect(pickProver("joinsplit", HUGE, desktop, HYBRID_POLICY)).toBe("wasm");
    expect(pickProver("shield", SMALL, desktop, HYBRID_POLICY)).toBe("wasm");
  });
  it("weak device delegates heavy / oversized circuits, proves small ones locally", () => {
    expect(pickProver("joinsplit", SMALL, phone, HYBRID_POLICY)).toBe("delegated");
    expect(pickProver("some_big_circuit", HUGE, phone, HYBRID_POLICY)).toBe("delegated");
    expect(pickProver("shield", SMALL, phone, HYBRID_POLICY)).toBe("wasm");
  });
  it("classifies weak devices by mobile / memory / cores", () => {
    expect(isWeakDevice({ isMobile: true })).toBe(true);
    expect(isWeakDevice({ isMobile: false, memoryGB: 2 })).toBe(true);
    expect(isWeakDevice({ isMobile: false, cores: 2 })).toBe(true);
    expect(isWeakDevice({ isMobile: false, memoryGB: 16, cores: 8 })).toBe(false);
  });
});
