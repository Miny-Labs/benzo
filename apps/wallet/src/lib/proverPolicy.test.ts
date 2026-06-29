import { describe, it, expect, afterEach, vi } from "vitest";
import { preferDeviceProving, delegatedProverKind, apiProverKind, proverPlan, apiBoundaryProverPlan } from "./proverPolicy";

/** Stub navigator + matchMedia to simulate a given device, run fn, restore. */
function asDevice(
  opts: { ua?: string; cores?: number; mem?: number; coarse?: boolean; touch?: number },
  fn: () => void,
) {
  const nav = navigator as unknown as Record<string, unknown>;
  const orig = {
    ua: Object.getOwnPropertyDescriptor(nav, "userAgent"),
    cores: Object.getOwnPropertyDescriptor(nav, "hardwareConcurrency"),
    mem: Object.getOwnPropertyDescriptor(nav, "deviceMemory"),
    touch: Object.getOwnPropertyDescriptor(nav, "maxTouchPoints"),
    mm: window.matchMedia,
  };
  Object.defineProperty(nav, "userAgent", { configurable: true, value: opts.ua ?? "Mozilla/5.0 (Macintosh)" });
  Object.defineProperty(nav, "hardwareConcurrency", { configurable: true, value: opts.cores ?? 8 });
  Object.defineProperty(nav, "deviceMemory", { configurable: true, value: opts.mem ?? 8 });
  Object.defineProperty(nav, "maxTouchPoints", { configurable: true, value: opts.touch ?? 0 });
  window.matchMedia = ((q: string) => ({ matches: q.includes("coarse") ? !!opts.coarse : false })) as unknown as typeof window.matchMedia;
  try {
    fn();
  } finally {
    if (orig.ua) Object.defineProperty(nav, "userAgent", orig.ua);
    if (orig.cores) Object.defineProperty(nav, "hardwareConcurrency", orig.cores);
    if (orig.mem) Object.defineProperty(nav, "deviceMemory", orig.mem);
    if (orig.touch) Object.defineProperty(nav, "maxTouchPoints", orig.touch);
    window.matchMedia = orig.mm;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("proverPolicy - where the proof runs", () => {
  it("phone (mobile UA) NEVER proves on-device → delegates", () => {
    asDevice({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", coarse: true, touch: 5 }, () => {
      expect(preferDeviceProving()).toBe(false);
    });
  });

  it("Android phone delegates", () => {
    asDevice({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8)", coarse: true, touch: 5, cores: 8 }, () => {
      expect(preferDeviceProving()).toBe(false);
    });
  });

  it("touch-first device (coarse pointer + touch points) delegates even without a mobile UA", () => {
    asDevice({ ua: "Mozilla/5.0 (Macintosh)", coarse: true, touch: 10 }, () => {
      expect(preferDeviceProving()).toBe(false);
    });
  });

  it("weak desktop (few cores) delegates", () => {
    asDevice({ ua: "Mozilla/5.0 (Windows NT 10.0)", cores: 2, mem: 8 }, () => {
      expect(preferDeviceProving()).toBe(false);
    });
  });

  it("weak desktop (little RAM) delegates", () => {
    asDevice({ ua: "Mozilla/5.0 (Windows NT 10.0)", cores: 8, mem: 2 }, () => {
      expect(preferDeviceProving()).toBe(false);
    });
  });

  it("powerful desktop proves on-device", () => {
    asDevice({ ua: "Mozilla/5.0 (Macintosh)", cores: 10, mem: 16, coarse: false, touch: 0 }, () => {
      expect(preferDeviceProving()).toBe(true);
    });
  });

  it("delegate uses the attested enclave (TEE) from session or deployment config", () => {
    expect(delegatedProverKind(true)).toBe("tee");
    expect(delegatedProverKind(false)).toBe("tee");
  });

  it("API boundary converts browser-local plans to TEE", () => {
    expect(apiProverKind("local", true)).toBe("tee");
    expect(apiProverKind("local", false)).toBe("tee");
    expect(apiProverKind("tee", false)).toBe("tee");
  });

  it("API-bound UI copy says TEE when a desktop-local plan crosses the API boundary", () => {
    const plan = { onDevice: true, kind: "local" as const, reason: "Capable device - proving on-device, witness stays here" };
    const apiPlan = apiBoundaryProverPlan(plan, true);
    expect(apiPlan).toMatchObject({ onDevice: false, kind: "tee" });
    expect(apiPlan.reason).toContain("attested secure enclave");
  });

  it("proverPlan: phone + TEE wired → delegate to TEE", () => {
    asDevice({ ua: "Mozilla/5.0 (iPhone)", coarse: true, touch: 5 }, () => {
      const plan = proverPlan(true);
      expect(plan.onDevice).toBe(false);
      expect(plan.kind).toBe("tee");
    });
  });

  it("proverPlan: phone + deployment TEE → delegate to TEE", () => {
    asDevice({ ua: "Mozilla/5.0 (iPhone)", coarse: true, touch: 5 }, () => {
      const plan = proverPlan(false);
      expect(plan.onDevice).toBe(false);
      expect(plan.kind).toBe("tee");
    });
  });

  it("proverPlan: powerful desktop → on-device", () => {
    asDevice({ ua: "Mozilla/5.0 (Macintosh)", cores: 10, mem: 16 }, () => {
      const plan = proverPlan(true);
      expect(plan.onDevice).toBe(true);
    });
  });
});
